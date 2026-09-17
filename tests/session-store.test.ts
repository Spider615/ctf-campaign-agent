import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";
import { createD1Store, createMemoryStore, type TurnWrite } from "../app/lib/server/session-store.ts";

const NOW = "2026-09-16T08:00:00.000Z";

// 一条最小但完整的会话：一个版本加一条用户消息。D1 上这三样分别落在
// session、draft_version、message 三张表，删除要把它们一起清掉。
function newSession(id: string, title: string): TurnWrite {
  return {
    isNew: true,
    now: NOW,
    session: { id, title, entryMode: "new", status: "collecting", createdAt: NOW, updatedAt: NOW },
    version: { id: `${id}-v1`, seq: 1, draft: createEmptyDraft(`${id}-d1`, title), sheet: null, createdBy: "human", patch: null },
    messages: [{ id: `${id}-m1`, role: "user", content: { v: 2, kind: "user_text", text: title }, producedVersionId: `${id}-v1` }],
  };
}

type BoundStatement = {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => BoundStatement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
};

function fakeD1(input?: {
  session?: Record<string, unknown>;
  messages?: Array<Record<string, unknown>>;
  versions?: Array<Record<string, unknown>>;
}) {
  const batched: BoundStatement[][] = [];
  const db = {
    prepare(sql: string): BoundStatement {
      const statement: BoundStatement = {
        sql,
        args: [],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async first<T>() {
          return (input?.session ?? null) as T | null;
        },
        async all<T>() {
          if (sql.includes("FROM message")) return { results: (input?.messages ?? []) as T[] };
          if (sql.includes("FROM draft_version")) return { results: (input?.versions ?? []) as T[] };
          return { results: [] as T[] };
        },
      };
      return statement;
    },
    async batch(statements: BoundStatement[]) {
      batched.push(statements);
      return [];
    },
  };
  return { db: db as unknown as D1Database, batched };
}

test("remove deletes one session and leaves the others alone", async () => {
  const store = createMemoryStore();
  await store.commit(newSession("a", "活动甲"));
  await store.commit(newSession("b", "活动乙"));
  assert.equal((await store.list()).length, 2);

  await store.remove("a");

  assert.equal(await store.load("a"), null, "删掉的会话读不出来");
  assert.deepEqual((await store.list()).map((item) => item.id), ["b"], "列表里只剩另一条");
  // 同一张表里放着别人的数据，删除必须按 session_id 精确圈定，不能连坐。
  const kept = await store.load("b");
  assert.equal(kept?.messages.length, 1, "另一条会话的消息还在");
  assert.equal(kept?.versions.length, 1, "另一条会话的版本还在");
});

test("removing a session that is not there is not an error", async () => {
  const store = createMemoryStore();
  await store.commit(newSession("a", "活动甲"));

  // DELETE 的语义是幂等的：删不存在的、或者重复删，都只是没有东西可删，不是错误。
  // 界面上双击删除按钮、或者两个标签页同时删同一条，都会走到这里。
  await store.remove("nope");
  assert.equal((await store.list()).length, 1, "删不存在的 id 不影响现有会话");

  await store.remove("a");
  await store.remove("a");
  assert.equal((await store.list()).length, 0);
});

test("message occurrence time is stored independently from commit time", async () => {
  const store = createMemoryStore();
  const write = newSession("timed", "带时间的活动");
  write.messages[0].createdAt = "2026-09-16T07:59:57.000Z";

  await store.commit(write);

  assert.equal((await store.load("timed"))?.messages[0].createdAt, "2026-09-16T07:59:57.000Z");
});

test("legacy ics1811 versions are normalized to a stable campaign parent when written", async () => {
  const store = createMemoryStore();
  const write = newSession("legacy", "钻石九折");
  const legacyDraft = write.version?.draft;

  await store.commit(write);

  const loaded = await store.load("legacy");
  assert.equal(loaded?.legacy, false);
  assert.equal(loaded?.versions[0].draft.schema, "campaign/v1");
  assert.equal(loaded?.versions[0].draft.id, "campaign:legacy-d1");
  assert.deepEqual(loaded?.versions[0].draft.ics1811, legacyDraft);
});

test("D1 adapts every legacy and current version independently in a mixed history", async () => {
  const legacy = createEmptyDraft("legacy-child", "钻石类打9折");
  const current = createCampaignDraft("campaign-current", "策划会员私域活动");
  const { db } = fakeD1({
    session: {
      id: "mixed",
      title: "混合版本",
      entry_mode: "new",
      status: "collecting",
      created_at: NOW,
      updated_at: NOW,
    },
    versions: [
      { id: "v1", seq: 1, brief_json: JSON.stringify(legacy), ics_orders_json: "null", created_by: "ai", created_at: NOW },
      { id: "v2", seq: 2, brief_json: JSON.stringify(current), ics_orders_json: "null", created_by: "human", created_at: NOW },
    ],
  });

  const loaded = await createD1Store(db).load("mixed");

  assert.equal(loaded?.legacy, false, "新旧版本混存不能让整条会话变成 legacy");
  assert.deepEqual(loaded?.versions.map((version) => version.draft.schema), ["campaign/v1", "campaign/v1"]);
  assert.equal(loaded?.versions[0].draft.id, "campaign:legacy-child");
  assert.deepEqual(loaded?.versions[0].draft.ics1811, legacy);
  assert.deepEqual(loaded?.versions[1].draft, current);
});

test("D1 writes a normalized campaign document into the existing brief_json column", async () => {
  const { db, batched } = fakeD1();

  await createD1Store(db).commit(newSession("persisted", "钻石九折"));

  const insert = batched[0].find((statement) => statement.sql.includes("INSERT INTO draft_version"));
  assert.ok(insert, "应写入现有 draft_version 表");
  const persisted = JSON.parse(String(insert.args[3]));
  assert.equal(persisted.schema, "campaign/v1");
  assert.equal(persisted.id, "campaign:persisted-d1");
  assert.equal(persisted.ics1811.schema, "ics1811/v1");
});
