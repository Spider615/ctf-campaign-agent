import assert from "node:assert/strict";
import test from "node:test";
import { drawQaChart, type DrawQaChartInput } from "../app/lib/analytics/qa/chart.ts";
import type { AnalysisEvidence, AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { createEvidenceRegistry } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { simulatePlanScenario } from "../app/lib/analytics/plan/scenario.ts";
import { assembleQaAnswer } from "../app/lib/analytics/qa/answer.ts";
import { validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";

function fixture(values: Array<number | null> = [120, null, 30]): AnalysisOperationResult {
  return {
    operationId: "op", method: "aggregate", status: "completed", needIds: [], purpose: "按分区查实收", limitations: [],
    frames: [{ id: "frame", snapshotId: "snapshot", datasetVersion: "version", mode: "snapshot", provenance: "sample", scope: { period: { start: "2025-08-01", end: "2025-08-03" }, population: "sales", filters: {} }, currency: "CNY", grain: "line", controls: [], limitations: [] }],
    objects: values.map((_, at) => ({ id: `o${at}`, frameId: "frame", dimension: "district", value: `分区${at}`, label: `分区${at}` })),
    facts: values.map((value, at) => ({ id: `f${at}`, frameId: "frame", operationId: "op", metricId: "amount", label: "销售金额", value, unit: "CNY", definition: "销售正金额实收", objectIds: [`o${at}`], limitations: value === null ? ["参与数据缺失，未补零"] : [] })),
    methods: [{ id: "method", operationId: "op", method: "aggregate", status: "completed", frameIds: ["frame"], controls: [], checks: [{ name: "聚合", status: "performed", result: "完成" }], sampleRows: values.length, groupCount: values.length, limitations: [] }],
  };
}
const draw = (result: AnalysisOperationResult, input: Partial<DrawQaChartInput> = {}, evidence: AnalysisEvidence = result) => drawQaChart({ id: "c1", input: { resultId: "r1", metric: "amount", kind: "bar", ...input }, result, evidence });

test("分区柱图读取完整结果的真实值，保留缺失 null，不混入总体或其他结果", () => {
  const result = fixture();
  result.facts.push({ ...result.facts[0], id: "total", value: 150, objectIds: [] });
  const evidence = structuredClone(result); evidence.facts.push({ ...result.facts[0], id: "unrelated", operationId: "another-op", value: 99999 });
  const chart = draw(result, { by: "district" }, evidence);
  assert.deepEqual(chart.categories.map((item) => item.label), ["分区0", "分区2", "分区1"]);
  assert.deepEqual(chart.series[0].values.map((item) => item.value), [120, 30, null]);
  assert.equal(chart.series[0].values[2].exact, null);
  assert.ok(!chart.factIds.includes("total")); assert.ok(!chart.factIds.includes("unrelated"));
  assert.equal(chart.unit, "元"); assert.equal(chart.id, "c1");
});

test("top 从完整结果排序，第 101 组可入选，展示截取不修改原始事实", () => {
  const result = fixture([...Array.from({ length: 100 }, () => 1), 999]);
  const before = structuredClone(result);
  const chart = draw(result, { by: "district", top: 1 });
  assert.deepEqual(chart.categories.map((item) => item.label), ["分区100"]);
  assert.deepEqual(chart.series[0].values.map((item) => item.value), [999]);
  assert.match(chart.selectionLabel, /101/); assert.deepEqual(result, before);
});

test("1005组完整结果参与排名，图表展示前30组且v4往返保留全部图事实与null", () => {
  const result = fixture(Array.from({ length: 1005 }, (_, at) => at === 5 ? null : at + 1));
  const before = structuredClone(result);
  const chart = draw(result, { by: "district", top: 30 });
  assert.equal(chart.categories.length, 30);
  assert.equal(chart.categories[0].label, "分区1004");
  assert.equal(chart.series[0].values[0].value, 1005);
  assert.match(chart.selectionLabel, /1005/);
  assert.equal(new Set(chart.factIds).size, 1005);
  const answer = assembleQaAnswer({ runId: "large", question: "前列分区", body: "全部分区参与排名，图中展示前列。\n\n[[chart:c1]]", charts: new Map([["c1", chart]]), evidence: result, readFactIds: [], operations: [{ id: "r1", op: "aggregate", status: "completed", summary: "读取全部1005组" }] });
  const back = validatePlanAnswerV4(JSON.parse(JSON.stringify(answer)));
  assert.deepEqual(new Set(back.evidence.facts.map((fact) => fact.id)), new Set(result.facts.map((fact) => fact.id)));
  assert.equal(back.evidence.facts.find((fact) => fact.id === "f5")?.value, null);
  assert.deepEqual(result, before);
});

test("日期折线升序，实际缺失和断档保留 null，不接受非日期趋势或 top 抽点", () => {
  const result = fixture([30, 10]);
  result.objects.forEach((item, at) => { item.dimension = "day"; item.value = at ? "2025-08-01" : "2025-08-03"; item.label = item.value; });
  const chart = draw(result, { kind: "line", by: "day" });
  assert.deepEqual(chart.categories.map((item) => item.key), ["2025-08-01", "2025-08-02", "2025-08-03"]);
  assert.deepEqual(chart.series[0].values.map((item) => item.value), [10, null, 30]);
  assert.throws(() => draw(result, { kind: "line", by: "day", top: 1 }), /完整|趋势|前列/);
  assert.throws(() => draw(fixture(), { kind: "line", by: "district" }), /日期|时间/);
});

test("图表拒绝数值注入、错误指标、未完成或不存在的结果", () => {
  assert.throws(() => draw(fixture(), { values: [999] } as Partial<DrawQaChartInput>), /字段|数值|覆盖/);
  assert.throws(() => draw(fixture(), { metric: "销售额" }), /真实指标|指标/);
  assert.throws(() => draw({ ...fixture(), facts: [] }), /空|没有|结果/);
  assert.throws(() => draw({ ...fixture(), status: "unsupported" }), /完成|不支持/);
  assert.throws(() => draw(undefined as unknown as AnalysisOperationResult), /结果.*不存在/);
});

test("同指标多个控制层不能混合，明确 frameIds 后只画选中的范围", () => {
  const result = fixture();
  result.frames.push({ ...structuredClone(result.frames[0]), id: "controlled", controls: ["category"] });
  result.methods[0].frameIds.push("controlled");
  result.objects.push(...result.objects.map((item) => ({ ...item, id: `${item.id}-c`, frameId: "controlled" })));
  result.facts.push(...result.facts.map((item) => ({ ...item, id: `${item.id}-c`, frameId: "controlled", objectIds: item.objectIds.map((id) => `${id}-c`) })));
  assert.throws(() => draw(result, { by: "district" }), /frameIds/);
  const chart = draw(result, { by: "district", frameIds: ["frame"] });
  assert.ok(chart.factIds.every((id) => !id.endsWith("-c")));
  assert.throws(() => draw(result, { by: "district", frameIds: ["ghost"] }), /范围|frameIds/);
});

test("真实比较操作生成目标与参照双系列，方向从差额父链取得，兼容无分组比较", async () => {
  const session = await createSnapshotAnalysisProvider(sampleDataset()).open();
  try {
    const scope = { period: { start: "2026-09-01", end: "2026-09-07" }, population: "sales" as const, filters: {} };
    const reference = { ...scope, period: { start: "2025-08-01", end: "2025-08-07" } };
    for (const by of [[], ["category"]] as const) {
      const original = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "比较目标参照", method: "compare", scope, reference, metrics: ["amount"], by: [...by] });
      const result = { ...original, frames: [...original.frames].reverse(), facts: [...original.facts].reverse() };
      const chart = draw(result, by.length ? { by: "category" } : {});
      assert.equal(chart.series.length, 2);
      assert.match(chart.series[0].label, /目标/); assert.match(chart.series[1].label, /参照/);
      for (const series of chart.series) for (const point of series.values) if (point.refIds.length) {
        assert.equal(point.value, result.facts.find((fact) => fact.id === point.refIds[0])?.value);
        const frame = result.frames.find((item) => item.id === result.facts.find((fact) => fact.id === point.refIds[0])?.frameId)!;
        assert.deepEqual(frame.scope.period, series.label.startsWith("目标") ? scope.period : reference.period);
      }
      assert.ok(!chart.factIds.some((id) => result.facts.find((fact) => fact.id === id)?.metricId.endsWith(".delta")));
    }
  } finally { await session.close(); }
});

test("P2控制比较未指定by时按差额父链选总体目标参照，显式frameIds也不丢参照", async () => {
  const session = await createSnapshotAnalysisProvider(sampleDataset()).open();
  try {
    const scope = { period: { start: "2026-09-01", end: "2026-09-07" }, population: "sales" as const, filters: {} };
    const result = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "货类控制下对比总体", method: "compare", scope, reference: { ...scope, period: { start: "2025-08-01", end: "2025-08-07" } }, metrics: ["amount"], by: [], controls: ["category"] });
    const delta = result.facts.find((fact) => fact.metricId === "amount.delta" && !fact.objectIds.length)!;
    assert.ok(delta.derivation && "args" in delta.derivation);
    const rootIds = delta.derivation.args.map((item) => { assert.ok("factId" in item); return item.factId; });
    for (const selection of [{}, { frameIds: result.frames.map((frame) => frame.id) }]) {
      const chart = draw(result, selection);
      assert.equal(chart.categories.length, 1);
      assert.equal(chart.series.length, 2);
      assert.match(chart.series[0].label, /目标/); assert.match(chart.series[1].label, /参照/);
      assert.deepEqual(chart.series.map((series) => series.values[0].value), [242116, 220416]);
      assert.deepEqual(chart.series.map((series) => series.values[0].refIds[0]), rootIds);
      assert.deepEqual(new Set(chart.factIds), new Set(rootIds));
    }
    assert.throws(() => draw(result, { by: "category" }), /参照|范围|frameIds/);
  } finally { await session.close(); }
});

test("同一范围同一分组的重复指标不能覆盖或混加", () => {
  const result = fixture(); result.facts.push({ ...result.facts[0], id: "duplicate" });
  assert.throws(() => draw(result, { by: "district" }), /歧义|重复/);
});

test("情景图使用受控结果、数值横轴与收入持平参照，并保留完整父链", async () => {
  const session = await createSnapshotAnalysisProvider(sampleDataset()).open(); const registry = createEvidenceRegistry();
  try {
    const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope: { period: session.capabilities.coverage, population: "sales", filters: {} }, metrics: ["amount"] }); registry.ingest(baseline);
    const result = await simulatePlanScenario({ id: "scenario", adjustment: { kind: "amount_rate", rate: "0.05" }, netVolumeChanges: ["0.03", "-0.01", "0"], reason: "商品与价格结构固定，排除成交挪动" }, baseline.facts[0].id, registry.view(), session); registry.ingest(result);
    const chart = draw(result, { kind: "line", metric: "scenario.revenue_change" }, registry.view());
    assert.equal(chart.xAxis?.kind, "number");
    assert.deepEqual(chart.categories.map((item) => item.numericValue), [-1, 0, 3]);
    assert.ok(chart.series[1].values.every((item) => item.value === 0));
    assert.ok(chart.factIds.includes(baseline.facts[0].id));
    assert.match(chart.limitations.join(""), /假设|预测/);
    assert.throws(() => draw(result, { kind: "bar", metric: "scenario.revenue_change" }, registry.view()), /情景|完整/);
    const broken = structuredClone(registry.view()); broken.facts = broken.facts.filter((item) => item.id !== baseline.facts[0].id);
    assert.throws(() => draw(result, { kind: "line", metric: "scenario.revenue_change" }, broken), /情景|父|引用/);
  } finally { await session.close(); }
});

test("自动图题、分类、系列及所有说明清除厂商框架身份，输入数据不被改写", () => {
  const result = fixture();
  result.facts.forEach((item) => { item.definition = "由 OpenAI 提供。真实实收。"; item.label = "Claude 销售模型。销售金额。"; item.limitations = ["Anthropic 生成。未估计因果。"] ; });
  result.objects[0].label = "我是 ChatGPT。东区";
  result.frames[0].limitations = ["Agent SDK 驱动。观察口径。"];
  const before = structuredClone(result); const chart = draw(result, { by: "district", title: "Claude 模型图。分区实收" });
  assert.doesNotMatch(JSON.stringify({ ...chart, factIds: [], sourceIds: [], objectIds: [] }), /OpenAI|Claude|ChatGPT|Anthropic|Agent\s*SDK|我是小福/i);
  assert.match(chart.definition, /真实实收/); assert.deepEqual(result, before);
});
