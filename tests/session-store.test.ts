import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { createMemoryStore, type TurnWrite } from "../app/lib/server/session-store.ts";

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
