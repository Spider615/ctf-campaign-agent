import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanelContext } from "../app/components/workspace/workspace-panel-context.ts";
import { loadReactComponent } from "./helpers/react-component.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";
import { resolveAnalysisVisualization } from "../app/lib/analytics/visualization.ts";
import type { VisualizationSpec } from "../app/lib/analytics/visualization-types.ts";
import type { ConversationAnswer } from "../app/lib/attachments/types.ts";

const spec: VisualizationSpec = { id: "chart", revision: 1, kind: "bar", renderer: "html", afterBlockIndex: 1, source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store" }, selection: { mode: "all" } };
const provider = (child: ReturnType<typeof createElement>) => createElement(WorkspacePanelContext.Provider, { value: { panelId: "panel", activeId: null, togglePanel() {}, closePanel() {}, dismissPanel() {} } }, child);

test("图表卡片提供隔离 HTML、原生图、可读数据表与展开和出处入口", async (t) => {
  const { VisualizationCard } = await loadReactComponent(t, "app/components/analytics/visualization-card.tsx");
  const chart = resolveAnalysisVisualization(spec, simulatedAnswer().evidence);
  const html = renderToStaticMarkup(provider(createElement(VisualizationCard, { chart })));
  assert.match(html, /sandbox=""/); assert.match(html, /script-src/); assert.match(html, /connect-src/);
  for (const label of ["图表", "HTML", "查看数据", "展开", "来源"]) assert.ok(html.includes(label), label);
  assert.match(html, /select-text/); assert.doesNotMatch(html, /allow-scripts|allow-same-origin/);
});

test("最终回答按原始段落位置插图，后续段落和复制文本保留", async (t) => {
  const { AnalysisAnswerView } = await loadReactComponent(t, "app/components/analytics/analysis-answer.tsx");
  const answer = simulatedAnswer(); answer.visualizations = { schema: "analysis-visualization/v1", items: [spec] };
  answer.blocks.push({ kind: "paragraph", nodes: [{ kind: "text", text: "后续正文仍可阅读。" }] });
  const html = renderToStaticMarkup(provider(createElement(AnalysisAnswerView, { answer })));
  assert.ok(html.indexOf("data-visualization-card") > html.indexOf("先核对源口径"));
  assert.ok(html.indexOf("data-visualization-card") < html.indexOf("后续正文仍可阅读"));
});

test("停止后的阶段图保留未完成标识，不能冒充已完成回答", async (t) => {
  const { VisualizationCard } = await loadReactComponent(t, "app/components/analytics/visualization-card.tsx");
  const chart = resolveAnalysisVisualization({ ...spec, renderer: "native" }, simulatedAnswer().evidence);
  const html = renderToStaticMarkup(provider(createElement(VisualizationCard, { chart, status: "incomplete" })));
  assert.match(html, /本次分析未完成/); assert.match(html, /1234\.56/);
});

test("文件来源尚未确认时，展开和来源入口都不能展示旧图表数据", async (t) => {
  const { VisualizationCard } = await loadReactComponent(t, "app/components/analytics/visualization-card.tsx");
  const chart = resolveAnalysisVisualization(spec, simulatedAnswer().evidence);
  const html = renderToStaticMarkup(provider(createElement(VisualizationCard, { chart, conversationId: "conversation", files: [{ id: "file", version: "version" }] })));
  assert.match(html, /正在确认图表来源/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>来源<\/button>/);
  assert.doesNotMatch(html, /<iframe|<svg/);
});

test("混合回答不会因单一经营来源自动插入全部图，只有明确位置的图进入正文", async (t) => {
  const { FileAnswer } = await loadReactComponent(t, "app/components/attachments/file-answer.tsx");
  const database = simulatedAnswer(); database.visualizations = { schema: "analysis-visualization/v1", items: [{ ...spec, renderer: "native" }, { ...spec, id: "another-chart", renderer: "native" }] };
  const answer: ConversationAnswer = { schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "先核对资料的业务范围。", sourceIds: ["s1"] }, { text: "金额比较见本段附图。", sourceIds: ["s1"] }], limitations: [], sources: [{ id: "s1", attachmentId: "11111111-1111-4111-8111-111111111111", version: "a".repeat(64), name: "历史经营", location: "金额", kind: "database", databaseRunId: database.task.runId, databaseFactId: "amount", excerpt: "销售额1234.56元" }], databaseAnswers: [database] };
  const without = renderToStaticMarkup(provider(createElement(FileAnswer, { answer, conversationId: "conversation" })));
  assert.doesNotMatch(without, /data-visualization-card/);
  answer.visualizations = { schema: "analysis-visualization/v1", items: [{ ...spec, renderer: "native", afterBlockIndex: 1 }] };
  const withChart = renderToStaticMarkup(provider(createElement(FileAnswer, { answer, conversationId: "conversation" })));
  assert.equal((withChart.match(/data-visualization-card/g) ?? []).length, 1);
  assert.ok(withChart.indexOf("data-visualization-card") > withChart.indexOf("金额比较见本段附图"));
});
