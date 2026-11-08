import assert from "node:assert/strict";
import test from "node:test";
import { focusContext, focusContextItems, focusOf, locateAnswer, parseSelection, selectionLabel, selectionSearch } from "../app/lib/insight/context.ts";
import { fakeGraph, fakeComparisonGraph } from "./helpers/insight-fixture.ts";
import { isDatabaseExplainRequest } from "../app/lib/analytics/database.ts";
import { validateConversationRequest } from "../app/lib/attachments/answer.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { attachmentReferences } from "../app/lib/client/attachments.ts";
import { mergeConversationTimeline } from "../app/lib/client/history-conversation.ts";

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

for (const selection of [null, { kind: "node", id: "sales" }, { kind: "edge", from: "orders", to: "sales" }] as const) {
  test(`比较图${selection?.kind ?? "整图"}的完整上下文通过数据库请求守卫`, () => {
    const focus = focusOf(fakeComparisonGraph(), selection)!;
    const context = focusContextItems(focus);
    assert.equal(context.join(""), focusContext(focus), "基准、日期和限制全部保留，未截断");
    assert.ok(context.every((part) => part.length <= 500));
    const request = { mode: "database", question: "为什么有这些变化？", history: [], context };
    assert.equal(isDatabaseExplainRequest(request), true, "跳转首问必须能通过真实数据库请求守卫");
  });
  test(`比较图${selection?.kind ?? "整图"}的完整上下文通过附件请求守卫`, () => {
    const focus = focusOf(fakeComparisonGraph(), selection)!;
    const context = focusContextItems(focus);
    assert.equal(context.join(""), focusContext(focus));
    assert.doesNotThrow(() => validateConversationRequest({ conversationId: "22222222-2222-4222-8222-222222222222", question: "结合文件解释变化", history: [], context, attachmentIds: ["11111111-1111-4111-8111-111111111111"] }));
  });
}

test("洞察上下文分片保留重复内容，不拆开 UTF-16 代理对，旧短上下文保持原文", () => {
  const focus = { kind: "node", id: "sales", label: "🧧".repeat(600), comparison: "同".repeat(2500) } as const;
  const parts = focusContextItems(focus);
  assert.equal(parts.join(""), focusContext(focus));
  assert.ok(parts.filter((part) => part === "同".repeat(500)).length >= 2, "相同片段也必须保留顺序与次数");
  for (const part of parts) {
    assert.ok(part.length <= 500);
    assert.doesNotMatch(part, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
  const short = { kind: "node", id: "sales", label: "销售额" } as const;
  assert.deepEqual(focusContextItems(short), [focusContext(short)]);
});

test("页面真实首问组装动作保留重复洞察分片，并在两种请求里守住200项上限", () => {
  // 执行真实 analyze 动作；路由组件无法在 strip-types 中直接加载，只替换发送边界。
  const source = ts.createSourceFile("history-conversation.tsx", readFileSync("app/components/analytics/history-conversation.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "analyze") initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(initializer);
  const focus = focusOf(fakeComparisonGraph(), null)!;
  focus.comparison += "同".repeat(2500);
  const parts = focusContextItems(focus);
  const requests: Array<{ context: string[]; attachmentIds?: string[] }> = [];
  const action = runInNewContext(ts.transpileModule(`(${initializer.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    crypto, analysisTurns: { has: () => false }, executionLock: { current: false }, conversationId: "22222222-2222-4222-8222-222222222222", messages: [],
    mergeConversationTimeline, attachmentReferences, focusContextItems, insightFocus: focus, followBottom: { current: false }, setMessages() {},
    historyConversation: { context: () => Array.from({ length: 200 }, (_, i) => `原有历史要求 ${i}`) }, perform: (request: typeof requests[number]) => { requests.push(request); },
  });
  action("请解释这些变化");
  action("请结合附件解释变化", undefined, [{ id: "11111111-1111-4111-8111-111111111111" }]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.context.length, 200);
    assert.deepEqual(Array.from(request.context.slice(-parts.length)), parts, "历史可淘汰，洞察分片不可被Set去重或裁掉");
    if (request.attachmentIds) assert.doesNotThrow(() => validateConversationRequest(request));
    else assert.equal(isDatabaseExplainRequest(request), true);
  }
});
