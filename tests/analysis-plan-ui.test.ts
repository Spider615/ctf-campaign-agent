import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanelContext } from "../app/components/workspace/workspace-panel-context.ts";
import { createHistoryConversationStore } from "../app/lib/client/history-conversation.ts";
import type { PlanAnswer, PlanAnswerClaim } from "../app/lib/analytics/analysis-v2-types.ts";
import { storedV2Answer } from "./helpers/analysis-v2-answer.ts";
import { simulatedPlanAnswer } from "./helpers/plan-answer.ts";
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

test("口径和分析步骤在出处面板里，步骤默认折叠", async (t) => {
  const answer = { ...simulatedPlanAnswer(), assumptions: ["同店口径待确认"], definitions: ["销售额按正金额汇总"], plan: [{ id: "n1", op: "measure", status: "completed", summary: "汇总二月销售额" }, { id: "n2", op: "scan", status: "unsupported", summary: "逐组扫描（缺少维度）" }] };
  const html = await renderPanel(t, answer);
  assert.match(html, /口径[\s\S]*同店口径待确认[\s\S]*销售额按正金额汇总/);
  assert.match(html, /<details[\s\S]*分析步骤<\/summary>[\s\S]*汇总二月销售额[\s\S]*逐组扫描（缺少维度）/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/); assert.match(html, /未能完成/);
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
