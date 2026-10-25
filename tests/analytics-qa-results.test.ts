import assert from "node:assert/strict";
import test from "node:test";
import { createQaResult, pageQaResult } from "../app/lib/analytics/qa/results.ts";
import { capabilityBrief } from "../app/lib/analytics/qa/capabilities.ts";
import type { AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";

function result(count = 151): AnalysisOperationResult {
  return {
    operationId: "operation-1", method: "aggregate", status: "completed", purpose: "核对全部门店", needIds: ["qa"], limitations: [],
    frames: [{ id: "f", snapshotId: "snapshot", datasetVersion: "version", mode: "snapshot", provenance: "sample", scope: { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} }, currency: "CNY", grain: "line", controls: [], limitations: [] }],
    objects: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, frameId: "f", dimension: "store", value: String(i).padStart(4, "0"), label: `门店${i}` })),
    facts: Array.from({ length: count }, (_, i) => ({ id: `v${i}`, frameId: "f", operationId: "operation-1", metricId: "amount", label: "销售实收", value: i === 100 ? null : i * 10.01, unit: "CNY", definition: "原实收按分聚合", objectIds: [`o${i}`], limitations: [] })),
    methods: [{ id: "m", operationId: "operation-1", method: "aggregate", status: "completed", frameIds: ["f"], controls: [], checks: [{ name: "实际聚合", status: "performed", result: "完整读取" }], sampleRows: count, groupCount: count, limitations: [] }],
  };
}

test("结果分页完整读到第101组，游标绑定结果且不修改事实值", () => {
  const stored = createQaResult("r1", result());
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = pageQaResult(stored, { cursor, pageSize: 100 });
    assert.equal(page.totalGroups, 151);
    assert.ok(JSON.stringify(page).length <= 16000);
    seen.push(...page.groups.flatMap((g) => g.facts.map((f) => f.id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, 151);
  assert.equal(stored.readFactIds.size, 151);
  assert.equal(stored.result.facts[100].value, null);
  assert.throws(() => pageQaResult(createQaResult("r2", result()), { cursor: "qa:r1:1" }), /游标/);
  assert.throws(() => pageQaResult(stored, { cursor: "qa:r1:9999" }), /游标/);
});

test("字符预算在100组之前续页，不静默删除超长标签组", () => {
  const source = result(35);
  source.objects.forEach((object) => { object.label = "较长的真实门店说明".repeat(65) + object.value; });
  const stored = createQaResult("long", source);
  const first = pageQaResult(stored);
  assert.ok(first.groups.length < 35 && first.nextCursor);
  assert.ok(JSON.stringify(first).length <= 16000);
  const seen = [...first.groups]; let cursor: string | null = first.nextCursor;
  while (cursor) { const page = pageQaResult(stored, { cursor }); seen.push(...page.groups); cursor = page.nextCursor; }
  assert.equal(seen.length, 35);
});

test("百分数不再乘100；同一对象的目标参照与差额保持同组", () => {
  const source = result(1);
  source.facts = [source.facts[0], { ...source.facts[0], id: "rate", metricId: "amount.relative_change", value: 12, unit: "%", label: "实收相对变化" }];
  const page = pageQaResult(createQaResult("r", source));
  assert.equal(page.groups.length, 1);
  assert.equal(page.groups[0].facts.length, 2);
  assert.equal(page.groups[0].facts[1].value, 12);
  assert.match(page.groups[0].facts[1].formatted, /12\.00%/);
});

test("能力目录保留完整指标定义并告知维度取值可分页", () => {
  const definition = "需要完整保留的业务口径".repeat(15);
  const brief = capabilityBrief({ mode: "snapshot", name: "测试", currency: "CNY", coverage: { start: "2025-08-01", end: "2025-08-31" }, provenance: "sample", dimensions: ["store"], metrics: [{ id: "amount", label: "实收", unit: "CNY", grain: "line", additive: true, allowedPopulations: ["sales"], requiredControls: [], definition }], methods: ["aggregate"], limitations: [] });
  assert.ok(brief.includes(definition));
  assert.match(brief, /分页/);
});

test("大量未标对象的控制依据及方法检查仍能完整分页，不塞入一个超大总体组", () => {
  const source = result(180); source.objects = []; source.facts.forEach((fact) => { fact.objectIds = []; });
  source.methods[0].checks = Array.from({ length: 120 }, (_, i) => ({ name: "参与样本", status: "performed", result: `第${i}个实际控制对照：${"需要保留的完整可核查说明".repeat(10)}` }));
  const stored = createQaResult("controlled", source);
  const ids = new Set<string>(), checks = new Set<string>(); let cursor: string | undefined;
  do {
    const page = pageQaResult(stored, { cursor });
    assert.ok(JSON.stringify(page).length <= 16000);
    page.groups.forEach((group) => { group.facts.forEach((fact) => ids.add(fact.id)); group.checks?.forEach((check) => checks.add(check.result)); });
    page.methods.forEach((method) => method.checks?.forEach((check) => checks.add(check.result)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 180); assert.equal(checks.size, 120);
});

test("全量结果可按真实指标排序，尾部最大值先读；续页不漏且游标保留排序", () => {
  const stored = createQaResult("ranking", result(151));
  const first = pageQaResult(stored, { pageSize: 3, orderBy: { metric: "amount", direction: "desc" } });
  assert.equal(first.groups[0].facts[0].id, "v150");
  const next = pageQaResult(stored, { cursor: first.nextCursor!, pageSize: 3 });
  assert.equal(next.groups[0].facts[0].id, "v147");
  assert.throws(() => pageQaResult(stored, { cursor: first.nextCursor!, orderBy: { metric: "amount", direction: "asc" } }), /排序|游标/);
  assert.throws(() => pageQaResult(stored, { orderBy: { metric: "invented_metric" } }), /指标/);
});
