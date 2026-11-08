import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAnalyticsStore } from "../app/lib/server/analytics-store.ts";
import { analyticsAccess } from "../app/lib/server/analytics-access.ts";
import { parseConversationScope, parseConversationWrite } from "../app/lib/server/conversation-threads.ts";
import { createHistoryConversationStore, type RemoteThreads } from "../app/lib/client/history-conversation.ts";

function store() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  const db = { prepare(sql: string) {
    let args: Array<string | number | null> = [];
    return { bind(...values: Array<string | number | null>) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
    };
  } } as unknown as D1Database;
  return { api: createAnalyticsStore(db), sqlite };
}
const thread = (id: string, text: string, updatedAt = "2026-10-24T00:00:00.000Z") => ({ id, title: text, messages: [{ id: `${id}-q`, role: "user" as const, text, createdAt: updatedAt }], context: [text], campaignId: null, updatedAt });

test("对话记录按访问标识隔离，覆盖写不改顺序、不跨范围", async () => {
  const { api, sqlite } = store();
  try {
    await api.saveConversation("owner-a", "analysis", "t1", thread("t1", "第一条"), "2026-10-24T00:00:00.000Z");
    await api.saveConversation("owner-a", "analysis", "t2", thread("t2", "第二条"), "2026-10-24T00:01:00.000Z");
    await api.saveConversation("owner-a", "analysis", "t1", thread("t1", "第一条改了", "2026-10-24T00:02:00.000Z"), "2026-10-24T00:02:00.000Z");
    assert.deepEqual((await api.listConversations("owner-a", "analysis") as Array<{ title: string }>).map((t) => t.title), ["第一条改了", "第二条"]);
    assert.deepEqual(await api.listConversations("owner-b", "analysis"), []);
    assert.deepEqual(await api.listConversations("owner-a", "campaign-files:s1"), []);
    // 同一标识已在别的范围：不改写。
    await api.saveConversation("owner-a", "campaign-files:s1", "t1", thread("t1", "串范围"), "2026-10-24T00:03:00.000Z");
    assert.equal((await api.listConversations("owner-a", "analysis") as Array<{ title: string }>)[0].title, "第一条改了");
    await api.deleteConversation("owner-b", "t1");
    assert.equal((await api.listConversations("owner-a", "analysis")).length, 2);
    await api.deleteConversation("owner-a", "t1"); await api.deleteConversation("owner-a", "t1");
    assert.deepEqual((await api.listConversations("owner-a", "analysis") as Array<{ id: string }>).map((t) => t.id), ["t2"]);
  } finally { sqlite.close(); }
});

test("写入请求核对范围、标识和外层结构", () => {
  assert.equal(parseConversationScope("campaign-files:abc-1"), "campaign-files:abc-1");
  assert.throws(() => parseConversationScope("other"), /范围/);
  assert.throws(() => parseConversationWrite("t1", { scope: "analysis", thread: thread("t2", "x") }), /不一致/);
  assert.throws(() => parseConversationWrite("t1", { scope: "analysis", thread: { ...thread("t1", "x"), messages: Array(41).fill({}) } }), /消息/);
  assert.equal(parseConversationWrite("t1", { scope: "analysis", thread: thread("t1", "x") }).scope, "analysis");
});

function fakeRemote(initial: unknown[] = []) {
  const saved = new Map<string, unknown>(initial.map((t) => [(t as { id: string }).id, t]));
  const calls: string[] = [];
  const remote: RemoteThreads = {
    async list() { calls.push("list"); return [...saved.values()]; },
    async save(t) { calls.push(`save:${t.id}`); saved.set(t.id, JSON.parse(JSON.stringify(t))); },
    async remove(id) { calls.push(`remove:${id}`); saved.delete(id); },
  };
  return { remote, saved, calls };
}
const memory = () => { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("POC 共享空间合并旧浏览器记录，同编号取最新副本并可继续保存和删除", async () => {
  const { api, sqlite } = store();
  try {
    await api.saveConversation("owner-a", "analysis", "t1", thread("t1", "旧内容"), "2026-10-24T00:00:00.000Z");
    await api.saveConversation("owner-b", "analysis", "t1", thread("t1", "新内容"), "2026-10-24T00:01:00.000Z");
    await api.saveConversation("owner-b", "analysis", "t2", thread("t2", "另一条"), "2026-10-24T00:02:00.000Z");
    await api.saveConversation("owner-a", "campaign-files:s1", "files", thread("files", "活动文件"), "2026-10-24T00:00:00.000Z");
    const shared = analyticsAccess(new Request("http://localhost/api")).owner;
    assert.deepEqual((await api.listConversations(shared, "analysis") as Array<{ title: string }>).map((item) => item.title), ["新内容", "另一条"]);
    const updated = thread("t1", "继续提问", "2026-10-24T00:03:00.000Z");
    await api.saveConversation(shared, "analysis", "t1", updated, updated.updatedAt);
    assert.deepEqual((await api.listConversations(shared, "analysis") as Array<{ title: string }>).map((item) => item.title), ["继续提问", "另一条"]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversation_thread WHERE id = 't1'").get()?.count, 2, "保存沿用原行，不添加第三份副本");
    await api.saveConversation(shared, "campaign-files:s1", "t1", thread("t1", "错误范围"), "2026-10-24T00:04:00.000Z");
    assert.deepEqual((await api.listConversations(shared, "campaign-files:s1") as Array<{ title: string }>).map((item) => item.title), ["活动文件"]);
    await api.deleteConversation(shared, "t1");
    await api.deleteConversation(shared, "t1");
    assert.deepEqual((await api.listConversations(shared, "analysis") as Array<{ id: string }>).map((item) => item.id), ["t2"]);
    await api.saveConversation(shared, "analysis", "t1", updated, updated.updatedAt);
    assert.deepEqual((await api.listConversations(shared, "analysis") as Array<{ id: string }>).map((item) => item.id), ["t2"], "另一浏览器迟到的写入不能复活已删除对话");
    await api.deleteConversation(shared, "inflight");
    await api.saveConversation(shared, "analysis", "inflight", thread("inflight", "迟到的首次保存"), "2026-10-24T00:05:00.000Z");
    assert.deepEqual((await api.listConversations(shared, "analysis") as Array<{ id: string }>).map((item) => item.id), ["t2"]);
    assert.deepEqual(new Set(await api.listDeletedConversations(shared, "analysis")), new Set(["t1", "inflight"]));
  } finally { sqlite.close(); }
});

test("共享空间收到服务端删除标记时移除旧缓存，刷新后不会重新补写", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = memory();
  cache.setItem("ctf:conversations:v2", JSON.stringify({ activeId: "t1", threads: [thread("t1", "另一浏览器已删除")] }));
  const { remote, calls } = fakeRemote([{ id: "t1", deleted: true }]);
  const reopened = createHistoryConversationStore(cache, remote);
  reopened.activeId(); await tick(); await tick();
  assert.deepEqual(reopened.threadsSnapshot(), []);
  assert.notEqual(reopened.activeId(), "t1");
  t.mock.timers.tick(1000); await tick(); await tick();
  assert.deepEqual(calls, ["list"]);
  reopened.update(() => thread("new", "开启新对话").messages);
  await reopened.retrySave();
  assert.deepEqual(reopened.snapshot().map((message) => message.text), ["开启新对话"]);
});

test("POC 两个独立浏览器缓存从同一服务端空间读取和继续对话", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, sqlite } = store();
  try {
    const remote = (cookie?: string): RemoteThreads => {
      const owner = analyticsAccess(new Request("http://localhost/api", { headers: cookie ? { cookie } : {} })).owner;
      return {
        list: async () => [...await api.listConversations(owner, "analysis"), ...(await api.listDeletedConversations(owner, "analysis")).map((id) => ({ id, deleted: true }))],
        save: (value) => api.saveConversation(owner, "analysis", value.id, value, value.updatedAt),
        remove: (id) => api.deleteConversation(owner, id),
      };
    };
    const first = createHistoryConversationStore(memory(), remote("ctf_analytics_owner=11111111-1111-4111-8111-111111111111"));
    const conversationId = first.activeId(); await tick(); await tick();
    first.update(() => thread("q1", "分析七夕表现").messages, conversationId);
    await first.retrySave();
    const secondCache = memory();
    const second = createHistoryConversationStore(secondCache, remote());
    second.activeId(); await tick(); await tick();
    assert.equal(second.activeId(), conversationId);
    assert.equal(second.snapshot()[0].text, "分析七夕表现");
    second.update((messages) => [...messages, ...thread("q2", "继续看门店差异").messages]);
    await second.retrySave();
    const reopened = createHistoryConversationStore(memory(), remote("ctf_analytics_owner=22222222-2222-4222-8222-222222222222"));
    reopened.activeId(); await tick(); await tick();
    assert.deepEqual(reopened.snapshot().map((message) => message.text), ["分析七夕表现", "继续看门店差异"]);
    await api.deleteConversation(analyticsAccess(new Request("http://localhost/api")).owner, conversationId);
    const refreshed = createHistoryConversationStore(secondCache, remote());
    refreshed.activeId(); await tick(); await tick();
    assert.deepEqual(refreshed.threadsSnapshot(), []);
    await refreshed.retrySave();
    assert.deepEqual(await api.listConversations(analyticsAccess(new Request("http://localhost/api")).owner, "analysis"), []);
  } finally { sqlite.close(); }
});

test("浏览器存储清空后从服务端读回对话，进行中的回答标为已结束", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = { ...thread("t1", "8月销售额"), messages: [...thread("t1", "8月销售额").messages, { id: "a", role: "assistant", text: "", status: "running", createdAt: "2026-10-24T00:00:00.000Z" }] };
  const { remote, calls } = fakeRemote([old]);
  const store = createHistoryConversationStore(memory(), remote);
  store.activeId(); await tick(); await tick();
  assert.deepEqual(store.threadsSnapshot().map((x) => x.title), ["8月销售额"]);
  assert.equal(store.activeId(), "t1");
  assert.equal(store.snapshot().at(-1)?.status, "cancelled");
  assert.deepEqual(calls, ["list"]);
});

test("改动合并后写回服务端，删除的对话不会被迟到的写回复活", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { remote, saved, calls } = fakeRemote();
  const store = createHistoryConversationStore(memory(), remote);
  const id = store.activeId(); await tick();
  store.update(() => [{ id: "q", role: "user", text: "华北门店", createdAt: "2026-10-24T00:00:00Z" }], id);
  store.update((items) => [...items, { id: "a", role: "assistant", text: "部分", status: "running", createdAt: "2026-10-24T00:00:00Z" }], id);
  assert.equal(saved.size, 0, "空对话和合并窗口内都不写");
  t.mock.timers.tick(1000); await tick(); await tick();
  assert.deepEqual(calls.filter((c) => c.startsWith("save")), [`save:${id}`]);
  assert.equal((saved.get(id) as { messages: unknown[] }).messages.length, 2);
  // 删除前还有没写完的改动：删掉后不再写。
  store.update((items) => items.map((m) => m.id === "a" ? { ...m, status: "done", text: "完整" } : m), id);
  store.deleteConversation(id); await tick(); await tick();
  t.mock.timers.tick(1000); await tick(); await tick();
  assert.equal(saved.has(id), false);
  assert.equal(calls.filter((c) => c === `save:${id}`).length, 1);
});

test("迁移：浏览器里已有、服务端没有的对话补写上去", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const local = memory();
  const before = createHistoryConversationStore(local); const id = before.activeId();
  before.update(() => [{ id: "q", role: "user", text: "旧对话", createdAt: "2026-10-24T00:00:00Z" }], id);
  const { remote, saved } = fakeRemote([thread("server", "服务端已有")]);
  const store = createHistoryConversationStore(local, remote);
  store.activeId(); await tick(); await tick();
  assert.deepEqual(store.threadsSnapshot().map((x) => x.title).sort(), ["旧对话", "服务端已有"].sort());
  t.mock.timers.tick(0); await tick(); await tick();
  assert.equal((saved.get(id) as { title: string }).title, "旧对话");
});
