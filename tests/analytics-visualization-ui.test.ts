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

test("图表卡片只有标题和一张图，数据表和详情收进标题栏的图标按钮", async (t) => {
  const { VisualizationCard } = await loadReactComponent(t, "app/components/analytics/visualization-card.tsx");
  const chart = resolveAnalysisVisualization(spec, simulatedAnswer().evidence);
  const html = renderToStaticMarkup(provider(createElement(VisualizationCard, { chart })));
  for (const label of ["aria-label=\"查看数据\"", "aria-label=\"展开详情\""]) assert.ok(html.includes(label), label);
  const visible = html.replace(/<desc>[\s\S]*?<\/desc>|<title>[\s\S]*?<\/title>/g, "");
  assert.doesNotMatch(visible, /<iframe|图表显示方式|>HTML<|选择图中数据|原表数值|单位：/); assert.match(html, /<svg[^>]*role="img"/); assert.match(html, /select-text/);
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

test("停止文件分析后可直接重试原问题，进行中的其他回答会禁用重试", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const message = { id: "cancelled", role: "assistant", text: "已停止本次回答，你可以继续追问。", status: "cancelled", createdAt: "2026-10-17T00:00:00Z", request: { conversationId: "22222222-2222-4222-8222-222222222222", question: "分析这份文件", attachmentIds: ["11111111-1111-4111-8111-111111111111"], history: [] } };
  const idle = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message, busy: false, onRetry() {} })));
  assert.match(idle, /重试本次回答/);
  const busy = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message, busy: true, onRetry() {} })));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>重试本次回答<\/button>/);
});

test("文件来源尚未确认时，展开和来源入口都不能展示旧图表数据", async (t) => {
  const { VisualizationCard } = await loadReactComponent(t, "app/components/analytics/visualization-card.tsx");
  const chart = resolveAnalysisVisualization(spec, simulatedAnswer().evidence);
  const html = renderToStaticMarkup(provider(createElement(VisualizationCard, { chart, conversationId: "conversation", files: [{ id: "file", version: "version" }] })));
  assert.match(html, /正在加载图表/);
  assert.match(html, /<button(?=[^>]*aria-label="展开详情")(?=[^>]*disabled="")[^>]*>/);
  assert.doesNotMatch(html, /<iframe|role="img"/);
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

test("文件回答正文不挂引用编号，口径说明和数据依据默认收起", async (t) => {
  const { FileAnswer } = await loadReactComponent(t, "app/components/attachments/file-answer.tsx");
  const source = { id: "s1", attachmentId: "11111111-1111-4111-8111-111111111111", version: "a".repeat(64), name: "活动.xlsx", location: "活动汇总 · 求和", kind: "table" as const, excerpt: "贡献：300" };
  const answer: ConversationAnswer = { schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "**结论**：定价精选最赚钱。", sourceIds: ["s1"] }, { text: "### 关键发现\n- **定价精选贡献最高**：300元", sourceIds: ["s1"] }], limitations: ["归属销售不等于增量。"], sources: [source] };
  const html = renderToStaticMarkup(provider(createElement(FileAnswer, { answer, conversationId: "conversation" })));
  assert.match(html, /<strong[^>]*>结论<\/strong>/); assert.match(html, /<h3[^>]*><span>关键发现<\/span><\/h3>/);
  assert.doesNotMatch(html, />\[1\]<\/a>/); assert.match(html, /<summary[^>]*>口径说明<\/summary>/); assert.match(html, /数据依据（1 条）/);
  assert.ok(html.indexOf("口径说明") > html.indexOf("关键发现"));
});
