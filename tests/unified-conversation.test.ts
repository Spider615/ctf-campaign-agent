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

test("新建对话保留旧记录、隔离筛选与活动，迟到回调不能写进新对话", () => {
  assert.equal(typeof storage.createHistoryConversationStore, "function");
  const values = new Map<string, string>();
  const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = storage.createHistoryConversationStore(persistence);
  const original = store.activeId();
  store.update(() => [{ id: "user", role: "user", text: "只看华北门店", createdAt: "2026-10-13T00:00:00Z" }], original);
  assert.equal(store.bindCampaign("campaign-test", "创建一场活动", original), true);
  const next = store.newConversation(); assert.notEqual(next, original);
  assert.deepEqual(store.snapshot(), []); assert.deepEqual(store.context(), []); assert.equal(store.campaignId(), null);
  store.update(() => [{ id: "late", role: "assistant", text: "旧回答", createdAt: "2026-10-13T00:01:00Z" }], original);
  assert.deepEqual(store.snapshot(), []); assert.equal(store.bindCampaign("late-campaign", "迟到活动", original), false);
  assert.equal(store.selectConversation(original), true); assert.equal(store.campaignId(), "campaign-test");
  assert.equal(store.snapshot()[0].text, "只看华北门店"); assert.deepEqual(store.context(), ["只看华北门店"]);
  const restored = storage.createHistoryConversationStore(persistence); assert.equal(restored.activeId(), original); assert.equal(restored.campaignId(), "campaign-test");
  assert.deepEqual(restored.context(), ["只看华北门店"]);
});

test("分析消息按实际活动消息锚点插入，跨进程时钟偏差不改变对话顺序", () => {
  assert.equal(typeof storage.mergeConversationTimeline, "function");
  const timeline = storage.mergeConversationTimeline([{ id: "campaign-1" }, { id: "campaign-2" }], [{ id: "analysis-before" }, { id: "analysis-between", afterMessageId: "campaign-1" }, { id: "analysis-after", afterMessageId: "campaign-2" }]);
  assert.deepEqual(timeline.map((item) => item.message.id), ["analysis-before", "campaign-1", "analysis-between", "campaign-2", "analysis-after"]);
});
