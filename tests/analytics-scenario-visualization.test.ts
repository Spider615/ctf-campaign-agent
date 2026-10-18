import assert from "node:assert/strict";
import test from "node:test";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { createEvidenceRegistry, validateAnalysisEvidence } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { simulatePlanScenario } from "../app/lib/analytics/plan/scenario.ts";
import { resolveAnalysisVisualization } from "../app/lib/analytics/visualization.ts";
import { visualizationHtml, visualizationSvg } from "../app/lib/analytics/visualization-html.ts";
import { resolveVisualizationPreview } from "../app/lib/analytics/visualization-progress.ts";
import type { VisualizationSpec } from "../app/lib/analytics/visualization-types.ts";

async function fixture(netVolumeChanges = ["-0.01", "0", "0.01", "0.03"]) {
  const dataset = sampleDataset(); const period = { start: dataset.minDate, end: dataset.maxDate };
  const session = await createSnapshotAnalysisProvider(dataset).open(); const registry = createEvidenceRegistry();
  const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope: { period, population: "sales", filters: {} }, metrics: ["amount"] }); registry.ingest(baseline);
  const outcome = await simulatePlanScenario({ id: "scenario", adjustment: { kind: "per_item", amount: "0.005" }, netVolumeChanges, reason: "同结构、固定价格、排除成交挪动的假设" }, baseline.facts[0].id, registry.view(), session); registry.ingest(outcome);
  const spec: VisualizationSpec = { id: "scenario-chart", revision: 1, kind: "line", renderer: "native", afterBlockIndex: 0, source: { kind: "scenario", operationId: outcome.operationId, metricId: "scenario.revenue_change" }, selection: { mode: "all" } };
  return { session, registry, baseline, outcome, spec };
}

test("情景图只取受控计算的完整假设与结果，保留数值横轴和持平参照", async () => {
  const f = await fixture();
  try {
    const chart = resolveAnalysisVisualization(f.spec, f.registry.view());
    assert.equal(chart.xAxis?.kind, "number"); assert.match(chart.title, /情景|条件/); assert.match(chart.limitations.join(""), /预测|假设/);
    assert.deepEqual(chart.categories.map((item) => item.numericValue), [-1, 0, 1, 3]);
    assert.equal(chart.series.length, 2); assert.ok(chart.series[1].values.every((item) => item.value === 0));
    const svg = visualizationSvg(chart); assert.ok(!/NaN|Infinity/.test(svg));
    const xs = [...svg.matchAll(/<circle cx="([^"]+)"/g)].slice(0, 4).map((match) => Number(match[1]));
    assert.ok(Math.abs((xs[1] - xs[0]) / (xs[3] - xs[0]) - .25) < 1e-10, "横轴必须按真实比例间距，不按数组等距");
    assert.match(visualizationHtml(chart), /假设净成交量/);
    const checked = validateAnalysisEvidence(f.registry.bundle()); assert.ok(checked.facts.some((item) => item.id === f.baseline.facts[0].id));
  } finally { await f.session.close(); }
});

test("错配情景、丢失父引用或伪造金额不能绘图，也不能覆盖现有时间趋势规则", async () => {
  const f = await fixture();
  try {
    for (const kind of ["rate", "value", "frame"] as const) {
      const evidence = structuredClone(f.registry.view()); const point = evidence.facts.find((item) => item.metricId === "scenario.revenue_change")!;
      if (kind === "value") point.value! += 100;
      else if (kind === "frame") point.frameId = "other";
      else if (point.scenario?.kind === "revenue") point.scenario.rateFactId = "unknown";
      assert.throws(() => resolveAnalysisVisualization(f.spec, evidence), /情景|引用|范围|金额/);
    }
    assert.throws(() => resolveAnalysisVisualization({ ...f.spec, source: { kind: "analysis", operationId: f.outcome.operationId, metricId: "scenario.revenue_after", dimension: "store" } }, f.registry.view()), /维度|分组|情景/);
    assert.throws(() => resolveAnalysisVisualization({ ...f.spec, selection: { mode: "top", limit: 1 } }, f.registry.view()), /情景|完整/);
  } finally { await f.session.close(); }
});

test("旧会话保存的情景图预览恢复时按同一证据重新解析", async () => {
  const f = await fixture();
  try {
    const chart = resolveAnalysisVisualization(f.spec, f.registry.view());
    assert.deepEqual(resolveVisualizationPreview({ spec: f.spec, evidence: f.registry.bundle() }).series, chart.series);
  } finally { await f.session.close(); }
});

test("情景横轴的百分比保留有效精度，不展示浮点尾数或把微小增量变成零", async () => {
  const f = await fixture(["-0.005", "0", "0.035", "0.07", "0.123456789012", "0.000000000001"]);
  try {
    const chart = resolveAnalysisVisualization(f.spec, f.registry.view());
    assert.deepEqual(chart.categories.map((item) => item.label), ["-0.5%", "0%", "0.0000000001%", "3.5%", "7%", "12.3456789012%"]);
    assert.equal(chart.unit, "元");
  } finally { await f.session.close(); }
});
