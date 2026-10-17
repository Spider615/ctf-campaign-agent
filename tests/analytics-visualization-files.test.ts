import assert from "node:assert/strict";
import test from "node:test";
import { createAttachmentTools } from "../agent/attachments/tools.ts";
import type { AttachmentStore } from "../agent/attachments/store.ts";
import { resolveAttachmentVisualization, visualizationText } from "../app/lib/analytics/visualization.ts";
import { validateConversationAnswer, conversationAnswerText } from "../app/lib/attachments/answer.ts";
import { createConversationRunner } from "../agent/attachments/run-turn.ts";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentQuery } from "../agent/run-turn.ts";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import { visualizationHtml, visualizationSvg } from "../app/lib/analytics/visualization-html.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";

const attachmentId = "11111111-1111-4111-8111-111111111111";
const scope = { owner: attachmentId, conversationId: "22222222-2222-4222-8222-222222222222" };
function files(captureCalculations = true) {
  const summary = { id: attachmentId, version: "a".repeat(64), name: "虚构销售.csv" };
  const document = { tables: [{ id: "table", name: "销售", columns: ["门店", "销售金额（元）"], rows: Array.from({ length: 60 }, (_, index) => [`门店${index}`, String(index + 1)]), rowNumbers: Array.from({ length: 60 }, (_, i) => i + 2), location: "销售表", warnings: [] }], blocks: [], images: [] };
  const store = { document: async () => ({ summary, document }) } as unknown as AttachmentStore;
  return createAttachmentTools(store, scope, [attachmentId], { captureCalculations });
}

test("真实文件计算按全表登记图表数据，已读第一页不改变全表前列", async () => {
  const tools = files(); const page = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "销售金额（元）", groupBy: ["门店"], limit: 1 });
  assert.ok(page.calculationId); assert.ok("groups" in page); assert.equal(page.groups.length, 1);
  const { calculations, sources } = tools.visualizationEvidence(); assert.equal(calculations[0].groups.length, 60);
  const spec = { id: "file-chart", revision: 1, kind: "bar" as const, renderer: "html" as const, afterBlockIndex: 0, source: { kind: "attachment" as const, calculationIds: [page.calculationId!] }, selection: { mode: "top" as const, limit: 5 } };
  const chart = resolveAttachmentVisualization(spec, calculations, sources);
  assert.equal(chart.categories[0].label, "门店59"); assert.equal(chart.series[0].values[0].exact, "60");
  const answer = validateConversationAnswer({ schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "首组金额为1元，完整比较见图。", sourceIds: [page.groups![0].sourceId] }], limitations: [], sources, calculations, visualizations: { schema: "analysis-visualization/v1", items: [spec] } });
  assert.equal(answer.visualizations?.items.length, 1); assert.match(conversationAnswerText(answer), /门店59/);
  const fabricated = structuredClone(answer); fabricated.calculations![0].id = "invented";
  assert.throws(() => validateConversationAnswer(fabricated), /图表|计算|引用/);
});

test("无图表能力时文件计算继续使用原来源合同", async () => {
  const tools = files(false); const page = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "销售金额（元）", groupBy: ["门店"], limit: 1 });
  assert.equal(tools.sources().filter((source) => source.calculationId).length, 0);
  assert.ok("groups" in page);
  const plain = validateConversationAnswer({ schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "金额1元。", sourceIds: [page.groups![0].sourceId] }], limitations: [], sources: tools.sources() });
  assert.equal(plain.visualizations, undefined);
});

test("文件日期趋势补齐实际首尾之间的空点，跨年过长范围不静默抽点", async () => {
  const summary = { id: attachmentId, version: "a".repeat(64), name: "虚构日期.csv" };
  const table = { id: "table", columns: ["日期", "金额（元）"], rows: [["2025-08-04", "20"], ["2025-08-01", "10"]], rowNumbers: [2, 3], location: "日期表", warnings: [] };
  const store = { document: async () => ({ summary, document: { tables: [table], blocks: [], images: [] } }) } as unknown as AttachmentStore;
  const tools = createAttachmentTools(store, scope, [attachmentId], { captureCalculations: true });
  const page = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "金额（元）", groupBy: ["日期"] });
  const { calculations, sources } = tools.visualizationEvidence();
  const spec = { id: "dates", revision: 1, kind: "line" as const, renderer: "native" as const, afterBlockIndex: 0, source: { kind: "attachment" as const, calculationIds: [page.calculationId!] }, selection: { mode: "all" as const } };
  const chart = resolveAttachmentVisualization(spec, calculations, sources);
  assert.deepEqual(chart.categories.map((item) => item.key), ["2025-08-01", "2025-08-02", "2025-08-03", "2025-08-04"]);
  assert.deepEqual(chart.series[0].values.map((item) => item.exact), ["10", null, null, "20"]);
  assert.ok(!visualizationSvg(chart).match(/<path[^>]*d="[^"]*L/), "空日期之间不画连续趋势线");
  const tooLong = structuredClone(calculations); tooLong[0].groups[0].labels[0] = "2027-08-04";
  assert.throws(() => resolveAttachmentVisualization(spec, tooLong, sources), /时间范围|上限/);
});

test("真实文件百分比计算不能以 sum 冒充可加总堆叠，金额仍可堆叠", async () => {
  for (const column of ["转化率（%）", "转化率（％）", "金额（元）", "单价"] ) {
    const summary = { id: attachmentId, version: "a".repeat(64), name: "虚构构成.csv" };
    const document = { tables: [{ id: "table", columns: ["门店", "渠道", column], rows: [["甲店", "线上", "50"], ["甲店", "线下", "60"]], rowNumbers: [2, 3], location: "构成表", warnings: [] }], blocks: [], images: [] };
    const store = { document: async () => ({ summary, document }) } as unknown as AttachmentStore;
    const tools = createAttachmentTools(store, scope, [attachmentId], { captureCalculations: true });
    const page = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column, groupBy: ["门店", "渠道"] });
    const { calculations, sources } = tools.visualizationEvidence();
    const spec = { id: "stack", revision: 1, kind: "stacked_bar" as const, renderer: "native" as const, afterBlockIndex: 0, source: { kind: "attachment" as const, calculationIds: [page.calculationId!], dimensionIndex: 0, seriesIndex: 1 }, selection: { mode: "all" as const } };
    if (column === "金额（元）") assert.equal(resolveAttachmentVisualization(spec, calculations, sources).series.length, 2);
    else assert.throws(() => resolveAttachmentVisualization(spec, calculations, sources), /可加总|比例|堆叠/);
  }
});

test("文件 MCP 回合把图表实际数据交给独立复核，最终保留计算引用", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ctf-file-chart-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const summary = { id: attachmentId, version: "a".repeat(64), name: "合成.csv", status: "ready", entries: [], warnings: [] };
  const document = { tables: [{ id: "table", columns: ["门店", "金额（元）"], rows: [["甲店", "10"], ["乙店", "80"]], rowNumbers: [2, 3], location: "销售表", warnings: [] }], blocks: [], images: [] };
  const store = { document: async () => ({ summary, document }), get: async () => summary, onRemove: () => () => {} } as unknown as AttachmentStore;
  let reviewed = false; const events: unknown[] = [];
  const query: AgentQuery = async function* ({ options }) {
    const review = Boolean(options?.mcpServers?.attachment_review); const server = options!.mcpServers![review ? "attachment_review" : "attachments"]; assert.ok("instance" in server);
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "文件图表回合", version: "1" }); await server.instance.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown> = {}) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse((result.content as Array<{ text: string }>)[0].text); };
    try {
      if (review) {
        const support = await call("read_attachment_review", { blockIndex: 0 });
        assert.equal(support.visualizations[0].series[0].values[0].exact, "80"); reviewed = true;
        await call("submit_attachment_review", { verdict: "accept", checks: [{ blockIndex: 0, sourceIds: ["s1"], verdict: "supported", reason: "已读取完整计算与图文，没有把候选冒充全表" }] });
      } else {
        const calculation = await call("calculate_attachment", { attachmentId, tableId: "table", operation: "sum", column: "金额（元）", groupBy: ["门店"], limit: 1 });
        const chart = await call("present_analysis_chart", { kind: "bar", renderer: "html", source: { kind: "attachment", calculationIds: [calculation.calculationId] }, selection: { mode: "top", limit: 1 } });
        const accepted = await call("submit_attachment_answer", { status: "answered", blocks: [{ text: "门店金额已按同口径计算，比较见图。", sourceIds: ["s1"] }], limitations: [], visualizations: { schema: "analysis-visualization/v1", items: [{ id: chart.visualizationId, afterBlockIndex: 0 }] } });
        assert.equal(accepted.accepted, true);
      }
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    } finally { await client.close(); }
  };
  const answer = await createConversationRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir: directory, pluginDir: join(process.cwd(), "agent/analytics-plugin"), store }, { query })(scope, { conversationId: scope.conversationId, question: "比较门店金额", history: [], attachmentIds: [attachmentId] }, undefined, (event) => events.push(event), "analysis-visualization/v1");
  assert.ok(reviewed); assert.equal(answer.visualizations?.items.length, 1); assert.equal(answer.calculations?.[0].groups.length, 2);
  assert.ok(events.some((event) => (event as { type: string }).type === "visualization"));
});

test("混合文件回合只放置明确引用的经营图，最终段落复核看到相同图文与全量数据", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ctf-mixed-chart-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const summary = { id: attachmentId, version: "a".repeat(64), name: "合成.csv", status: "ready", entries: [], warnings: [] };
  const document = { tables: [], blocks: [], images: [] };
  const store = { document: async () => ({ summary, document }), get: async () => summary, onRemove: () => () => {} } as unknown as AttachmentStore;
  const database = simulatedAnswer();
  database.visualizations = { schema: "analysis-visualization/v1", items: ["amount", "profit"].map((metricId, index) => ({ id: `database-chart-${index}`, revision: 1, kind: "bar", renderer: "native", afterBlockIndex: index, conclusionId: "conclusion", source: { kind: "analysis", operationId: "operation", metricId, dimension: "store" }, selection: { mode: "all" } })) };
  let reviewed = false;
  const query: AgentQuery = async function* ({ options }) {
    const review = Boolean(options?.mcpServers?.attachment_review); const server = options!.mcpServers![review ? "attachment_review" : "attachments"]; assert.ok("instance" in server);
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "混合图表回合", version: "1" }); await server.instance.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown> = {}) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse((result.content as Array<{ text: string }>)[0].text); };
    try {
      if (review) {
        const first = await call("read_attachment_review", { blockIndex: 0 }); assert.equal(first.visualizations.length, 0);
        const second = await call("read_attachment_review", { blockIndex: 1 });
        assert.equal(second.visualizations.length, 1); assert.equal(second.visualizations[0].id, "database-chart-0");
        assert.equal(second.visualizations[0].afterBlockIndex, 1); assert.equal(second.visualizations[0].series[0].values[0].exact, "1234.56");
        assert.equal(second.block.text, "历史经营数据的金额比较见图，先核对口径。"); reviewed = true;
        await call("submit_attachment_review", { verdict: "accept", checks: [0, 1].map((blockIndex) => ({ blockIndex, sourceIds: ["s1"], verdict: "supported", reason: "已核对该段与明确关联的经营图，没有插入未引用图表" })) });
      } else {
        await call("analyze_attachment_history", { focus: "核对同范围历史金额" });
        const accepted = await call("submit_attachment_answer", { status: "answered", blocks: [{ text: "当前资料需要结合相同范围的历史经营数据核对。", sourceIds: ["s1"] }, { text: "历史经营数据的金额比较见图，先核对口径。", sourceIds: ["s1"] }], limitations: [], visualizations: { schema: "analysis-visualization/v1", items: [{ id: "database-chart-0", afterBlockIndex: 1 }] } });
        assert.equal(accepted.accepted, true);
      }
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    } finally { await client.close(); }
  };
  const answer = await createConversationRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir: directory, pluginDir: join(process.cwd(), "agent/analytics-plugin"), store, runAnalytics: async () => database }, { query })(scope, { conversationId: scope.conversationId, question: "结合资料核对历史金额", history: [], attachmentIds: [attachmentId] }, undefined, undefined, "analysis-visualization/v1");
  assert.ok(reviewed); assert.equal(answer.visualizations?.items.length, 1); assert.equal(answer.visualizations?.items[0].afterBlockIndex, 1);
  assert.match(conversationAnswerText(answer), /1234\.56/); assert.doesNotMatch(conversationAnswerText(answer), /成本 · 按门店/);
  const changed = structuredClone(answer); changed.visualizations!.items[0].selection = { mode: "top", limit: 1 };
  assert.throws(() => validateConversationAnswer(changed), /图表|引用|经营/);
});

test("文件高精度小数按精确值排序，图形使用受限近似坐标，提示表格和复制保留原值", async () => {
  const summary = { id: attachmentId, version: "a".repeat(64), name: "合成公式缓存.csv" };
  const rows = [["A低", "1234567.123456789001"], ["Z高", "1234567.123456789002"], ["M汇总", "0.100000000000000001"], ["M汇总", "0.200000000000000002"], ["A负低", "-1234567.123456789002"], ["Z负高", "-1234567.123456789001"], ["缺失", null]];
  const document = { tables: [{ id: "table", columns: ["门店", "金额（元）"], rows, rowNumbers: rows.map((_, index) => index + 2), location: "完整表格", warnings: [] }], blocks: [], images: [] };
  const store = { document: async () => ({ summary, document }) } as unknown as AttachmentStore;
  const tools = createAttachmentTools(store, scope, [attachmentId], { captureCalculations: true });
  const page = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "金额（元）", groupBy: ["门店"], limit: 1 });
  const { calculations, sources } = tools.visualizationEvidence();
  const spec = { id: "precise", revision: 1, kind: "bar" as const, renderer: "native" as const, afterBlockIndex: 0, source: { kind: "attachment" as const, calculationIds: [page.calculationId!] }, selection: { mode: "top" as const, limit: 6 } };
  assert.equal(Number(rows[0][1]), Number(rows[1][1]), "两个精确值转换为坐标后重合，不能据此决定前列");
  for (const renderer of ["native", "html"] as const) {
    const chart = resolveAttachmentVisualization({ ...spec, renderer }, calculations, sources);
    assert.deepEqual(chart.categories.map((category) => category.label), ["Z高", "A低", "M汇总", "Z负高", "A负低", "缺失"]);
    assert.deepEqual(chart.series[0].values.map((value) => value.exact), ["1234567.123456789002", "1234567.123456789001", "0.300000000000000003", "-1234567.123456789001", "-1234567.123456789002", null]);
    assert.equal(chart.series[0].values[0].value, Number("1234567.123456789002")); assert.equal(chart.series[0].values.at(-1)?.value, null);
    assert.match(chart.limitations.join("；"), /近似/);
    for (const output of [visualizationSvg(chart), visualizationHtml(chart), visualizationText(chart)]) for (const exact of ["1234567.123456789002", "0.300000000000000003"]) assert.ok(output.includes(exact), "绘图提示、数据表和复制不截断精确数值");
  }
  for (const unsafe of ["9007199254740991.1", "-9007199254740991.1", "1" + "0".repeat(400), "0." + "0".repeat(324) + "1"]) {
    const changed = structuredClone(calculations); changed[0].groups[0].value = unsafe;
    assert.throws(() => resolveAttachmentVisualization(spec, changed, sources), /范围|精度|可靠/);
  }
});

test("Excel零点ISO月份按明确月度列绘图并补月空点，日期列仍按日且拒绝无效时间", async () => {
  for (const column of ["月份", "年月", "月度", "日期"]) {
    const summary = { id: attachmentId, version: "a".repeat(64), name: "合成月报.xlsx" };
    const document = { tables: [{ id: "table", columns: [column, "净销售额_含税元"], rows: [["2025-01-01T00:00:00", "10"], ["2025-03-01T00:00:00", "30"]], rowNumbers: [2, 3], location: "月报", warnings: [] }], blocks: [], images: [] };
    const store = { document: async () => ({ summary, document }) } as unknown as AttachmentStore;
    const tools = createAttachmentTools(store, scope, [attachmentId], { captureCalculations: true });
    const page = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "净销售额_含税元", groupBy: [column] });
    const { calculations, sources } = tools.visualizationEvidence();
    const spec = { id: "months", revision: 1, kind: "line" as const, renderer: "native" as const, afterBlockIndex: 0, source: { kind: "attachment" as const, calculationIds: [page.calculationId!] }, selection: { mode: "all" as const } };
    const chart = resolveAttachmentVisualization(spec, calculations, sources);
    assert.equal(chart.categories.length, column === "日期" ? 60 : 3, "不能靠月份间隔把日期列误当月度，也不能把月度数据补成逐日点");
    if (column !== "日期") {
      assert.deepEqual(chart.categories.map((item) => [item.key, item.label]), [["2025-01-01", "2025-01"], ["2025-02-01", "2025-02"], ["2025-03-01", "2025-03"]]);
      assert.deepEqual(chart.series[0].values.map((item) => item.exact), ["10", null, "30"]);
      assert.match(chart.limitations.join("；"), /缺失月份/); assert.doesNotMatch(chart.limitations.join("；"), /缺失日期/);
    }
    assert.deepEqual(chart.series[0].values[0].refIds, [calculations[0].groups[0].sourceId]);
    for (const invalid of ["2025-02-30T00:00:00", "2025-01-01T12:00:00", "2025年第一季度"]) {
      const changed = structuredClone(calculations); changed[0].groups[0].labels[0] = invalid;
      assert.throws(() => resolveAttachmentVisualization(spec, changed, sources), /日期|时间/);
    }
    const duplicate = structuredClone(calculations); duplicate[0].groups[1].labels[0] = "2025-01-01";
    assert.throws(() => resolveAttachmentVisualization(spec, duplicate, sources), /重复|歧义/);
  }
});

test("比率图按百分数展示，标题去掉列名单位后缀，模型可给业务标题", async () => {
  const tools = (() => {
    const summary = { id: attachmentId, version: "a".repeat(64), name: "活动.csv" };
    const document = { tables: [{ id: "table", name: "活动", columns: ["活动类型", "净毛利率", "扣营销费贡献_元"], rows: [["会员券", "0.34", "100"], ["定价", "0.26", "300"], ["每克立减", "0.09", "50"]], rowNumbers: [2, 3, 4], location: "活动表", warnings: [] }], blocks: [], images: [] };
    return createAttachmentTools({ document: async () => ({ summary, document }) } as unknown as AttachmentStore, scope, [attachmentId], { captureCalculations: true });
  })();
  const rate = await tools.calculate({ attachmentId, tableId: "table", operation: "average", column: "净毛利率", groupBy: ["活动类型"] });
  const { calculations, sources } = tools.visualizationEvidence();
  const chart = resolveAttachmentVisualization({ id: "rate", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "attachment", calculationIds: [rate.calculationId!] }, selection: { mode: "all" } }, calculations, sources);
  assert.equal(chart.valueFormat, "percent"); assert.deepEqual(chart.categories.map((c) => c.label), ["会员券", "定价", "每克立减"]);
  assert.match(visualizationSvg(chart), /34%/); assert.doesNotMatch(visualizationSvg(chart), />0\.34</);
  const contribution = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "扣营销费贡献_元", groupBy: ["活动类型"] });
  const named = resolveAttachmentVisualization({ id: "c", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "attachment", calculationIds: [contribution.calculationId!] }, selection: { mode: "all" } }, tools.visualizationEvidence().calculations, tools.visualizationEvidence().sources);
  assert.equal(named.title, "扣营销费贡献 · 按活动类型"); assert.equal(named.categories[0].label, "定价");
  const titled = resolveAttachmentVisualization({ id: "c", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, title: "各类活动扣费贡献", source: { kind: "attachment", calculationIds: [contribution.calculationId!] }, selection: { mode: "all" } }, tools.visualizationEvidence().calculations, tools.visualizationEvidence().sources);
  assert.equal(titled.title, "各类活动扣费贡献");
});

test("逐组派生的比率可以直接画图", async () => {
  const summary = { id: attachmentId, version: "a".repeat(64), name: "活动.csv" };
  const document = { tables: [{ id: "table", name: "活动", columns: ["活动类型", "净毛利_元", "净收入_元"], rows: [["会员券", "34", "100"], ["定价", "52", "200"]], rowNumbers: [2, 3], location: "活动表", warnings: [] }], blocks: [], images: [] };
  const tools = createAttachmentTools({ document: async () => ({ summary, document }) } as unknown as AttachmentStore, scope, [attachmentId], { captureCalculations: true });
  const profit = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "净毛利_元", groupBy: ["活动类型"] });
  const revenue = await tools.calculate({ attachmentId, tableId: "table", operation: "sum", column: "净收入_元", groupBy: ["活动类型"] });
  const margin = await tools.derive({ operation: "ratio", numeratorRef: profit.resultRef, denominatorRef: revenue.resultRef, label: "毛利率" });
  assert.ok("groups" in margin && margin.calculationId); const marginId = (margin as { calculationId: string }).calculationId;
  const { calculations, sources } = tools.visualizationEvidence();
  const chart = resolveAttachmentVisualization({ id: "m", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "attachment", calculationIds: [marginId] }, selection: { mode: "all" } }, calculations, sources);
  assert.equal(chart.valueFormat, "percent"); assert.deepEqual(chart.categories.map((c) => c.label), ["会员券", "定价"]); assert.match(visualizationSvg(chart), /34%/);
});
