import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanelContext } from "../app/components/workspace/workspace-panel-context.ts";
import { createHistoryConversationStore } from "../app/lib/client/history-conversation.ts";
import type { PlanAnswer, PlanAnswerClaim, PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";
import { storedV2Answer } from "./helpers/analysis-v2-answer.ts";
import { simulatedPlanAnswer, simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";
import { loadReactComponent } from "./helpers/react-component.ts";

const provider = (child: ReturnType<typeof createElement>) => createElement(WorkspacePanelContext.Provider, { value: { panelId: "panel", activeId: null, togglePanel() {}, closePanel() {}, dismissPanel() {} } }, child);
const claim = (text: string, confidence: PlanAnswerClaim["confidence"] = "unchecked"): PlanAnswerClaim => ({ text, factIds: ["amount"], confidence });
async function renderPanel(t: { after(fn: () => void): void }, answer: PlanAnswer) {
  const { SourcePanel } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  return renderToStaticMarkup(provider(createElement(SourcePanel, { answer, factIds: [] })));
}
async function render(t: { after(fn: () => void): void }, answer: PlanAnswer) {
  const { PlanAnswerView } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  return renderToStaticMarkup(provider(createElement(PlanAnswerView, { answer })));
}

test("主结论加粗；只有方向翻转时提示需谨慎，稳健与未检查都不打标签", async (t) => {
  const kept = await render(t, { ...simulatedPlanAnswer(), headline: claim("甲店领先", "kept") });
  assert.match(kept, /data-plan-headline[^>]*font-semibold[^>]*>甲店领先/); assert.doesNotMatch(kept, /稳健|需谨慎/);
  const flipped = await render(t, { ...simulatedPlanAnswer(), headline: claim("甲店领先", "flipped") });
  assert.match(flipped, /需谨慎/); assert.match(flipped, /amber/);
  const unchecked = await render(t, { ...simulatedPlanAnswer(), headline: claim("甲店领先") });
  assert.doesNotMatch(unchecked, /稳健|需谨慎/);
});

test("没有 headline 时说明没有可直接采用的结论，并列出不能下的结论", async (t) => {
  const html = await render(t, { ...simulatedPlanAnswer(), status: "unavailable", headline: undefined, cannotConclude: ["缺少对照期数据"] });
  assert.match(html, /这次没有得出可以直接采用的结论/); assert.match(html, /不能下的结论/); assert.match(html, /缺少对照期数据/);
});

test("主要发现最多 5 条，出处是文字后的小号上标数字", async (t) => {
  const claims = Array.from({ length: 8 }, (_, index) => claim(`要点${index + 1}`, index === 0 ? "flipped" : "kept"));
  const html = await render(t, { ...simulatedPlanAnswer(), claims });
  assert.equal((html.match(/data-plan-claim=/g) ?? []).length, 5);
  assert.match(html, /主要发现/); assert.match(html, /要点5/); assert.doesNotMatch(html, /要点6/);
  for (const attribute of ["aria-label=\"查看数据出处2\"", "aria-controls=\"panel\"", "aria-expanded=\"false\""]) assert.ok(html.includes(attribute), attribute);
  assert.match(html, /<sup[^>]*><button[^>]*>\[2\]<\/button><\/sup>/); assert.doesNotMatch(html, />出处</);
});

test("无图时不渲染图表容器，有图时渲染图表卡片", async (t) => {
  const plain = simulatedPlanAnswer();
  assert.doesNotMatch(await render(t, plain), /data-visualization-card/);
  const chart = { id: "c", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, title: "各店销售额", unit: "元", scope: "二月", definition: "销售额", limitations: [], selectionLabel: "全部", categories: [{ key: "a", label: "甲店" }], series: [{ key: "amount", label: "销售额", values: [{ value: 1234.56, exact: "1234.56", refIds: ["amount"] }] }], sourceIds: [], factIds: ["amount"], objectIds: [] } as unknown as NonNullable<PlanAnswer["chart"]>;
  assert.match(await render(t, { ...plain, chart }), /data-visualization-card/);
});

test("正文只有结论、关键数据、发现、图、建议和不能下的结论；复核提示和补充信息不进正文", async (t) => {
  const bare = await render(t, { ...simulatedPlanAnswer(), actions: [], cannotConclude: [], questions: [], assumptions: [], definitions: [], plan: [], review: { notes: [] } });
  assert.doesNotMatch(bare, /建议|不能下的结论/);
  const html = await render(t, { ...simulatedPlanAnswer(), actions: ["先核对甲店"], review: { notes: ["样本偏少"] }, questions: ["要看哪个月？"], assumptions: ["同店口径待确认"], plan: [{ id: "n1", op: "measure", status: "completed", summary: "汇总二月销售额" }] });
  assert.match(html, /建议[\s\S]*先核对甲店/);
  assert.doesNotMatch(html, /复核提示|样本偏少|需要你补充的业务信息|要看哪个月|口径待确认|同店口径待确认|分析步骤|汇总二月销售额/);
});

test("口径和分析步骤收进「给分析师看」，默认折叠；有待确认口径时业务版单独提醒", async (t) => {
  const answer = { ...simulatedPlanAnswer(), assumptions: ["同店口径待确认"], definitions: ["销售额按正金额汇总"], plan: [{ id: "n1", op: "measure", status: "completed", summary: "汇总二月销售额" }, { id: "n2", op: "scan", status: "unsupported", summary: "逐组扫描（缺少维度）" }] };
  const html = await renderPanel(t, answer);
  const fold = html.indexOf("给分析师看");
  assert.ok(fold > 0);
  assert.match(html.slice(0, fold), /有 1 处口径还没和业务确认/);
  assert.match(html.slice(fold), /口径[\s\S]*同店口径待确认[\s\S]*销售额按正金额汇总/);
  assert.match(html.slice(fold), /分析步骤[\s\S]*汇总二月销售额[\s\S]*逐组扫描（缺少维度）/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/); assert.match(html, /未能完成/);
});

test("业务版出处：对比的数字摊成两组各多少、差多少，范围名只写两组不同的部分", async (t) => {
  const base = simulatedPlanAnswerV4();
  const frame = base.evidence.frames[0];
  const weekend = { ...frame, id: "fw", scope: { ...frame.scope, period: { start: "2025-08-01", end: "2025-08-31" }, filters: { dayTypes: ["周六", "周日"] } } };
  const workday = { ...frame, id: "fd", scope: { ...frame.scope, period: { start: "2025-08-01", end: "2025-08-31" }, filters: { dayTypes: ["工作日"] } } };
  const f = (id: string, frameId: string, metricId: string, label: string, value: number, unit: string, extra = {}) => ({ id, frameId, metricId, label, value, unit, definition: label, objectIds: [], operationId: "operation", limitations: [], comparisonKey: "p1", ...extra });
  const evidence = { ...base.evidence, frames: [weekend, workday], facts: [
    f("t", "fw", "amount_per_order", "目标 · 单均实收", 8594, "元"),
    f("r", "fd", "amount_per_order", "参照 · 单均实收", 8730, "元"),
    f("d", "fw", "amount_per_order.delta", "单均实收差额", -136, "元", { derivation: { op: "subtract", args: [{ factId: "t" }, { factId: "r" }] } }),
    f("c", "fw", "amount_per_order.relative_change", "单均实收相对变化", -1.56, "%", { derivation: { op: "multiply", args: [{ constant: 100 }, { op: "divide", args: [{ factId: "d" }, { factId: "r" }] }] } }),
  ] };
  const { SourcePanel } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  const html = renderToStaticMarkup(provider(createElement(SourcePanel, { answer: { ...base, evidence }, factIds: ["c"] })));
  const plain = html.slice(0, html.indexOf("给分析师看"));
  assert.match(plain, /周六、周日比工作日，单均实收少 1\.56%/);
  assert.match(plain, /周六、周日[\s\S]*8,594(?:\.00)?元[\s\S]*工作日[\s\S]*8,730(?:\.00)?元[\s\S]*差多少[\s\S]*-136(?:\.00)?元/);
  assert.match(plain, /数据来自[\s\S]*2025年8月/);
  // 技术说法不在业务版里。
  assert.doesNotMatch(plain, /口径|核对 [\d,]+ 条|两段时间或两组对象/);
});

test("关键数据表：对比给目标、参照和变化，负变化标红", async (t) => {
  const html = await render(t, { ...simulatedPlanAnswer(), figures: { targetLabel: "七夕节", referenceLabel: "非节庆", rows: [{ label: "日均实收", target: "4.6亿元", reference: "2.3亿元", change: "+103.00%", factIds: [] }, { label: "单均实收", target: "9,700元", reference: "9,800元", change: "-1.00%", factIds: [] }] } });
  assert.match(html, /data-plan-section="figures"/); assert.match(html, /七夕节[\s\S]*非节庆[\s\S]*变化/);
  assert.match(html, /日均实收[\s\S]*\+103\.00%/); assert.match(html, /text-\[#b4543a\][^>]*>-1\.00%/);
});

test("回答文字一律按文本节点输出，脚本标签被转义", async (t) => {
  const html = await render(t, { ...simulatedPlanAnswer(), headline: claim("<script>alert(1)</script>"), claims: [claim("<img src=x onerror=alert(1)>")], actions: ["<b>粗</b>"] });
  assert.doesNotMatch(html, /<script|<img|<b>/); assert.match(html, /&lt;script&gt;/);
});

test("出处面板：给 factIds 只列相关事实，不给就列全部", async (t) => {
  const { AnalysisSourceData } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  const answer = simulatedPlanAnswer();
  const prior = { ...answer.evidence.facts[0], id: "other", label: "无关指标", value: 7 };
  const evidence = { ...answer.evidence, facts: [...answer.evidence.facts, prior] };
  const scoped = renderToStaticMarkup(createElement(AnalysisSourceData, { evidence, factIds: ["amount"] }));
  assert.match(scoped, /1,234\.56元/); assert.doesNotMatch(scoped, /无关指标/);
  const all = renderToStaticMarkup(createElement(AnalysisSourceData, { evidence }));
  assert.match(all, /无关指标/);
  // 变化类事实在面板里带正负号，和结论正文一致；普通指标不带。
  const change = { ...answer.evidence.facts[0], id: "growth", metricId: "amount.relative_change", label: "销售额环比变化", value: 100, unit: "%" };
  const signed = renderToStaticMarkup(createElement(AnalysisSourceData, { evidence: { ...answer.evidence, facts: [...answer.evidence.facts, change] } }));
  assert.match(signed, /\+100\.00%/); assert.match(signed, /1,234\.56元/); assert.doesNotMatch(signed, /\+1,234\.56/);
});

test("恢复会话：v2 旧答案只保留文本，v3 答案重新核验后保留", () => {
  const store = new Map<string, string>();
  const legacy = storedV2Answer(); const plan = simulatedPlanAnswer();
  const message = (id: string, answer: unknown, text: string) => ({ id, role: "assistant", text, createdAt: "2026-10-18T00:00:00Z", status: "done", answer });
  store.set("ctf:conversations:v2", JSON.stringify({ activeId: "t", threads: [{ id: "t", title: "x", updatedAt: "2026-10-18T00:00:00Z", campaignId: null, context: [], messages: [message("old", legacy, "旧版正文"), message("new", plan, "")] }] }));
  const conversation = createHistoryConversationStore({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } });
  const [old, fresh] = conversation.snapshot();
  assert.equal(old.answer, undefined); assert.equal(old.text, "旧版正文"); assert.equal(old.status, "done");
  assert.ok(fresh.answer && "schema" in fresh.answer && fresh.answer.schema === "analysis-answer/v3");
});

test("恢复会话：headline 引用了不存在的事实，答案被丢弃并提示重新分析", () => {
  const store = new Map<string, string>();
  const bad = simulatedPlanAnswer(); bad.headline = { text: "甲店领先", factIds: ["missing"], confidence: "kept" };
  store.set("ctf:conversations:v2", JSON.stringify({ activeId: "t", threads: [{ id: "t", title: "x", updatedAt: "2026-10-18T00:00:00Z", campaignId: null, context: [], messages: [{ id: "bad", role: "assistant", text: "", createdAt: "2026-10-18T00:00:00Z", status: "done", answer: bad }] }] }));
  const conversation = createHistoryConversationStore({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } });
  const [restored] = conversation.snapshot();
  assert.equal(restored.answer, undefined); assert.equal(restored.status, "failed"); assert.equal(restored.text, "上次回答未通过完整性核验，请重新分析。");
});

test("恢复后的 v2 旧消息在页面上只显示文本", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: { id: "old", role: "assistant", text: "旧版正文", createdAt: "2026-10-18T00:00:00Z", status: "done" }, busy: false, onRetry() {} })));
  assert.match(html, /旧版正文/); assert.doesNotMatch(html, /data-plan-answer|data-analysis-body/);
});

test("历史消息用 PlanAnswerView 渲染 v3 答案", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const answer = { ...simulatedPlanAnswer(), headline: claim("甲店领先", "kept") };
  const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: { id: "m", role: "assistant", text: "", createdAt: "2026-10-18T00:00:00Z", status: "done", answer }, busy: false, onRetry() {} })));
  assert.match(html, /data-plan-answer/); assert.match(html, /甲店领先/);
});

test("主结论带重点数字时放在答案最上面单独放大，句子紧跟在下面", async (t) => {
  const base = simulatedPlanAnswer(); const factId = base.evidence.facts[0].id;
  const html = await render(t, { ...base, headline: { text: "8月有成交的活动共442个", factIds: [factId], confidence: "kept", keyFigure: { value: "442个", factId } } });
  const figure = html.indexOf("data-plan-key-figure"); const sentence = html.indexOf("data-plan-headline");
  assert.ok(figure >= 0 && figure < sentence, "重点数字在主结论句子之前");
  assert.match(html, /data-plan-key-figure[^>]*text-\[32px\][^>]*>442个</);
  const plain = await render(t, { ...base, headline: { text: "甲店领先", factIds: [factId], confidence: "kept" } });
  assert.doesNotMatch(plain, /data-plan-key-figure/);
});

async function renderV4(t: { after(fn: () => void): void }, answer: PlanAnswerV4) {
  const { PlanAnswerV4View } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  return renderToStaticMarkup(provider(createElement(PlanAnswerV4View, { answer })));
}
const v4Chart = { id: "c", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, title: "各店销售额", unit: "元", scope: "二月", definition: "销售额", limitations: [], selectionLabel: "全部", categories: [{ key: "a", label: "甲店" }], series: [{ key: "amount", label: "销售额", values: [{ value: 1234.56, exact: "1234.56", refIds: ["amount"] }] }], sourceIds: [], factIds: ["amount"], objectIds: [] } as unknown as Extract<PlanAnswerV4["body"][number], { kind: "chart" }>["chart"];

test("v4：重点数字放大在最前，正文数字是带出处的按钮，表格和图按块顺序出现", async (t) => {
  const base = simulatedPlanAnswerV4();
  const text = "### 二月 1,234.56元\n- 甲店 **1,234.56元**，乙店 1,234.56元";
  const at = (from: number) => { const start = text.indexOf("1,234.56元", from); return { start, end: start + 9, factIds: ["amount"] }; };
  const r1 = at(0); const r2 = at(r1.end); const r3 = at(r2.end);
  const answer: PlanAnswerV4 = { ...base, body: [
    { kind: "markdown", text, refs: [r1, r2, r3] },
    { kind: "table", title: "各门店的销售额", columns: ["门店", "销售额"], rows: [{ cells: ["甲店", "1,234.56元"], factIds: ["amount"] }] },
    { kind: "markdown", text: "后记一段。", refs: [] },
    { kind: "chart", chart: v4Chart },
  ] };
  const html = await renderV4(t, answer);
  const figure = html.indexOf("data-plan-key-figure"); const firstBlock = html.indexOf("data-plan-block");
  assert.ok(figure >= 0 && figure < firstBlock, "重点数字在正文之前");
  assert.match(html, /data-plan-key-figure[^>]*text-\[32px\][^>]*>1,234\.56元</);
  const buttons = html.match(/<button[^>]*data-plan-ref[^>]*>[^<]*<\/button>/g) ?? [];
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.match(button, />1,234\.56元<\/button>$/); assert.match(button, /aria-label="查看 1,234\.56元 的出处"/);
    assert.match(button, /font-semibold/); assert.match(button, /tabular-nums/); assert.match(button, /underline/); assert.match(button, /aria-controls="panel"/);
  }
  assert.match(html, /<h3[^>]*><span><span>二月 <\/span><button[^>]*data-plan-ref/); assert.match(html, /<li[^>]*>.*<strong[^>]*><button[^>]*data-plan-ref/);
  const table = html.indexOf('data-plan-block="table"'); const after = html.indexOf("后记一段"); const chart = html.indexOf("data-visualization-card");
  assert.ok(firstBlock < table && table < after && after < chart, "块按顺序渲染");
  assert.match(html, /各门店的销售额[\s\S]*<table/);
  assert.doesNotMatch(html, /主要发现|>建议<|暂时不能下的结论/);
});

test("v4：没有重点数字时不渲染放大区，HTML 按文字转义", async (t) => {
  const base = simulatedPlanAnswerV4();
  const html = await renderV4(t, { ...base, keyFigure: undefined, body: [{ kind: "markdown", text: "<script>alert(1)</script><img src=x onerror=alert(1)>", refs: [] }] });
  assert.doesNotMatch(html, /data-plan-key-figure/); assert.doesNotMatch(html, /<script|<img/); assert.match(html, /&lt;script&gt;/);
});

test("v4：出处面板保留口径和分析步骤", async (t) => {
  const answer = { ...simulatedPlanAnswerV4(), assumptions: ["同店口径待确认"], plan: [{ id: "n1", op: "measure", status: "completed", summary: "汇总二月销售额" }] };
  const { SourcePanel } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  const html = renderToStaticMarkup(provider(createElement(SourcePanel, { answer, factIds: ["amount"] })));
  assert.match(html, /口径[\s\S]*同店口径待确认/); assert.match(html, /分析步骤[\s\S]*汇总二月销售额/); assert.match(html, /1,234\.56元/);
});

test("历史消息和报告按 schema 选组件：v4 用 PlanAnswerV4View", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: { id: "m", role: "assistant", text: "", createdAt: "2026-10-19T00:00:00Z", status: "done", answer: simulatedPlanAnswerV4() }, busy: false, onRetry() {} })));
  assert.match(html, /data-plan-answer-version="v4"/); assert.match(html, /data-plan-ref/);
  const v3 = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: { id: "m", role: "assistant", text: "", createdAt: "2026-10-19T00:00:00Z", status: "done", answer: simulatedPlanAnswer() }, busy: false, onRetry() {} })));
  assert.match(v3, /data-plan-answer/); assert.doesNotMatch(v3, /data-plan-answer-version/);
});

test("恢复会话：v4 答案重新核验后保留，复制文本走 planAnswerV4Text", () => {
  const store = new Map<string, string>();
  store.set("ctf:conversations:v2", JSON.stringify({ activeId: "t", threads: [{ id: "t", title: "x", updatedAt: "2026-10-19T00:00:00Z", campaignId: null, context: [], messages: [{ id: "v4", role: "assistant", text: "", createdAt: "2026-10-19T00:00:00Z", status: "done", answer: simulatedPlanAnswerV4() }] }] }));
  const conversation = createHistoryConversationStore({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } });
  const [restored] = conversation.snapshot();
  assert.ok(restored.answer && "schema" in restored.answer && restored.answer.schema === "analysis-answer/v4");
  assert.equal(restored.text, "二月销售额 1,234.56元，先核对门店口径。");
});
