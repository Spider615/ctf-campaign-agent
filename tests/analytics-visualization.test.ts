import assert from "node:assert/strict";
import test from "node:test";
import { parseVisualizationSpec, resolveAnalysisVisualization, resolveAttachmentVisualization, visualizationText } from "../app/lib/analytics/visualization.ts";
import { visualizationHtml, visualizationSvg } from "../app/lib/analytics/visualization-html.ts";
import type { AnalysisEvidence } from "../app/lib/analytics/analysis-v2-types.ts";
import type { VisualizationSpec, AttachmentCalculation } from "../app/lib/analytics/visualization-types.ts";

export function chartEvidence(): AnalysisEvidence {
  return {
    frames: [{ id: "frame", snapshotId: "snapshot", datasetVersion: "version", mode: "database", provenance: "imported", scope: { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} }, currency: "CNY", grain: "group", controls: [], limitations: [] }],
    objects: ["甲店", "乙店", "丙店"].map((label, i) => ({ id: `object-${i}`, frameId: "frame", dimension: "store", value: String(i), label })),
    facts: [120, null, -30].map((value, i) => ({ id: `fact-${i}`, frameId: "frame", operationId: "operation", metricId: "amount", label: "销售金额", value, unit: "CNY", definition: "销售正金额行实收", objectIds: [`object-${i}`], limitations: [] })),
    methods: [{ id: "method", operationId: "operation", method: "aggregate", status: "completed", frameIds: ["frame"], controls: [], checks: [], sampleRows: 3, groupCount: 3, limitations: [] }],
  };
}
export function chartSpec(): VisualizationSpec {
  return { id: "chart", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store" }, selection: { mode: "all" } };
}

test("图表从完整真实事实取值，缺失不补零，原生和 HTML 使用相同数据", () => {
  const chart = resolveAnalysisVisualization(chartSpec(), chartEvidence());
  assert.deepEqual(chart.series[0].values.map((v) => v.value), [120, null, -30]);
  assert.deepEqual(chart.categories.map((v) => v.label), ["甲店", "乙店", "丙店"]);
  assert.equal(chart.series[0].values[1].exact, null);
  assert.ok(visualizationText(chart).includes("未提供"));
  assert.ok(visualizationHtml(chart).includes("甲店"));
  assert.ok(visualizationHtml(chart).includes("120"));
});

test("模型不能覆盖数值，未知操作、多单位、多币种和多快照不能绘图", () => {
  assert.throws(() => parseVisualizationSpec({ ...chartSpec(), values: [999] }), /字段|覆盖/);
  assert.throws(() => resolveAnalysisVisualization({ ...chartSpec(), source: { kind: "analysis", operationId: "fake", metricId: "amount", dimension: "store" } }, chartEvidence()), /操作|来源/);
  for (const field of ["unit", "currency", "snapshotId"] as const) {
    const evidence = chartEvidence();
    if (field === "unit") evidence.facts[1].unit = "USD";
    else { evidence.frames.push({ ...structuredClone(evidence.frames[0]), id: "other", [field]: field === "currency" ? "USD" : "other" }); evidence.facts[1].frameId = "other"; evidence.objects[1].frameId = "other"; evidence.methods[0].frameIds.push("other"); }
    assert.throws(() => resolveAnalysisVisualization(chartSpec(), evidence), /单位|币种|快照|口径/);
  }
});

test("重复分类不覆盖、不相加；前列由完整结果排序并保留覆盖说明", () => {
  const evidence = chartEvidence(); evidence.facts.push({ ...evidence.facts[0], id: "duplicate" });
  assert.throws(() => resolveAnalysisVisualization(chartSpec(), evidence), /重复|歧义/);
  const chart = resolveAnalysisVisualization({ ...chartSpec(), selection: { mode: "top", limit: 2 } }, chartEvidence());
  assert.deepEqual(chart.categories.map((v) => v.label), ["甲店", "丙店"]);
  assert.match(chart.selectionLabel, /2.*3|三|全部/);
});

test("趋势按真实日期排序，缺失仍是空点；类别不能冒充时间", () => {
  const evidence = chartEvidence();
  evidence.frames[0].scope.period.end = "2025-08-03";
  evidence.objects.forEach((o, i) => { o.dimension = "day"; o.value = ["2025-08-03", "2025-08-01", "2025-08-02"][i]; o.label = o.value; });
  const spec = { ...chartSpec(), kind: "line" as const, source: { kind: "analysis" as const, operationId: "operation", metricId: "amount", dimension: "day" as const } };
  const chart = resolveAnalysisVisualization(spec, evidence);
  assert.deepEqual(chart.categories.map((v) => v.label), ["2025-08-01", "2025-08-02", "2025-08-03"]);
  assert.equal(chart.series[0].values[0].value, null);
  assert.throws(() => resolveAnalysisVisualization({ ...chartSpec(), kind: "line" }, chartEvidence()), /时间|日期/);
});

test("堆叠拒绝均值、去重订单以及不完整的候选分组", () => {
  const evidence = chartEvidence(); evidence.facts.forEach((f) => { f.metricId = "orders"; f.unit = "单"; });
  assert.throws(() => resolveAnalysisVisualization({ ...chartSpec(), kind: "stacked_bar", source: { kind: "analysis", operationId: "operation", metricId: "orders", dimension: "store" } }, evidence), /加总|堆叠/);
});

test("HTML 对业务名称转义，禁止脚本和外部资源，表格仍可读", () => {
  const evidence = chartEvidence(); evidence.objects[0].label = '</title><script>fetch("https://evil.example")</script><img src="https://evil.example">';
  const html = visualizationHtml(resolveAnalysisVisualization(chartSpec(), evidence));
  assert.match(html, /script-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('<img src="https://evil.example">'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<table/);
});

test("文件图表从完整计算记录排序，不能从已读分页伪造排名", () => {
  const calculation: AttachmentCalculation = { id: "calculation", attachmentId: "file", version: "version", tableId: "table", name: "测试文件", location: "工作表", operation: "sum", column: "销售金额（元）", groupBy: ["门店"], unit: "元", filters: [], groupCount: 3, groups: [10, 900, 50].map((value, index) => ({ labels: [`门店${index}`], value: String(value), sourceId: `s${index}`, matchedRows: 1, missingRows: 0 })), warnings: [] };
  const sources = calculation.groups.map((g) => ({ id: g.sourceId, attachmentId: "file", version: "version", name: "测试文件", location: "工作表", excerpt: `求和：${g.value}` }));
  const spec: VisualizationSpec = { ...chartSpec(), source: { kind: "attachment", calculationIds: ["calculation"] }, selection: { mode: "top", limit: 1 } };
  const chart = resolveAttachmentVisualization(spec, [calculation], sources);
  assert.equal(chart.categories[0].label, "门店1");
  assert.equal(chart.series[0].values[0].exact, "900");
  assert.throws(() => resolveAttachmentVisualization(spec, [calculation], sources.map((s) => ({ ...s, version: "different" }))), /版本|来源/);
});

test("日趋势保留授权周期内未观察到的日期，不把断档连成连续记录", () => {
  const evidence = chartEvidence(); evidence.frames[0].scope.period = { start: "2025-08-01", end: "2025-08-04" };
  evidence.facts = [evidence.facts[0], evidence.facts[2]]; evidence.objects = [evidence.objects[0], evidence.objects[2]];
  evidence.objects.forEach((item, at) => { item.dimension = "day"; item.value = at ? "2025-08-04" : "2025-08-01"; item.label = item.value; });
  const chart = resolveAnalysisVisualization({ ...chartSpec(), kind: "line", source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "day" } }, evidence);
  assert.deepEqual(chart.series[0].values.map((point) => point.value), [120, null, null, -30]);
  evidence.objects[0].value = "2025-99-99";
  assert.throws(() => resolveAnalysisVisualization({ ...chartSpec(), kind: "line", source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "day" } }, evidence), /日期|时间|范围/);
});

test("净销售与退货在图表标题中保持真实口径", () => {
  const evidence = chartEvidence(); evidence.frames[0].scope.population = "net";
  assert.match(resolveAnalysisVisualization(chartSpec(), evidence).title, /净销售/);
  evidence.frames[0].scope.population = "returns";
  assert.match(resolveAnalysisVisualization(chartSpec(), evidence).title, /退货/);
});

test("堆叠不能把分类自身当成组成系列，也不能遗漏实际分组", () => {
  const evidence = chartEvidence();
  assert.throws(() => resolveAnalysisVisualization({ ...chartSpec(), kind: "stacked_bar", source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store", seriesDimension: "store" } }, evidence), /分组|维度|堆叠/);
});

test("窄屏图形按实际宽度绘制，长分类省略且不堆叠端点数值", () => {
  const evidence = chartEvidence(); evidence.objects[0].label = "模拟名称非常长的零售门店";
  const svg = visualizationSvg(resolveAnalysisVisualization(chartSpec(), evidence), [], 254);
  assert.match(svg, /viewBox="0 0 254 /);
  assert.ok(!svg.includes('</title>模拟名称非常长的零售门店</text>'));
  assert.ok(svg.includes("…</text>"));
});

test("不同文件列缺少单位时不能作为同单位序列混画", () => {
  const base: AttachmentCalculation = { id: "a", attachmentId: "file", version: "version", tableId: "table", name: "文件", location: "表", operation: "sum", column: "金额", groupBy: ["门店"], unit: "原表数值，单位未提供", filters: [], groupCount: 1, groups: [{ labels: ["甲店"], value: "10", sourceId: "s", matchedRows: 1, missingRows: 0 }], warnings: [] };
  const other = { ...structuredClone(base), id: "b", column: "克重" };
  const spec: VisualizationSpec = { ...chartSpec(), source: { kind: "attachment", calculationIds: ["a", "b"] } };
  assert.throws(() => resolveAttachmentVisualization(spec, [base, other], [{ id: "s", attachmentId: "file", version: "version", name: "文件", location: "表", excerpt: "10" }]), /单位|口径/);
});
