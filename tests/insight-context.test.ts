import assert from "node:assert/strict";
import test from "node:test";
import { focusContext, focusOf, locateAnswer, parseSelection, selectionLabel, selectionSearch } from "../app/lib/insight/context.ts";
import { fakeGraph, fakeComparisonGraph } from "./helpers/insight-fixture.ts";

test("URL 参数互相还原，不认识的节点整条丢掉", () => {
  for (const s of [{ kind: "node", id: "image" }, { kind: "edge", from: "promo", to: "mix" }, { kind: "source", source: "inferred" }] as const) assert.deepEqual(parseSelection(selectionSearch(s)), s);
  assert.equal(parseSelection("node=nope"), null);
  assert.equal(parseSelection("edge=promo>nope"), null);
  assert.equal(parseSelection(""), null);
  assert.equal(selectionSearch(null), "");
});

test("问答上下文写清在看哪个节点或哪条线；来源筛选不带过去", () => {
  const g = fakeGraph();
  assert.equal(focusOf(g, { kind: "source", source: "field" }), null);
  const edge = focusOf(g, { kind: "edge", from: "promo", to: "mix" })!;
  assert.match(focusContext(edge), /连线「活动和力度 → 货品结构」（图上依据：同一家店，有活动成交的那天/);
  // 页面上的结论和 AI 建议也带过去，问到建议时先查数据。
  assert.match(focusContext(edge), /页面上的结论是「有活动成交的那天，卖的计价金更多/);
  assert.match(focusContext(edge), /这是建议不是数据：用户问到建议或「该怎么做」时，要先查数据/);
  assert.match(focusContext(focusOf(g, { kind: "node", id: "region" })!), /选中了节点「大区 \/ 区域」.*没有明确改变时沿用/);
  assert.equal(selectionLabel(g, null), "整张图");
});

test("问答用到的语义层维度定位到图上的节点", () => {
  assert.equal(locateAnswer(["store", "imageLevel"]), "image");
  assert.equal(locateAnswer(["offer"]), "promo");
  assert.equal(locateAnswer(["store", "day"]), null);
});

test("问答上下文的指代说明能进到计划复核", async () => {
  const { planReviewPrompt } = await import("../app/lib/analytics/plan/prompt.ts");
  const context = focusContext(focusOf(fakeGraph(), { kind: "node", id: "region" })!);
  assert.match(planReviewPrompt("你帮我分析一下这个因素", "{}", undefined, [context]), /原问题里的指代按这里理解[\s\S]*大区 \/ 区域/);
});

test("选了范围时问答上下文写明范围，全月照旧", async () => {
  const { fakeGraphIn } = await import("./helpers/insight-fixture.ts");
  const qixi = focusOf(fakeGraphIn({ from: "20250823", to: "20250829" }), { kind: "node", id: "region" })!;
  assert.equal(qixi.period, "七夕 8/23–8/29");
  assert.match(focusContext(qixi), /七夕 8\/23–8\/29 全国/);
  assert.doesNotMatch(focusContext(qixi), /2025 年 8 月/);
  const full = focusOf(fakeGraph(), { kind: "node", id: "region" })!;
  assert.equal(full.period, undefined);
  assert.match(focusContext(full), /2025 年 8 月全国/);
});

test("比较模式整图跳智能问答保留比较目标、同批本期和对照、覆盖及限制", () => {
  const graph = fakeComparisonGraph();
  for (const selection of [null, { kind: "node", id: "sales" }, { kind: "source", source: "derived" }, { kind: "node", id: "qixi" }] as const) {
    const focus = focusOf(graph, selection);
    assert.ok(focus, "即使没有选中节点也必须保留范围比较目标");
    const context = focusContext(focus);
    assert.match(context, /七夕相对可比平日的变化/);
    assert.match(context, /可比样本本期[\s\S]*对照/);
    assert.match(context, /同一家店[\s\S]*星期/);
    assert.match(context, /20250801/);
    assert.match(context, /840[\s\S]*门店日/);
    assert.match(context, /无法单独拆出七夕净效果/);
    assert.match(context, /不是完整客户历史/);
  }
});

test("整图比较上下文随对话保存并在刷新后恢复", async () => {
  const { createHistoryConversationStore } = await import("../app/lib/client/history-conversation.ts");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const focus = focusOf(fakeComparisonGraph(), null)!;
  const store = createHistoryConversationStore(storage);
  store.setFocus(focus);
  store.update(() => [{ id: "q", role: "user", text: "哪些变化值得关注？", createdAt: "2026-11-08T00:00:00Z" }]);
  const restored = createHistoryConversationStore(storage);
  assert.deepEqual(restored.focus(), focus);
  assert.match(focusContext(restored.focus()!), /可比样本本期[\s\S]*对照[\s\S]*无法单独拆出七夕净效果/);
});
