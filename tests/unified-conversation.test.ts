import assert from "node:assert/strict";
import test from "node:test";
import * as routing from "../app/lib/analytics/intent.ts";
import * as storage from "../app/lib/client/history-conversation.ts";

test("统一入口按当前任务处理，历史建议和优惠字样不自动创建活动", () => {
  assert.equal(typeof routing.conversationRoute, "function");
  for (const text of ["你好", "25年8月销售额是多少？", "复盘历史黄金每克减20元的活动", "不要创建活动，先分析历史效果", "不要启动活动，只查数据", "我计划做一场活动，先帮我评估风险", "先分析活动效果，再创建活动"]) assert.equal(routing.conversationRoute(text), "analysis", text);
  for (const text of ["帮我创建一个国庆活动，指定门店黄金每克减20元", "我想做一场新品活动", "按这个执行"]) assert.equal(routing.conversationRoute(text), "execution", text);
  assert.equal(routing.conversationRoute("优惠改成每克减30元", true), "execution");
  assert.equal(routing.conversationRoute("查历史同店销售额", true), "analysis");
  assert.equal(routing.conversationRoute("这档优惠有什么风险和优化建议", true), "analysis");
  assert.equal(routing.conversationRoute("生成传播方案", true), "execution");
  for (const text of ["请执行刚才的活动方案", "帮我执行这个活动", "启动这场活动"]) assert.equal(routing.conversationRoute(text), "execution", text);
  for (const text of ["只看华北门店", "那8月份呢？", "按新老会员拆开", "为什么？"]) assert.equal(routing.conversationRoute(text, true, true), "analysis", text);
  for (const text of ["把查询范围改为2025年8月", "查询范围改成华北门店", "只看华北门店，时间改为8月份"]) assert.equal(routing.conversationRoute(text, true, true), "analysis", text);
  assert.equal(routing.conversationRoute("把活动时间改为10月1日", true, true), "execution");
});

test("分析后的点头不会采纳旧活动提议，活动自身的点头仍留在原执行流程", () => {
  assert.equal(typeof routing.conversationRoute, "function");
  assert.equal(routing.conversationRoute("好的", true, true), "analysis");
  assert.equal(routing.conversationRoute("同意", true, true), "analysis");
  for (const text of ["对", "ok", "就这么定", "按你说的"]) assert.equal(routing.conversationRoute(text, true, true), "analysis", text);
  assert.equal(routing.conversationRoute("好的", true, false), "execution");
  assert.equal(routing.conversationRoute("你好", true, false), "analysis");
});

test("新建对话保留旧记录、隔离筛选与活动，切走后仍在跑的回答写回原对话", () => {
  assert.equal(typeof storage.createHistoryConversationStore, "function");
  const values = new Map<string, string>();
  const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = storage.createHistoryConversationStore(persistence);
  const original = store.activeId();
  store.update(() => [{ id: "user", role: "user", text: "只看华北门店", createdAt: "2026-10-13T00:00:00Z" }], original);
  assert.equal(store.bindCampaign("campaign-test", "创建一场活动", original), true);
  const next = store.newConversation(); assert.notEqual(next, original);
  assert.deepEqual(store.snapshot(), []); assert.deepEqual(store.context(), []); assert.equal(store.campaignId(), null);
  store.update((items) => [...items, { id: "late", role: "assistant", text: "旧回答", createdAt: "2026-10-13T00:01:00Z" }], original);
  assert.deepEqual(store.snapshot(), []); assert.equal(store.bindCampaign("late-campaign", "迟到活动", original), false);
  assert.equal(store.selectConversation(original), true); assert.equal(store.campaignId(), "campaign-test");
  assert.deepEqual(store.snapshot().map((message) => message.text), ["只看华北门店", "旧回答"]); assert.deepEqual(store.context(), ["只看华北门店"]);
  const restored = storage.createHistoryConversationStore(persistence); assert.equal(restored.activeId(), original); assert.equal(restored.campaignId(), "campaign-test");
  assert.deepEqual(restored.context(), ["只看华北门店"]);
});

test("分析消息按实际活动消息锚点插入，跨进程时钟偏差不改变对话顺序", () => {
  assert.equal(typeof storage.mergeConversationTimeline, "function");
  const timeline = storage.mergeConversationTimeline([{ id: "campaign-1" }, { id: "campaign-2" }], [{ id: "analysis-before" }, { id: "analysis-between", afterMessageId: "campaign-1" }, { id: "analysis-after", afterMessageId: "campaign-2" }]);
  assert.deepEqual(timeline.map((item) => item.message.id), ["analysis-before", "campaign-1", "analysis-between", "campaign-2", "analysis-after"]);
});

test("切换对话不结束另一条对话里进行中的回答", () => {
  const values = new Map<string, string>();
  const store = storage.createHistoryConversationStore({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const first = store.activeId();
  store.update(() => [{ id: "q", role: "user", text: "8月销售额", createdAt: "2026-10-13T00:00:00Z" }, { id: "a", role: "assistant", text: "", status: "running", createdAt: "2026-10-13T00:00:00Z" }], first);
  const second = store.newConversation();
  store.update((items) => items.map((message) => message.id === "a" ? { ...message, status: "done", text: "8月销售额 100 万" } : message), first);
  assert.equal(store.activeId(), second); assert.deepEqual(store.snapshot(), []);
  assert.equal(store.selectConversation(first), true);
  assert.deepEqual(store.snapshot().map((message) => [message.status, message.text]), [[undefined, "8月销售额"], ["done", "8月销售额 100 万"]]);
  // 刷新页面才算真的断开：未完成的回答在恢复时标为已结束。
  store.update((items) => items.map((message) => message.id === "a" ? { ...message, status: "running" } : message), first);
  assert.equal(storage.createHistoryConversationStore({ getItem: (key: string) => values.get(key) ?? null, setItem: () => {} }).snapshot().at(-1)?.status, "cancelled");
});

test("删除对话：从列表和存储中移除；删的是当前对话时切到最近一条，删光后留一条空对话", () => {
  const values = new Map<string, string>();
  const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = storage.createHistoryConversationStore(persistence);
  const first = store.activeId();
  store.update(() => [{ id: "q1", role: "user", text: "第一条", createdAt: "2026-10-13T00:00:00Z" }], first);
  const second = store.newConversation();
  store.update(() => [{ id: "q2", role: "user", text: "第二条", createdAt: "2026-10-13T00:01:00Z" }], second);
  assert.equal(store.deleteConversation("不存在"), false);
  // 删别的对话：当前对话不变。
  assert.equal(store.deleteConversation(first), true);
  assert.equal(store.activeId(), second);
  assert.deepEqual(store.threadsSnapshot().map((thread) => thread.title), ["第二条"]);
  // 删当前对话且没有其他对话：留一条空的新对话，列表为空。
  assert.equal(store.deleteConversation(second), true);
  assert.notEqual(store.activeId(), second);
  assert.deepEqual(store.snapshot(), []); assert.deepEqual(store.threadsSnapshot(), []);
  // 刷新后仍然是删过的状态。
  assert.deepEqual(storage.createHistoryConversationStore(persistence).threadsSnapshot(), []);
});

test("删除当前对话时切到剩下的最近一条", () => {
  const values = new Map<string, string>();
  const store = storage.createHistoryConversationStore({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const ids = [store.activeId()];
  store.update(() => [{ id: "a", role: "user", text: "甲", createdAt: "2026-10-13T00:00:00Z" }], ids[0]);
  for (const text of ["乙", "丙"]) { const id = store.newConversation(); ids.push(id); store.update(() => [{ id: text, role: "user", text, createdAt: "2026-10-13T00:00:00Z" }], id); }
  assert.equal(store.selectConversation(ids[2]), true);
  assert.equal(store.deleteConversation(ids[2]), true);
  assert.equal(store.activeId(), ids[1]);
  assert.deepEqual(store.snapshot().map((message) => message.text), ["乙"]);
});

test("未读提醒：不在当前对话里的回答结束（完成或失败）时标未读，打开后清除，刷新后保留", () => {
  const values = new Map<string, string>();
  const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = storage.createHistoryConversationStore(persistence);
  const first = store.activeId();
  store.update(() => [{ id: "q", role: "user", text: "8月销售额", createdAt: "2026-10-13T00:00:00Z" }, { id: "a", role: "assistant", text: "", status: "running", createdAt: "2026-10-13T00:00:00Z" }], first);
  const unread = () => Object.fromEntries(store.threadsSnapshot().map((thread) => [thread.id, Boolean(thread.unread)]));
  // 当前对话里的回答结束：用户正看着，不标。
  store.update((items) => items.map((message) => message.id === "a" ? { ...message, status: "done", text: "100 万" } : message), first);
  assert.equal(unread()[first], false);
  // 切走后，原对话里新的回答结束：标未读。
  store.update((items) => [...items, { id: "a2", role: "assistant", text: "", status: "running", createdAt: "2026-10-13T00:02:00Z" }], first);
  const second = store.newConversation();
  store.update((items) => items.map((message) => message.id === "a2" ? { ...message, status: "failed", text: "失败" } : message), first);
  assert.equal(unread()[first], true);
  // 进度更新（还在跑）不标。
  store.update(() => [{ id: "q2", role: "user", text: "第二条", createdAt: "2026-10-13T00:03:00Z" }, { id: "b", role: "assistant", text: "", status: "running", createdAt: "2026-10-13T00:03:00Z" }], second);
  store.selectConversation(first);
  store.update((items) => items.map((message) => message.id === "b" ? { ...message, phase: "writing" as const } : message), second);
  assert.equal(unread()[second], false);
  // 打开即清除；刷新后保持。
  assert.equal(unread()[first], false);
  store.update((items) => items.map((message) => message.id === "b" ? { ...message, status: "done", text: "好了" } : message), second);
  assert.equal(storage.createHistoryConversationStore(persistence).threadsSnapshot().find((thread) => thread.id === second)?.unread, true);
});

test("未读提醒：其他来源的回复（活动对话）可以直接标记，当前对话不标", () => {
  const values = new Map<string, string>();
  const store = storage.createHistoryConversationStore({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const first = store.activeId();
  store.update(() => [{ id: "q", role: "user", text: "建一个活动", createdAt: "2026-10-13T00:00:00Z" }], first);
  store.markUnread(first);
  assert.equal(store.threadsSnapshot()[0].unread, undefined);
  store.newConversation(); store.markUnread(first);
  assert.equal(store.threadsSnapshot().find((thread) => thread.id === first)?.unread, true);
  store.selectConversation(first); assert.equal(store.bindCampaign("camp-1", "建一个活动", first), true);
  store.newConversation(); store.markCampaignUnread("camp-1"); store.markCampaignUnread("不存在");
  assert.equal(store.threadsSnapshot().find((thread) => thread.id === first)?.unread, true);
});

test("从洞察带来的「正在看」跟着对话存：刷新后还在，换对话不带过去，移除后不再恢复", () => {
  const values = new Map<string, string>();
  const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = storage.createHistoryConversationStore(persistence);
  const focus = { kind: "edge" as const, from: "mix" as const, to: "gm" as const, label: "货品结构 → 毛利率", basis: "计价金占比解释 79.7%" };
  store.setFocus(focus);
  store.update((items) => [...items, { id: "u1", role: "user", text: "这个是怎么影响的", createdAt: "2026-10-21T00:00:00.000Z" }]);
  assert.deepEqual(storage.createHistoryConversationStore(persistence).focus(), focus);
  store.newConversation(); assert.equal(store.focus(), null);
  store.selectConversation(storage.createHistoryConversationStore(persistence).threadsSnapshot().at(-1)!.id);
  assert.deepEqual(store.focus(), focus);
  store.setFocus(null); assert.equal(storage.createHistoryConversationStore(persistence).focus(), null);
  // 存储里结构不完整的 focus 丢掉，不影响对话本身。
  const saved = JSON.parse(values.get("ctf:conversations:v2")!); saved.threads[0].focus = { kind: "edge", label: "坏的" };
  values.set("ctf:conversations:v2", JSON.stringify(saved));
  const broken = storage.createHistoryConversationStore(persistence); broken.selectConversation(saved.threads[0].id);
  assert.equal(broken.focus(), null); assert.equal(broken.snapshot().length, 1);
});
