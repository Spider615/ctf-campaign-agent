import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import type { AnalyticsDataset, SalesRow } from "../app/lib/analytics/types.ts";
import type { AnalysisAggregateCell, AnalysisDataSession, AnalysisDraft, AnalysisOperationRequest, AnalysisOperationResult, AnalysisScope, AnalysisTask } from "../app/lib/analytics/analysis-v2-types.ts";

const before = { start: "2025-08-01", end: "2025-08-01" };
const after = { start: "2025-08-02", end: "2025-08-02" };
function row(values: Partial<SalesRow> = {}): SalesRow {
  return { lineId: crypto.randomUUID(), date: after.start, store: "A", category: "金", netSales: 100, quantity: 1, orderId: "1", region: "北", city: null, sku: null, memberId: null, memberSegment: null, campaignId: null, cost: null, weightGrams: null, ...values };
}
function dataset(rows: SalesRow[]): AnalyticsDataset {
  return { schema: "analytics-dataset/v1", id: "fixture", version: "immutable-1", name: "模拟经营", provenance: "sample", currency: "CNY", createdAt: "2026-10-13T00:00:00Z", rows, rules: [], sourceFiles: [], mappings: { sales: {}, campaigns: {} }, minDate: before.start, maxDate: after.end, warnings: [] };
}
async function setup(rows: SalesRow[], filters: AnalysisScope["filters"] = {}) {
  const snapshot = await import("../app/lib/analytics/analysis-v2-snapshot.ts").catch(() => null);
  const operations = await import("../app/lib/analytics/analysis-v2-operations.ts").catch(() => null);
  assert.ok(snapshot && operations, "通用快照和计算模块尚未实现");
  const session = await snapshot.createSnapshotAnalysisProvider(dataset(rows)).open();
  return { session, operations: operations.createAnalysisOperations(session, { filters }) };
}
function request(values: Partial<AnalysisOperationRequest> = {}): AnalysisOperationRequest {
  return { needIds: ["need-1"], purpose: "核对经营差异", method: "aggregate", scope: { period: after, population: "sales", filters: {} }, metrics: ["amount"], ...values };
}
function fact(result: AnalysisOperationResult, metric: string, label?: string) {
  const value = result.facts.find((f) => f.metricId === metric && (!label || f.label.includes(label)));
  assert.ok(value, `应有 ${metric} ${label ?? ""} 的真实事实`);
  return value;
}

test("汇总逐行按分、订单按门店和单号去重，缺失不补零", async () => {
  const f = await setup([row({ netSales: 1.005, weightGrams: 2 }), row({ store: "B", netSales: 2.005, weightGrams: null })]);
  const result = await f.operations.execute(request({ metrics: ["amount", "orders", "grams", "rows", "stores"] }));
  assert.equal(result.status, "completed"); assert.equal(fact(result, "amount").value, 3.02);
  assert.equal(fact(result, "orders").value, 2); assert.equal(fact(result, "grams").value, null);
  assert.equal(fact(result, "stores").value, 2); assert.equal(fact(result, "rows").value, 2);
  assert.ok(result.frames.every((v) => v.snapshotId === f.session.snapshotId && v.datasetVersion === "immutable-1"));
  assert.ok(result.methods[0].checks.some((v) => v.status === "performed"));
  await f.session.close();
});

test("分组概览优先交付主要经营样本，完整小样本与缺失值仍保留", async () => {
  const f = await setup([row({ campaignId: "A-小样本", orderId: "small", netSales: 5 }), row({ campaignId: "Z-主要样本", orderId: "large", netSales: 2000 })]);
  try {
    const result = await f.operations.execute(request({ by: ["offer"], metrics: ["amount", "orders"] }));
    const { analysisEvidencePage } = await import("../agent/analytics-evidence-context.ts");
    const page = analysisEvidencePage(result, { limit: 2, includeParents: false });
    assert.equal(page.objects[0].value, "Z-主要样本");
    assert.equal(page.facts.find((value) => value.metricId === "amount")!.value, 2000);
    assert.equal(result.methods[0].groupCount, 2);
    assert.ok(result.facts.some((value) => value.value === 5));
  } finally { await f.session.close(); }
});

test("同范围汇总缩窄指标复用原事实，改变范围仍重新计算", async () => {
  const f = await setup([row({ netSales: 100, quantity: 2 })]);
  try {
    const original = await f.operations.execute(request({ metrics: ["amount", "quantity"] }));
    const reused = await f.operations.execute(request({ metrics: ["amount"], purpose: "改用原金额回答另一事项", needIds: ["need-2"] }));
    assert.equal(reused.cached, true);
    assert.equal(reused.operationId, original.operationId);
    assert.deepEqual(reused.facts, original.facts);
    assert.deepEqual(reused.needIds, ["need-2"]);
    const changed = await f.operations.execute(request({ scope: { period: before, population: "sales", filters: {} } }));
    assert.notEqual(changed.operationId, original.operationId);
    assert.deepEqual(changed.frames[0].scope.period, before);
  } finally { await f.session.close(); }
});

test("未支持的指标组合不阻断其中可计算指标的后续汇总", async () => {
  const f = await setup([row({ netSales: 100 })]);
  try {
    const unsupported = await f.operations.execute(request({ metrics: ["amount", "profit"] }));
    assert.equal(unsupported.status, "unsupported");
    const supported = await f.operations.execute(request());
    assert.equal(supported.status, "completed");
    assert.equal(fact(supported, "amount").value, 100);
  } finally { await f.session.close(); }
});

test("全分组扫描优先交付偏离候选，第一页也保留全量参照及派生父链", async () => {
  const f = await setup([row({ store: "A", netSales: 1000 }), row({ store: "B", netSales: 100 }), row({ store: "C", netSales: 100 })]);
  try {
    const scanned = await f.operations.execute(request({ method: "scan", by: ["store"] }));
    assert.equal(scanned.methods[0].groupCount, 3);
    assert.equal(scanned.facts[0].metricId, "amount.relative_deviation");
    assert.equal(scanned.facts[0].value, 150);
    assert.equal(scanned.objects.find((object) => object.id === scanned.facts[0].objectIds[0])?.value, "A");
    const { analysisEvidencePage } = await import("../agent/analytics-evidence-context.ts");
    const page = analysisEvidencePage(scanned, { limit: 1 });
    assert.equal(page.paging.totalFacts, scanned.facts.length);
    assert.ok(page.facts.some((item) => item.value === 1200), "全范围金额保留为候选偏离的真实父事实");
    assert.equal(page.directory[0].groupCount, 3);
  } finally { await f.session.close(); }
});

test("普通订单扫描读取完整分组和父组去重汇总，不展开逐单也不相加跨货类订单", async () => {
  const { createSnapshotAnalysisProvider } = await import("../app/lib/analytics/analysis-v2-snapshot.ts");
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const session = await createSnapshotAnalysisProvider(dataset([row({ store: "A", orderId: "shared", category: "金", netSales: 100 }), row({ store: "A", orderId: "shared", category: "钻", netSales: 50 }), row({ store: "B", orderId: "shared", category: "金", netSales: 80 })])).open();
  const reads: Array<Array<string>> = [];
  const observed = { ...session, async aggregate(input: Parameters<typeof session.aggregate>[0], signal?: AbortSignal) { reads.push(input.by); return session.aggregate(input, signal); } };
  try {
    const scanned = await createAnalysisOperations(observed, { filters: {} }).execute(request({ method: "scan", by: ["category"], metrics: ["orders", "amount_per_order"] }));
    assert.equal(scanned.methods[0].groupCount, 2);
    assert.equal(fact(scanned, "orders", "父组").value, 2);
    assert.equal(fact(scanned, "amount_per_order", "父组").value, 115);
    const gold = scanned.objects.find((object) => object.value === "金")!;
    const diamond = scanned.objects.find((object) => object.value === "钻")!;
    assert.equal(scanned.facts.find((item) => item.metricId === "orders" && item.objectIds.includes(gold.id))!.value, 2);
    assert.equal(scanned.facts.find((item) => item.metricId === "orders" && item.objectIds.includes(diamond.id))!.value, 1);
    assert.deepEqual(reads, [["category"], []]);
  } finally { await session.close(); }
});

test("全店扫描的大量派生事实计算保持可交互耗时，完整保留订单与父组依据", async () => {
  const f = await setup(Array.from({ length: 6000 }, (_, index) => row({ store: `模拟门店${index}`, orderId: "同号", netSales: 100, quantity: 1, weightGrams: 1 })));
  try {
    const started = performance.now();
    const scanned = await f.operations.execute(request({ method: "scan", by: ["store"], metrics: ["amount", "orders", "amount_per_order", "quantity", "grams"] }));
    const elapsed = performance.now() - started;
    assert.equal(scanned.methods[0].groupCount, 6000);
    assert.equal(fact(scanned, "orders", "父组").value, 6000);
    assert.equal(fact(scanned, "amount_per_order", "父组").value, 100);
    assert.ok(scanned.facts.length > 100000);
    assert.ok(elapsed < 10000, `计算耗时 ${Math.round(elapsed)}ms，不能按每个派生事实重复遍历全部已生成事实`);
  } finally { await f.session.close(); }
});

test("缺失维度映射合并原始分组时保留准确订单去重，不把共享订单相加", async () => {
  const { createSnapshotAnalysisProvider } = await import("../app/lib/analytics/analysis-v2-snapshot.ts");
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const session = await createSnapshotAnalysisProvider(dataset([row({ category: " ", netSales: 100 }), row({ category: "", netSales: 50 }), row({ store: "B", category: "银", netSales: 80 })])).open();
  let expanded = false;
  const source = { ...session, async aggregate(input: Parameters<typeof session.aggregate>[0], signal?: AbortSignal) {
    if (input.by.includes("order")) expanded = true;
    const cells = await session.aggregate(input, signal);
    if (input.by.length === 1 && input.by[0] === "category") return cells.flatMap((cell) => cell.dimensions.category === undefined ? [{ ...cell, rows: 1, amount: 100, quantity: 1 }, { ...cell, rows: 1, amount: 50, quantity: 1 }] : [cell]);
    return cells;
  } };
  try {
    const result = await createAnalysisOperations(source, { filters: {} }).execute(request({ method: "scan", by: ["category"], metrics: ["orders", "amount_per_order"] }));
    assert.equal(expanded, true);
    assert.equal(result.methods[0].groupCount, 2);
    const unknown = result.objects.find((object) => object.value === "")!;
    assert.equal(result.facts.find((item) => item.metricId === "orders" && item.objectIds.includes(unknown.id))!.value, 1);
    assert.equal(result.facts.find((item) => item.metricId === "amount_per_order" && item.objectIds.includes(unknown.id))!.value, 150);
  } finally { await session.close(); }
});

test("普通聚合仅在空维度分组被合并时回退精确订单集合，仍保留共享订单", async () => {
  const f = await setup([row()]); const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  let exactReads = 0;
  const cells: AnalysisAggregateCell[] = [100, 50].map((amount) => ({ dimensions: {}, rows: 1, amount, quantity: 1, grams: null, profit: null, tag_amount: null, orders: 1, stores: 1 }));
  const session: AnalysisDataSession = { ...f.session, aggregate: async () => cells, aggregateWithOrderIds: async () => { exactReads++; return cells.map((cell) => ({ ...cell, orderIds: ["A/1"] })); } };
  const result = await createAnalysisOperations(session, { filters: {} }).execute(request({ by: ["category"], metrics: ["amount", "orders", "amount_per_order"] }));
  assert.equal(exactReads, 1); assert.equal(fact(result, "amount").value, 150); assert.equal(fact(result, "orders").value, 1); assert.equal(fact(result, "amount_per_order").value, 150);
  await f.session.close();
});

test("普通汇总直接使用所需分组粒度，复合订单计数不要求展开逐单明细", async () => {
  const f = await setup([row({ store: "A", category: "金", orderId: "同单", netSales: 50 }), row({ store: "A", category: "石", orderId: "同单", netSales: 50 }), row({ store: "B", category: "金", orderId: "同单", netSales: 200 })]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const reads: Array<{ by: string[]; count: number }> = [];
  const session = { ...f.session, async aggregate(query: Parameters<AnalysisDataSession["aggregate"]>[0]) { const cells = await f.session.aggregate(query); reads.push({ by: query.by, count: cells.length }); return cells; }, aggregateWithOrderIds: async () => { assert.fail("各分组独立去重的汇总不应读取全量订单集合"); } };
  const operations = createAnalysisOperations(session, { filters: {} });
  const total = await operations.execute(request({ metrics: ["amount", "orders", "stores"] }));
  assert.equal(fact(total, "amount").value, 300); assert.equal(fact(total, "orders").value, 2); assert.equal(fact(total, "stores").value, 2);
  assert.deepEqual(reads[0], { by: [], count: 1 }, "整体汇总只读取一个聚合单元，不传每个订单");
  const grouped = await operations.execute(request({ metrics: ["amount", "orders", "stores"], by: ["category"] }));
  assert.deepEqual(reads[1], { by: ["category"], count: 2 });
  assert.deepEqual(grouped.facts.filter((item) => item.metricId === "orders").map((item) => item.value).sort(), [1, 2]);
  await f.session.close();
});

test("共同门店比较排除非交集门店，差额与百分比有派生父事实", async () => {
  const f = await setup([row({ date: before.start, netSales: 100 }), row({ date: before.start, store: "B", netSales: 1000 }), row({ netSales: 200 }), row({ store: "C", netSales: 3000 })]);
  const result = await f.operations.execute(request({ method: "compare", reference: { period: before, population: "sales", filters: {} }, commonStores: true }));
  assert.equal(fact(result, "amount", "目标").value, 200); assert.equal(fact(result, "amount", "参照").value, 100);
  assert.equal(fact(result, "amount.delta").value, 100); assert.equal(fact(result, "amount.relative_change").value, 100);
  assert.ok(fact(result, "amount.delta").derivation); assert.ok(result.methods[0].controls.includes("store"));
  assert.ok(result.methods[0].checks.some((v) => /共同门店/.test(v.name) && v.status === "performed"));
});

test("按品类控制的标准化比较不会把高价品类占比变化当成涨价", async () => {
  const f = await setup([row({ date: before.start, category: "低价", netSales: 50, quantity: 5 }), row({ date: before.start, category: "高价", netSales: 150, quantity: 5 }), row({ category: "低价", netSales: 20, quantity: 2 }), row({ category: "高价", netSales: 240, quantity: 8 })]);
  const result = await f.operations.execute(request({ method: "compare", reference: { period: before, population: "sales", filters: {} }, controls: ["category"] }));
  assert.equal(fact(result, "amount.delta").value, 60);
  assert.equal(fact(result, "amount.standardized_delta").value, 0);
  assert.ok(result.methods[0].checks.some((c) => /标准化/.test(c.name) && c.status === "performed"));
});

test("数量、价格、结构贡献相加重构金额变化", async () => {
  const cases = [
    { a: [100, 10], b: [200, 20], want: [100, 0, 0] },
    { a: [100, 10], b: [150, 10], want: [0, 50, 0] },
  ];
  for (const c of cases) {
    const f = await setup([row({ date: before.start, netSales: c.a[0], quantity: c.a[1] }), row({ netSales: c.b[0], quantity: c.b[1] })]);
    const result = await f.operations.execute(request({ method: "decompose", reference: { period: before, population: "sales", filters: {} }, breakdown: "category" }));
    assert.equal(result.status, "completed");
    assert.deepEqual(["quantity", "price", "mix"].map((x) => fact(result, `amount.${x}_contribution`).value), c.want);
    assert.equal(fact(result, "amount.decomposed_change").value, c.b[0] - c.a[0]);
    assert.ok(fact(result, "amount.decomposed_change").derivation);
  }
  const f = await setup([row({ date: before.start, category: "低价", netSales: 50, quantity: 5 }), row({ date: before.start, category: "高价", netSales: 150, quantity: 5 }), row({ category: "低价", netSales: 20, quantity: 2 }), row({ category: "高价", netSales: 240, quantity: 8 })]);
  const result = await f.operations.execute(request({ method: "decompose", reference: { period: before, population: "sales", filters: {} }, breakdown: "category" }));
  assert.ok(Math.abs(fact(result, "amount.mix_contribution").value! - 60) < 1e-10);
  assert.equal(fact(result, "amount.price_contribution").value, 0);
});

test("净销售拆解真实销售与退货贡献，不对有符号数量套量价公式", async () => {
  const f = await setup([row({ date: before.start, netSales: 200 }), row({ date: before.start, quantity: -1, netSales: -10 }), row({ netSales: 300 }), row({ quantity: -1, netSales: -100 })]);
  const result = await f.operations.execute(request({ method: "decompose", scope: { period: after, population: "net", filters: {} }, reference: { period: before, population: "net", filters: {} } }));
  assert.equal(fact(result, "amount.sales_contribution").value, 100); assert.equal(fact(result, "amount.returns_contribution").value, -90);
  assert.equal(fact(result, "amount.decomposed_change").value, 10);
  assert.ok(result.frames.some((v) => v.scope.population === "returns"));
});

test("扫描读取全部分组并按相对父组偏离排序，金额前列不能替代范围", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => [row({ date: before.start, store: `G${i}`, netSales: 100 }), row({ store: `G${i}`, netSales: i === 24 ? 140 : 95 })]).flat();
  const f = await setup(rows);
  const result = await f.operations.execute(request({ method: "scan", breakdown: "store", reference: { period: before, population: "sales", filters: {} } }));
  assert.equal(result.methods[0].groupCount, 25);
  const deviations = result.facts.filter((v) => v.metricId === "amount.relative_deviation"); assert.equal(deviations.length, 25);
  assert.ok(Math.abs(deviations[0].value! - 43.2) < 1e-9);
  const top = result.objects.find((v) => deviations[0].objectIds.includes(v.id)); assert.equal(top?.value, "G24");
});

test("全局最大店检查实际剔除大店后可以反转表面增长", async () => {
  const f = await setup([row({ date: before.start, netSales: 1000 }), row({ date: before.start, store: "B", netSales: 100 }), row({ netSales: 2000 }), row({ store: "B", netSales: 80 })]);
  const result = await f.operations.execute(request({ method: "robustness", check: "largest_store", reference: { period: before, population: "sales", filters: {} } }));
  assert.equal(fact(result, "amount.delta", "原范围").value, 980); assert.equal(fact(result, "amount.delta", "剔除后").value, -20);
  assert.ok(result.methods[0].checks.some((v) => /全局最大门店/.test(v.name) && v.status === "performed"));
  assert.ok(result.objects.some((v) => v.dimension === "store" && v.value === "A"));
});

test("最大订单使用筛选内成交部分而非行金额，去除后重新计算", async () => {
  const f = await setup([row({ netSales: 80, orderId: "big" }), row({ netSales: 80, orderId: "big" }), row({ netSales: 100, orderId: "small" })]);
  const result = await f.operations.execute(request({ method: "robustness", check: "largest_order" }));
  assert.equal(fact(result, "amount", "剔除后").value, 100);
  assert.ok(result.methods[0].checks.some((v) => /成交部分/.test(v.result)));
  assert.ok(!JSON.stringify(result.objects).includes("big"));
});

test("订单分布先重构同店订单，缺单号行明确排除而不当整单", async () => {
  const f = await setup([row({ netSales: 50 }), row({ netSales: 50 }), row({ store: "B", netSales: 300 }), row({ orderId: null, netSales: 999 })]);
  const result = await f.operations.execute(request({ method: "robustness", check: "order_distribution" }));
  assert.equal(result.status, "completed"); assert.equal(fact(result, "amount.p50").value, 100); assert.equal(fact(result, "amount.p90").value, 300);
  assert.equal(fact(result, "rows.excluded").value, 1);
  assert.ok(result.limitations.some((v) => /缺.*单号|缺.*订单/.test(v)));
});

test("缺复合订单标识时先检查总体，不展开全量订单后才拒绝最大对象检查", async () => {
  const f = await setup([row(), row({ orderId: null })]); const reads: string[][] = [];
  const original = f.session.aggregate;
  f.session.aggregate = async (query, signal) => { reads.push(query.by); return original(query, signal); };
  const result = await f.operations.execute(request({ method: "robustness", check: "largest_order" }));
  assert.equal(result.status, "unsupported"); assert.match(result.limitations.join(" "), /缺少.*订单|缺.*标识/);
  assert.deepEqual(reads, [[]]);
});

test("数据库订单分布直接使用完整样本摘要，分位数与逐单重构一致", async () => {
  const f = await setup([row({ netSales: 50 }), row({ netSales: 50 }), row({ store: "B", netSales: 300 }), row({ orderId: null, netSales: 999 })]);
  const input = request({ method: "robustness", check: "order_distribution", metrics: ["amount", "orders", "amount_per_order"] });
  const expected = await f.operations.execute(input);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts"); let calls = 0;
  const session: AnalysisDataSession = { ...f.session,
    aggregate: async () => { assert.fail("原生分布摘要不应传回逐单分组"); },
    orderDistribution: async (query, signal) => {
      calls++; assert.deepEqual(query.scope, input.scope); assert.deepEqual(query.metrics, ["amount", "amount_per_order", "orders"]); assert.equal(signal?.aborted, false);
      return { sampleRows: 3, excludedRows: 1, orderCount: 2, quantiles: { amount: { p50: 100, p90: 300, p99: 300 }, amount_per_order: { p50: 100, p90: 300, p99: 300 }, orders: { p50: 1, p90: 1, p99: 1 } } };
    },
  };
  const operations = createAnalysisOperations(session, { filters: {} });
  const actual = await operations.execute(input, new AbortController().signal);
  assert.deepEqual(actual.facts.map(({ metricId, value, comparisonRole, comparisonControls }) => ({ metricId, value, comparisonRole, comparisonControls })), expected.facts.map(({ metricId, value, comparisonRole, comparisonControls }) => ({ metricId, value, comparisonRole, comparisonControls })));
  assert.equal(actual.methods[0].sampleRows, 3); assert.equal(actual.methods[0].groupCount, 2); assert.deepEqual(actual.limitations, expected.limitations);
  await operations.execute(input); assert.equal(calls, 1);
});

test("控制层扫描保留订单集合去重，紧凑读取与逐单算法一致且不向公开证据暴露单号", async () => {
  const f = await setup([row({ store: "A", category: "金", orderId: "private-shared", netSales: 50 }), row({ store: "A", category: "银", orderId: "private-shared", netSales: 20 }), row({ store: "B", category: "金", netSales: 100 }), row({ store: "B", category: "银", netSales: 10 }), row({ store: "C", category: "金", netSales: 10 }), row({ store: "C", category: "银", netSales: 15 })]);
  const input = request({ method: "scan", by: ["store"], controls: ["category"], metrics: ["amount", "orders", "amount_per_order"] });
  const expected = await f.operations.execute(input); let nativeCalls = 0;
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const session: AnalysisDataSession = { ...f.session, aggregate: async () => { assert.fail("集合验证通过后不应再展开逐单"); },
    aggregateWithOrderIds: async (query) => {
      nativeCalls++; assert.ok(!query.by.includes("order"));
      const original = await f.session.aggregate({ ...query, by: [...query.by, "order"] });
      const groups = new Map<string, typeof original>();
      for (const cell of original) { const key = JSON.stringify(query.by.map((dimension) => cell.dimensions[dimension])); const cells = groups.get(key) ?? []; cells.push(cell); groups.set(key, cells); }
      return [...groups.values()].map((cells) => ({ ...cells[0], dimensions: Object.fromEntries(query.by.map((dimension) => [dimension, cells[0].dimensions[dimension]])), rows: cells.reduce((n, cell) => n + cell.rows, 0), amount: cells.reduce((n, cell) => n + cell.amount!, 0), quantity: cells.reduce((n, cell) => n + cell.quantity!, 0), orderIds: cells.map((cell) => cell.dimensions.order ?? null) }));
    },
  };
  const result = await createAnalysisOperations(session, { filters: {} }).execute(input);
  assert.equal(nativeCalls, 1); assert.equal(fact(result, "orders", "父组").value, 3);
  assert.deepEqual(result.facts.map(({ metricId, label, value }) => ({ metricId, label, value })), expected.facts.map(({ metricId, label, value }) => ({ metricId, label, value })));
  assert.ok(!JSON.stringify(result).includes("private-shared")); assert.ok(!JSON.stringify(result).includes("orderIds"));
});

test("活动控制层可用完整订单集合省去非必需门店分组，共同门店比较仍保留门店层", async () => {
  const f = await setup([
    row({ store: "A", campaignId: "O1", category: "金", orderId: "shared", netSales: 50 }), row({ store: "A", campaignId: "O2", category: "金", orderId: "shared", netSales: 20 }),
    row({ store: "B", campaignId: "O1", category: "金", orderId: "only", netSales: 100 }), row({ store: "C", campaignId: "O2", category: "金", orderId: "only", netSales: 10 }),
    row({ store: "A", campaignId: "O1", category: "银", orderId: "shared", netSales: 10 }), row({ store: "A", campaignId: "O2", category: "银", orderId: "shared", netSales: 5 }),
  ]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  try {
    for (const commonStores of [false, true]) for (const method of ["scan", "compare"] as const) {
      const input = request({ method, by: method === "scan" ? ["offer"] : ["category"], controls: ["category"], metrics: ["amount", "orders", "amount_per_order"], commonStores,
        ...(method === "compare" ? { scope: { period: after, population: "sales", filters: { offers: ["O1"] } }, reference: { period: after, population: "sales", filters: { offers: ["O2"] } } } : {}),
      });
      const expected = await f.operations.execute(input); let reads = 0;
      const session: AnalysisDataSession = { ...f.session, aggregate: async () => { assert.fail("已核对的集合不应展开逐单"); }, aggregateWithOrderIds: async (query) => {
        reads++; assert.equal(query.by.includes("store"), commonStores, "只有需要共同门店对齐才保留额外门店层");
        const original = await f.session.aggregate({ ...query, by: [...new Set([...query.by, "store" as const, "order" as const])] });
        const grouped = new Map<string, typeof original>();
        for (const cell of original) { const key = JSON.stringify(query.by.map((dimension) => cell.dimensions[dimension])); const cells = grouped.get(key) ?? []; cells.push(cell); grouped.set(key, cells); }
        return [...grouped.values()].map((cells) => ({ ...cells[0], dimensions: Object.fromEntries(query.by.map((dimension) => [dimension, cells[0].dimensions[dimension]])), rows: cells.reduce((value, cell) => value + cell.rows, 0), amount: cells.reduce((value, cell) => value + cell.amount!, 0), quantity: cells.reduce((value, cell) => value + cell.quantity!, 0), orderIds: [...new Set(cells.map((cell) => cell.dimensions.order ?? null))] }));
      } };
      const actual = await createAnalysisOperations(session, { filters: {} }).execute(input);
      assert.ok(reads > 0);
      const values = (result: AnalysisOperationResult) => result.facts.map(({ metricId, label, value }) => ({ metricId, label, value }));
      assert.deepEqual(values(actual), values(expected));
      assert.equal(actual.methods[0].sampleRows, expected.methods[0].sampleRows); assert.equal(actual.methods[0].groupCount, expected.methods[0].groupCount);
      assert.ok(!JSON.stringify(actual).includes("shared"));
    }
  } finally { await f.session.close(); }
});

test("完整控制层全店扫描一次汇总其余组，订单集合规模不会乘以门店数", async () => {
  const f = await setup([row({ weightGrams: 1 })]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const cells = Array.from({ length: 800 }, (_, index) => {
    const orderIds = Array.from({ length: 80 }, (_, order) => `private-store-${index}/order-${order}`);
    return ["金", "银"].map((category) => ({ dimensions: { store: `S${index}`, category }, rows: 80, amount: category === "金" ? 8000 : 4000, quantity: 80, grams: 80, profit: null, tag_amount: null, orders: 80, stores: 1, orderIds }));
  }).flat();
  const session: AnalysisDataSession = { ...f.session, aggregate: async () => { assert.fail("已核对的集合不应展开逐单"); }, aggregateWithOrderIds: async () => cells };
  const start = performance.now();
  const result = await createAnalysisOperations(session, { filters: {} }).execute(request({ method: "scan", by: ["store"], controls: ["category"], metrics: ["amount", "orders", "amount_per_order"] }));
  assert.equal(result.status, "completed"); assert.equal(result.methods[0].groupCount, 800); assert.equal(result.methods[0].sampleRows, 128000);
  assert.equal(fact(result, "orders", "父组").value, 64000);
  const deviations = result.facts.filter((value) => value.metricId === "amount_per_order.relative_deviation");
  assert.equal(deviations.length, 800); assert.ok(deviations.every((value) => value.value === 0));
  assert.ok(performance.now() - start < 4000, "控制层扫描不应反复遍历所有其余门店的订单");
  await f.session.close();
});

test("控制层充分统计量保留跨子组同单、缺指标和缺控制值，与直接其余组对照一致", async () => {
  const f = await setup([row({ campaignId: "O1", weightGrams: 1 })]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const cells: AnalysisAggregateCell[] = ["O1", "O2", "O3"].flatMap((offer, index) => ["A", "B"].flatMap((store) => ["金", "银"].map((category) => ({
    dimensions: { store, offer, category }, rows: 2, amount: (index + 1) * (category === "金" ? 100 : 50), quantity: 2, grams: 2, profit: null, tag_amount: null, orders: 2, stores: 1,
    // 同单可以跨优惠与控制层；数组中重复身份也不能重复计数。
    orderIds: [`${store}/shared`, `${store}/${offer}/only`, `${store}/shared`],
  }))));
  cells.push({ dimensions: { store: "A", offer: "O1" }, rows: 1, amount: null, quantity: null, grams: null, profit: null, tag_amount: null, orders: null, stores: 1, orderIds: [null] });
  const session: AnalysisDataSession = { ...f.session, aggregateWithOrderIds: async () => cells };
  const input = request({ method: "scan", by: ["offer"], controls: ["category"], metrics: ["amount", "orders", "amount_per_order"] });
  const optimized = await createAnalysisOperations(session, { filters: {} }).execute(input);
  // 每个优惠均包含 A/B，原始共同门店算法不会删行，可作为直接逐组计算的独立对照。
  const direct = await createAnalysisOperations(session, { filters: {} }).execute({ ...input, commonStores: true });
  const inspect = (result: AnalysisOperationResult) => result.facts.map((value) => ({ metric: value.metricId, label: value.label, objects: scanObjects(result, value), value: value.value }));
  assert.deepEqual(inspect(optimized), inspect(direct));
  assert.equal(fact(optimized, "amount", "父组").value, null); assert.equal(fact(optimized, "orders", "父组").value, null);
  assert.ok(optimized.facts.filter((value) => value.metricId === "amount_per_order.relative_deviation").every((value) => value.value !== null));
  assert.ok(optimized.methods[0].checks.some((check) => check.name === "参与样本" && /参照参与 16 \/ 17 行/.test(check.result)));
  await f.session.close();
});

test("控制层扫描计算期间可取消，分批让出事件循环后不返回迟到的完整结果", async () => {
  const f = await setup([row()]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const cells = Array.from({ length: 1000 }, (_, index) => ({ dimensions: { store: `S${index}`, category: "金" }, rows: 100, amount: 100, quantity: 100, grams: null, profit: null, tag_amount: null, orders: 100, stores: 1, orderIds: Array.from({ length: 100 }, (_, order) => `${index}/${order}`) }));
  let closed = false;
  const session: AnalysisDataSession = { ...f.session, aggregateWithOrderIds: async () => cells, close: async () => { closed = true; await f.session.close(); } };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(createAnalysisOperations(session, { filters: {} }).execute(request({ method: "scan", by: ["store"], controls: ["category"], metrics: ["amount_per_order"] }), controller.signal), (error: Error) => error.name === "AbortError");
    assert.equal(closed, true);
  } finally { clearTimeout(timer); await f.session.close(); }
});

test("控制层扫描只计算所需字段，未请求的超大毛利不能阻断实收比较", async () => {
  const f = await setup([row({ cost: 1 })]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const cells: AnalysisAggregateCell[] = [100, 200].map((amount, index) => ({ dimensions: { store: `S${index}`, category: "金" }, rows: 1, amount, quantity: 1, grams: null, profit: 1e14, tag_amount: null, orders: 1, stores: 1, orderIds: [`${index}/1`] }));
  const session: AnalysisDataSession = { ...f.session, aggregateWithOrderIds: async () => cells, aggregate: async () => cells };
  const result = await createAnalysisOperations(session, { filters: {} }).execute(request({ method: "scan", by: ["store"], controls: ["category"], metrics: ["amount"] }));
  assert.equal(result.status, "completed"); assert.ok(result.facts.every((value) => value.metricId !== "profit"));
  assert.deepEqual(result.facts.filter((value) => value.metricId === "amount.relative_deviation").map((value) => value.value).sort((a, b) => a! - b!), [-50, 100]);
  await f.session.close();
});

test("克重尺度悬殊时补集保留小正分母，不以总量相减制造缺失", async () => {
  const f = await setup([row({ weightGrams: 1, campaignId: "大" })]);
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const cells: AnalysisAggregateCell[] = [1e12, 0.00001].map((grams, index) => ({ dimensions: { store: "A", category: "金", offer: index ? "小" : "大" }, rows: 1, amount: 100, quantity: 1, grams, profit: null, tag_amount: null, orders: 1, stores: 1, orderIds: [`A/${index}`] }));
  const session: AnalysisDataSession = { ...f.session, aggregate: async () => cells, aggregateWithOrderIds: async () => cells };
  const input = request({ method: "scan", by: ["offer"], controls: ["category"], metrics: ["amount", "grams"] });
  const optimized = await createAnalysisOperations(session, { filters: {} }).execute(input);
  const direct = await createAnalysisOperations(session, { filters: {} }).execute({ ...input, commonStores: true });
  for (const value of optimized.facts.filter((value) => value.metricId === "amount.relative_deviation")) {
    const offer = scanObjects(optimized, value).offer;
    const expected = direct.facts.find((fact) => fact.metricId === value.metricId && scanObjects(direct, fact).offer === offer)!;
    assert.equal(value.value, expected.value);
  }
  await f.session.close();
});

test("替代窗口实际读取另一个授权周期，窗口不同长度不能直接当增长", async () => {
  const f = await setup([row({ date: before.start, netSales: 80 }), row({ netSales: 120 })]);
  const result = await f.operations.execute(request({ method: "robustness", check: "alternative_window", alternative: before }));
  assert.equal(fact(result, "amount", "替代窗口").value, 80);
  assert.ok(result.frames.some((v) => v.scope.period.start === before.start));
});

test("零分母保留 null，无法读取的材料和完整订单能力诚实 unsupported", async () => {
  const f = await setup([row({ date: before.start, netSales: 0 }), row({ orderId: null })]);
  await assert.rejects(f.operations.execute(request({ method: "compare", reference: { period: before, population: "net", filters: {} } })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID");
  const missing = await f.operations.execute(request({ method: "compare", reference: { period: before, population: "sales", filters: {} }, controls: ["material"] }));
  assert.equal(missing.status, "unsupported"); assert.ok(missing.methods[0].checks.every((v) => v.status === "unavailable"));
  const order = await f.operations.execute(request({ method: "robustness", check: "largest_order" })); assert.equal(order.status, "unsupported");
  await assert.rejects(f.operations.execute(request({ scope: { period: before, population: "net", filters: {} }, metrics: ["amount_per_order"] })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID");
  const zero = await f.operations.execute(request({ method: "compare", scope: { period: after, population: "net", filters: {} }, reference: { period: before, population: "net", filters: {} } })); assert.equal(fact(zero, "amount.relative_change").value, null);
});

test("规范化重复操作复用身份与数据，关闭或取消后缓存也不能继续引用", async () => {
  const f = await setup([row({ store: "A" }), row({ store: "B" })]); let reads = 0;
  const original = f.session.aggregate; f.session.aggregate = async (...args) => { reads++; return original(...args); };
  const a = await f.operations.execute(request({ scope: { period: after, population: "sales", filters: { stores: ["B", "A"] } }, metrics: ["rows", "amount"] }));
  const b = await f.operations.execute(request({ scope: { period: after, population: "sales", filters: { stores: ["A", "B", "A"] } }, metrics: ["amount", "rows"], purpose: "再次核对", needIds: ["need-2"] }));
  assert.equal(reads, 1); assert.equal(a.operationId, b.operationId); assert.equal(b.cached, true);
  await f.session.close(); await assert.rejects(f.operations.execute(request({ scope: { period: after, population: "sales", filters: { stores: ["A", "B"] } }, metrics: ["amount", "rows"] })), /快照|关闭|失效/);
});

test("计算与缓存共享不可改写的完整证据，调用方不能污染后续事项", async () => {
  const f = await setup([row({ store: "A", netSales: 100 }), row({ store: "B", netSales: 200 })]);
  try {
    const input = request({ metrics: ["amount", "quantity"], by: ["store"] });
    const first = await f.operations.execute(input);
    assert.throws(() => { first.facts[0].value = 999; }, TypeError);
    assert.throws(() => { first.facts.push(first.facts[0]); }, TypeError);
    assert.throws(() => { first.frames[0].scope.period.start = before.start; }, TypeError);
    assert.throws(() => { first.methods[0].checks[0].result = "伪造检查"; }, TypeError);
    input.needIds.push("need-extra");
    assert.deepEqual(first.needIds, ["need-1"], "封存结果不能冻结或保留调用方的可变事项数组");
    const repeated = await f.operations.execute({ ...input, needIds: ["need-2"], purpose: "再次核对完整依据" });
    const narrower = await f.operations.execute({ ...input, needIds: ["need-3"], metrics: ["amount"] });
    for (const result of [repeated, narrower]) {
      assert.equal(result.cached, true);
      assert.equal(result.facts, first.facts, "缓存不能再完整复制事实图");
      assert.equal(result.methods, first.methods);
      assert.equal(result.frames, first.frames);
      assert.equal(result.objects, first.objects);
      const storeA = result.objects.find((item) => item.dimension === "store" && item.value === "A")!;
      assert.equal(result.facts.find((item) => item.metricId === "amount" && item.objectIds.includes(storeA.id))!.value, 100);
    }
    assert.deepEqual(repeated.needIds, ["need-2"]);
    assert.deepEqual(narrower.needIds, ["need-3"]);
    const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
    const registry = createEvidenceRegistry(); await registry.ingestAsync(first);
    assert.equal(registry.view().facts[0], first.facts[0], "登记已封存证据只核验依赖，不再复制整份图");
    assert.equal(registry.view().facts.length, first.facts.length);
    await registry.ingestAsync(repeated);
    assert.equal(registry.view().facts.length, first.facts.length);
  } finally { await f.session.close(); }
});

test("512MiB堆内完整计算并核验大门店扫描，分页与缓存保留全部事实", () => {
  const replay = spawnSync(process.execPath, ["--max-old-space-size=512", "--experimental-strip-types", new URL("./helpers/analysis-memory-replay.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 45000 });
  assert.equal(replay.status, 0, replay.error?.message ?? replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout.trim()), { groups: 8000, facts: 416015, pageFacts: 12, modelCalls: 0, databaseCalls: 0 });
});

test("计算结果封存期间快照关闭，首次调用也不能返回失效证据", async () => {
  const f = await setup(Array.from({ length: 10000 }, (_, index) => row({ store: `模拟门店${index}` })));
  try {
    const pending = f.operations.execute(request({ by: ["store"] }));
    setTimeout(() => { void f.session.close(); }, 0);
    await assert.rejects(pending, /快照|关闭|失效/);
  } finally { await f.session.close(); }
});

test("硬范围不能被目标、参照或替代周期悄悄扩大", async () => {
  const f = await setup([row(), row({ store: "B" })], { stores: ["A"] });
  await assert.rejects(f.operations.execute(request({ scope: { period: after, population: "sales", filters: { stores: ["B"] } } })), /范围|授权/);
  await assert.rejects(f.operations.execute(request({ method: "compare", reference: { period: before, population: "sales", filters: { stores: ["B"] } } })), /范围|授权/);
  await assert.rejects(f.operations.execute(request({ method: "robustness", check: "alternative_window", alternative: { start: "2024-01-01", end: "2024-01-02" } })), /范围|覆盖/);
  const result = await f.operations.execute(request()); assert.equal(fact(result, "amount").value, 100);
});

test("快照从不可变版本读取，原数据对象后续修改不能污染已打开会话", async () => {
  const { createSnapshotAnalysisProvider } = await import("../app/lib/analytics/analysis-v2-snapshot.ts");
  const source = dataset([row()]); const provider = createSnapshotAnalysisProvider(source); const a = await provider.open();
  source.rows[0].netSales = 999;
  assert.equal((await a.aggregate({ scope: { period: after, population: "sales", filters: {} }, by: [] }))[0].amount, 100);
  const b = await provider.open(); assert.notEqual(a.snapshotId, b.snapshotId); assert.equal(a.datasetVersion, b.datasetVersion);
  assert.ok(!a.capabilities.metrics.some((v) => v.id === "profit")); assert.ok(!a.capabilities.dimensions.includes("material"));
});

test("同窗口按品类控制的全范围扫描剔除价格结构假象", async () => {
  const f = await setup([row({ store: "A", category: "低价", netSales: 20, quantity: 2 }), row({ store: "A", category: "高价", netSales: 240, quantity: 8 }), row({ store: "B", category: "低价", netSales: 80, quantity: 8 }), row({ store: "B", category: "高价", netSales: 60, quantity: 2 })]);
  const result = await f.operations.execute(request({ method: "scan", breakdown: "store", controls: ["category"] }));
  const values = result.facts.filter((v) => v.metricId === "amount.relative_deviation");
  assert.equal(values.length, 2); assert.ok(values.every((v) => v.value === 0));
  assert.ok(result.methods[0].checks.some((v) => /标准化/.test(v.name) && v.status === "performed"));
});

test("净销售共同门店在总体选一次，不能按退货是否存在重新剔除店", async () => {
  const f = await setup([row({ date: before.start, netSales: 100 }), row({ netSales: 150 }), row({ quantity: -1, netSales: -80 })]);
  const result = await f.operations.execute(request({ method: "decompose", scope: { period: after, population: "net", filters: {} }, reference: { period: before, population: "net", filters: {} }, commonStores: true }));
  assert.equal(fact(result, "amount.sales_contribution").value, 50); assert.equal(fact(result, "amount.returns_contribution").value, -80);
  assert.equal(fact(result, "amount.decomposed_change").value, -30);
});

test("订单分母标准化按真实复合订单权重，跨品类总单数仍去重", async () => {
  const f = await setup([row({ date: before.start, category: "低价", netSales: 100, orderId: "same" }), row({ date: before.start, category: "高价", netSales: 300, orderId: "same" }), row({ category: "低价", netSales: 100, orderId: "x" }), row({ category: "高价", netSales: 300, orderId: "x" }), row({ category: "高价", netSales: 300, orderId: "y" })]);
  const result = await f.operations.execute(request({ method: "compare", reference: { period: before, population: "sales", filters: {} }, controls: ["category"], metrics: ["orders", "amount_per_order"] }));
  assert.equal(fact(result, "orders", "目标").value, 2); assert.equal(fact(result, "orders", "参照").value, 1);
  assert.equal(fact(result, "amount_per_order.standardized_delta").value, 0);
});

test("缓存仍挂起时另一个调用的取消立即失效会话，不等待首次查询", async () => {
  const f = await setup([row()]); let entered!: () => void; let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }); const original = f.session.aggregate;
  f.session.aggregate = async (...args) => { entered(); await new Promise<void>((resolve) => { finish = resolve; }); return original(...args); };
  const a = f.operations.execute(request()).catch((error: unknown) => error); await started;
  const controller = new AbortController(); const b = f.operations.execute(request(), controller.signal).catch((error: unknown) => error); controller.abort();
  const result = await Promise.race([b, new Promise((resolve) => setTimeout(() => resolve("still_waiting"), 30))]);
  assert.ok(result instanceof Error && result.name === "AbortError"); finish(); await a;
  assert.throws(() => f.session.assertActive?.(), /快照|失效/);
});

test("五种真实操作的派生证据均可注册，控制分层表达式不伪造关系", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  const f = await setup([row({ date: before.start, netSales: 100 }), row({ date: before.start, store: "B", netSales: 80 }), row({ netSales: 200 }), row({ store: "B", netSales: 60 }), row({ quantity: -1, netSales: -20 })]);
  const registry = createEvidenceRegistry();
  for (const input of [request(), request({ method: "compare", controls: ["category"], reference: { period: before, population: "sales", filters: {} } }), request({ method: "decompose", breakdown: "store", reference: { period: before, population: "sales", filters: {} } }), request({ method: "scan", breakdown: "store", controls: ["category"], reference: { period: before, population: "sales", filters: {} } }), request({ method: "scan", breakdown: "store", controls: ["category"] }), request({ method: "robustness", check: "order_distribution" }), request({ method: "decompose", commonStores: true, scope: { period: after, population: "net", filters: {} }, reference: { period: before, population: "net", filters: {} } })]) {
    const result = await f.operations.execute(input); assert.equal(result.status, "completed"); assert.doesNotThrow(() => registry.ingest(result));
  }
  assert.ok(registry.bundle().facts.length > 20);
});

test("适配器没有声明的方法不能因工具存在而假执行", async () => {
  const f = await setup([row()]); f.session.capabilities.methods = ["aggregate"];
  const result = await f.operations.execute(request({ method: "robustness", check: "largest_store" }));
  assert.equal(result.status, "unsupported"); assert.equal(result.methods[0].status, "unsupported");
});

test("量价结构嵌套分数保持原表达式精度，中间节点不能逐层舍入", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  const pairs = [[2741.86, 19, 3374.39, 18], [8866.88, 16, 3397.9, 6], [8212.68, 16, 4563.98, 7], [1793, 3, 9445.28, 20], [2276.4, 4, 8146.85, 20], [6475.87, 4, 9813.7, 20]];
  const f = await setup(pairs.flatMap(([a, qa, b, qb], i) => [row({ date: before.start, category: String(i), netSales: a, quantity: qa }), row({ category: String(i), netSales: b, quantity: qb })]));
  const result = await f.operations.execute(request({ method: "decompose", breakdown: "category", reference: { period: before, population: "sales", filters: {} } }));
  assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
  assert.ok(Math.abs(fact(result, "amount.decomposed_change").value! - 8375.41) < 1e-8);
});

test("拆解未登记的毛利方法不能完成并悄悄漏掉所求指标", async () => {
  const f = await setup([row({ date: before.start, cost: 50 }), row({ cost: 40 })]);
  const result = await f.operations.execute(request({ method: "decompose", metrics: ["amount", "profit"], reference: { period: before, population: "sales", filters: {} } }));
  assert.equal(result.status, "unsupported"); assert.equal(result.methods[0].status, "unsupported");
});

test("不同长度替代窗口日均使用有单位的真实日历天数父事实", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts"); const f = await setup([row({ date: before.start, netSales: 80 }), row({ netSales: 120 })]);
  const result = await f.operations.execute(request({ method: "robustness", check: "alternative_window", alternative: { start: before.start, end: after.end } }));
  assert.equal(fact(result, "amount.daily").value, 120);
  assert.ok(result.facts.some((v) => v.metricId === "period_days" && v.value === 2 && v.unit === "日"));
  assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
});

test("标准化反事实保留完整计算精度，不为展示舍入改变可追溯事实", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts"); const f = await setup([row({ date: before.start, netSales: 1410.39, quantity: 26 }), row({ netSales: 7156.61, quantity: 18 })]);
  const result = await f.operations.execute(request({ method: "compare", controls: ["category"], reference: { period: before, population: "sales", filters: {} } }));
  assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
  assert.equal(fact(result, "amount.standardized_target").value, 10337.325555555556);
});

test("空共同店或共同分层的unsupported保留实际已读取范围，注册不能丢失检查", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  for (const method of ["compare", "scan", "decompose"] as const) {
    for (const population of method === "decompose" ? ["sales", "net"] as const : ["sales"] as const) {
      const f = await setup([row({ date: before.start, store: "A" }), row({ store: "B" })]);
      const result = await f.operations.execute(request({ method, commonStores: true, breakdown: "category", scope: { period: after, population, filters: {} }, reference: { period: before, population, filters: {} } }));
      assert.equal(result.status, "unsupported"); assert.equal(result.methods[0].status, "unsupported");
      assert.equal(result.frames.length, 2); assert.deepEqual(result.frames.map((v) => v.scope.period), [after, before]);
      assert.ok(result.methods[0].checks.some((v) => v.status === "performed"));
      assert.equal(result.facts.length, 0); assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
    }
  }
  for (const method of ["compare", "scan", "decompose"] as const) {
    const f = await setup([row({ date: before.start, category: "甲" }), row({ category: "乙" })]);
    const result = await f.operations.execute(request({ method, controls: ["category"], breakdown: "category", reference: { period: before, population: "sales", filters: {} } }));
    assert.equal(result.status, "unsupported"); assert.equal(result.frames.length, 2); assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
  }
  const f = await setup([row({ date: before.start }), row()]);
  for (const emptySide of ["scope", "reference"] as const) {
    const input = request({ method: "compare", reference: { period: before, population: "sales", filters: {} } });
    input[emptySide] = { ...input[emptySide]!, filters: { stores: ["不存在"] } };
    const result = await f.operations.execute(input); assert.equal(result.status, "unsupported"); assert.equal(result.frames.length, 2);
    assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
  }
});

async function priceMixOperations(dimensions: AnalysisDataSession["capabilities"]["dimensions"] = ["store", "category", "material"], onRead?: () => void) {
  const { analysisMetricDefinitions, createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const session: AnalysisDataSession = { snapshotId: "mix-snapshot", datasetVersion: "mix-v1", capabilities: { mode: "database", name: "结构反转合成数据", provenance: "sample", currency: "CNY", coverage: { start: before.start, end: after.end }, dimensions, metrics: analysisMetricDefinitions("CNY", ["amount", "quantity", "grams", "rows", "stores", "amount_per_gram"], "database"), methods: ["aggregate", "compare"], limitations: [] },
    async aggregate(query) { onRead?.(); return (query.scope.period.start === after.start ? [{ amount: 9000, grams: 90 }, { amount: 100, grams: 10 }] : [{ amount: 1100, grams: 10 }, { amount: 990, grams: 90 }]).map((value, i) => ({ dimensions: { store: "门店", category: `层${i}`, material: "材料" }, rows: 1, quantity: value.grams, profit: null, tag_amount: null, orders: null, stores: 1, ...value })).filter((cell) => !query.scope.filters.categories?.length || query.scope.filters.categories.includes(cell.dimensions.category)).filter((cell) => !query.scope.filters.materials?.length || query.scope.filters.materials.includes(cell.dimensions.material)); }, async close() {} };
  return createAnalysisOperations(session, { filters: {} });
}

test("分组by不能使跨层总体每克比率成为受控比较", async () => {
  const operations = await priceMixOperations(); await assert.rejects(operations.execute(request({ method: "compare", metrics: ["amount_per_gram"], by: ["category", "material"], reference: { period: before, population: "sales", filters: {} } })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID");
});

test("控制层内全部降价而总体比率上涨时，raw只描述结构，标准化事实才支持控制比较", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts"); const operations = await priceMixOperations();
  const result = await operations.execute(request({ method: "compare", metrics: ["amount_per_gram"], by: ["category", "material"], controls: ["category", "material"], reference: { period: before, population: "sales", filters: {} } }));
  assert.equal(result.status, "completed"); assert.equal(fact(result, "amount_per_gram", "目标").value, 91); assert.equal(fact(result, "amount_per_gram", "参照").value, 20.9);
  const rawDelta = result.facts.find((v) => v.metricId === "amount_per_gram.delta" && !v.objectIds.length)!;
  assert.equal(rawDelta.comparisonRole, "descriptive"); assert.deepEqual(rawDelta.comparisonControls, []); assert.ok(rawDelta.value! > 70);
  const adjusted = fact(result, "amount_per_gram.standardized_delta"); assert.equal(adjusted.comparisonRole, "standardized"); assert.deepEqual(adjusted.comparisonControls, ["category", "material"]); assert.ok(Math.abs(adjusted.value! + 1.9) < 1e-12);
  const layers = result.facts.filter((v) => v.metricId === "amount_per_gram.delta" && v.objectIds.length);
  assert.equal(layers.length, 2); assert.ok(layers.every((v) => v.value! < 0 && v.comparisonRole === "within_stratum"));
  assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
});

test("同一完整单值筛选内的每克对照仍是实际同层比较", async () => {
  const operations = await priceMixOperations(); const filters = { categories: ["层0"], materials: ["材料"] };
  const result = await operations.execute(request({ method: "compare", metrics: ["amount_per_gram"], scope: { period: after, population: "sales", filters }, reference: { period: before, population: "sales", filters } }));
  const delta = fact(result, "amount_per_gram.delta"); assert.equal(delta.value, -10); assert.equal(delta.comparisonRole, "within_stratum"); assert.deepEqual(delta.comparisonControls, ["category", "material"]);
});

test("每单均额也按实际订单权重标准化，raw不能借分类控制被升级", async () => {
  const rows: SalesRow[] = [];
  for (const [date, countHigh, high, countLow, low] of [[before.start, 10, 110, 90, 11], [after.start, 90, 100, 10, 10]] as const) {
    for (let i = 0; i < countHigh; i++) rows.push(row({ date, category: "高", netSales: high, orderId: `${date}-高-${i}` }));
    for (let i = 0; i < countLow; i++) rows.push(row({ date, category: "低", netSales: low, orderId: `${date}-低-${i}` }));
  }
  const f = await setup(rows); const result = await f.operations.execute(request({ method: "compare", metrics: ["amount_per_order"], controls: ["category"], by: ["category"], reference: { period: before, population: "sales", filters: {} } }));
  const raw = result.facts.find((v) => v.metricId === "amount_per_order.delta" && !v.objectIds.length)!; assert.ok(raw.value! > 70); assert.equal(raw.comparisonRole, "descriptive");
  const adjusted = fact(result, "amount_per_order.standardized_delta"); assert.ok(Math.abs(adjusted.value! + 1.9) < 1e-12); assert.equal(adjusted.comparisonRole, "standardized"); assert.deepEqual(adjusted.comparisonControls, ["category"]);
});

test("操作事实经registry往返后，描述比率结论被拒、实际标准化结论通过", async () => {
  const { createEvidenceRegistry, validateAnalysisDraft } = await import("../app/lib/analytics/analysis-v2-evidence.ts"); const operations = await priceMixOperations();
  const result = await operations.execute(request({ method: "compare", metrics: ["amount_per_gram"], controls: ["category", "material"], reference: { period: before, population: "sales", filters: {} } }));
  const registry = createEvidenceRegistry(); registry.ingest(result); const evidence = registry.bundle();
  const raw = fact(result, "amount_per_gram.delta"); const adjusted = fact(result, "amount_per_gram.standardized_delta");
  assert.equal(evidence.facts.find((f) => f.id === raw.id)?.comparisonRole, "descriptive");
  const task: AnalysisTask = { runId: "ratio-review", question: "控制品类和材料后单位实收如何变化", context: [], needs: [{ id: "need-1", userQuote: "单位实收如何变化", judgement: "解释可比的单位实收差异", status: "open", conclusionIds: [] }], hardScope: { filters: {} }, assumptions: [] };
  const draft = (factId: string): AnalysisDraft => ({ status: "answered", conclusions: [{ id: "conclusion-1", needIds: ["need-1"], level: "comparison_supported", judgement: "控制后的单位实收变低", factIds: [factId], objectIds: [], methodIds: [result.methods[0].id], limitations: [] }], blocks: [{ kind: "paragraph", conclusionId: "conclusion-1", nodes: [{ kind: "text", text: "控制后的单位实收差为" }, { kind: "fact_ref", factId }] }], questions: [], userConditions: [], trialParameters: [], coverage: [{ needId: "need-1", status: "supported", reason: "实际可比差异已经计算" }] });
  const wrong = validateAnalysisDraft(task, draft(raw.id), evidence); assert.equal(wrong.valid, false); assert.ok(wrong.issues.some((v) => v.kind === "invalid_comparison"));
  const correct = validateAnalysisDraft(task, draft(adjusted.id), evidence); assert.equal(correct.valid, true, correct.issues.map((v) => v.requirement).join("；"));
});

function scanFixtureRows(reference = false): SalesRow[] {
  const selected = [
    row({ store: "S1", category: "C1", campaignId: "O1", netSales: 100, orderId: "1" }),
    row({ store: "S1", category: "C1", campaignId: "O2", netSales: 200, orderId: "2" }),
    row({ store: "S2", category: "C2", campaignId: "O1", netSales: 300, orderId: "3" }),
    row({ store: "S2", category: "C2", campaignId: "O2", netSales: 400, orderId: "4" }),
  ];
  return reference ? [...selected, ...selected.map((r) => row({ ...r, lineId: crypto.randomUUID(), date: before.start, netSales: 100 }))] : selected;
}
function scanObjects(result: AnalysisOperationResult, fact: AnalysisOperationResult["facts"][number]) {
  return Object.fromEntries(fact.objectIds.map((id) => { const object = result.objects.find((v) => v.id === id)!; return [object.dimension, object.value]; }));
}

test("扫描多维by保留完整组合，规范排序不会选择一个维度替代请求", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  for (const reference of [false, true]) for (const by of [["store", "offer"], ["offer", "category"]] as const) {
    const f = await setup(scanFixtureRows(reference)); let reads = 0; const aggregate = f.session.aggregate; f.session.aggregate = (...args) => { reads++; return aggregate(...args); };
    const result = await f.operations.execute(request({ method: "scan", by: [...by], ...(reference ? { reference: { period: before, population: "sales" as const, filters: {} } } : {}) }));
    assert.equal(result.status, "completed"); assert.equal(result.methods[0].groupCount, 4);
    const deviations = result.facts.filter((v) => v.metricId === "amount.relative_deviation"); assert.equal(deviations.length, 4);
    const actual = new Map(deviations.map((v) => { const objects = scanObjects(result, v); assert.deepEqual(Object.keys(objects).sort(), [...by].sort()); return [`${objects[by[0]]}/${objects[by[1]]}`, v.value]; }));
    const pairs = by[0] === "store" ? ["S1/O1", "S1/O2", "S2/O1", "S2/O2"] : ["O1/C1", "O2/C1", "O1/C2", "O2/C2"];
    const expected = reference ? [-150, -50, 50, 150] : [-60, -20, 20, 60];
    pairs.forEach((key, i) => assert.ok(Math.abs(actual.get(key)! - expected[i]) < 1e-9));
    assert.equal(reads, 2); assert.doesNotThrow(() => createEvidenceRegistry().ingest(result));
    const cached = await f.operations.execute(request({ method: "scan", by: [...by].reverse(), ...(reference ? { reference: { period: before, population: "sales" as const, filters: {} } } : {}) }));
    assert.equal(cached.operationId, result.operationId); assert.equal(cached.cached, true); assert.equal(reads, 2);
  }
});

test("显式breakdown按其他by维度建立父组，跨期偏离和贡献使用本父组参照", async () => {
  const f = await setup(scanFixtureRows(true)); const result = await f.operations.execute(request({ method: "scan", by: ["offer", "store"], breakdown: "offer", reference: { period: before, population: "sales", filters: {} } }));
  assert.equal(result.methods[0].groupCount, 4);
  const deviations = result.facts.filter((v) => v.metricId === "amount.relative_deviation"); assert.equal(deviations.length, 4);
  for (const value of deviations) { const objects = scanObjects(result, value); assert.equal(Object.keys(objects).length, 2); assert.ok(Math.abs(value.value! - (objects.offer === "O1" ? -50 : 50)) < 1e-9); }
  const parents = result.facts.filter((v) => v.metricId === "amount" && v.objectIds.length === 1 && result.frames.find((f) => f.id === v.frameId)?.scope.period.start === after.start);
  assert.deepEqual(new Map(parents.map((v) => [scanObjects(result, v).store, v.value])), new Map([["S1", 300], ["S2", 700]]));
  for (const contribution of result.facts.filter((v) => v.metricId === "amount.change_contribution")) { const objects = scanObjects(result, contribution); const expected = objects.offer === "O1" ? objects.store === "S1" ? 0 : 40 : objects.store === "S1" ? 100 : 60; assert.ok(Math.abs(contribution.value! - expected) < 1e-9); }
});

test("同期层级扫描在每个真实父组内重算分母，不能混入其他门店", async () => {
  const f = await setup(scanFixtureRows()); const result = await f.operations.execute(request({ method: "scan", by: ["store"], breakdown: "offer" }));
  const expected = new Map([["S1/O1", -100 / 3], ["S1/O2", 100 / 3], ["S2/O1", -100 / 7], ["S2/O2", 100 / 7]]);
  const deviations = result.facts.filter((v) => v.metricId === "amount.relative_deviation"); assert.equal(deviations.length, 4);
  deviations.forEach((value) => { const objects = scanObjects(result, value); assert.ok(Math.abs(value.value! - expected.get(`${objects.store}/${objects.offer}`)!) < 1e-9); });
});

test("组合父子订单均额从复合订单重算，而不是平均行或分组比率", async () => {
  const f = await setup([row({ store: "S1", campaignId: "O1", orderId: "1", netSales: 100 }), row({ store: "S1", campaignId: "O1", orderId: "1", netSales: 100 }), row({ store: "S1", campaignId: "O2", orderId: "1", netSales: 300 }), row({ store: "S2", campaignId: "O1", orderId: "3", netSales: 500 }), row({ store: "S2", campaignId: "O1", orderId: "3", netSales: 500 }), row({ store: "S2", campaignId: "O2", orderId: "4", netSales: 50 })]);
  const result = await f.operations.execute(request({ method: "scan", by: ["store", "offer"], breakdown: "offer", metrics: ["amount_per_order"] }));
  const expected = new Map([["S1/O1", -60], ["S1/O2", -40], ["S2/O1", 1900 / 21], ["S2/O2", -1900 / 21]]);
  const values = result.facts.filter((v) => v.metricId === "amount_per_order.relative_deviation"); assert.equal(values.length, 4);
  values.forEach((value) => { const objects = scanObjects(result, value); assert.equal(value.comparisonRole, "descriptive"); assert.ok(Math.abs(value.value! - expected.get(`${objects.store}/${objects.offer}`)!) < 1e-9); });
});

test("有真实订单能力时净口径大单检查是可修参数错误，改销售即可执行", async () => {
  const f = await setup([row({ netSales: 100, orderId: "大" }), row({ netSales: 50, orderId: "小" })]); let reads = 0; const aggregate = f.session.aggregate; f.session.aggregate = (...args) => { reads++; return aggregate(...args); };
  await assert.rejects(f.operations.execute(request({ method: "robustness", check: "largest_order", scope: { period: after, population: "net", filters: {} } })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID" && /sales|销售/.test(error.message));
  await assert.rejects(f.operations.execute(request({ method: "robustness", check: "largest_order", metrics: ["amount_per_order"], scope: { period: after, population: "net", filters: {} } })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID");
  await assert.rejects(f.operations.execute(request({ method: "robustness", check: "largest_order", reference: { period: before, population: "net", filters: {} } })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID" && /参照/.test(error.message));
  assert.equal(reads, 0); const repaired = await f.operations.execute(request({ method: "robustness", check: "largest_order" })); assert.equal(repaired.status, "completed"); assert.equal(fact(repaired, "amount", "剔除后").value, 50);
  const missing = await setup([row({ orderId: null })]); assert.equal((await missing.operations.execute(request({ method: "robustness", check: "largest_order", scope: { period: after, population: "net", filters: {} } }))).status, "unsupported");
});

test("方法必需参数遗漏返回可修错误，真实字段和方法缺失仍保留unsupported", async () => {
  const f = await setup([row()]);
  for (const input of [request({ method: "compare" }), request({ method: "decompose" }), request({ method: "scan" }), request({ method: "robustness" }), request({ method: "robustness", check: "alternative_window" })]) {
    await assert.rejects(f.operations.execute(input), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID" && /参照|reference|分组|by|检查|check|日期|alternative/.test(error.message));
  }
  assert.equal((await f.operations.execute(request({ method: "compare", controls: ["material"], reference: { period: before, population: "sales", filters: {} } }))).status, "unsupported");
  f.session.capabilities.methods = ["aggregate"];
  assert.equal((await f.operations.execute(request({ method: "scan", by: ["store"] }))).status, "unsupported");
});

test("控制字段真实存在时漏controls是读前可修错误，补控制同源即可执行", async () => {
  let reads = 0; const operations = await priceMixOperations(["store", "category", "material"], () => { reads++; });
  const input = request({ method: "compare", metrics: ["amount_per_gram"], reference: { period: before, population: "sales", filters: {} } }); const original = structuredClone(input);
  await assert.rejects(operations.execute(input), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID" && /controls|控制/.test(error.message));
  assert.equal(reads, 0); assert.deepEqual(input, original);
  assert.equal((await operations.execute({ ...input, controls: ["category", "material"] })).status, "completed"); assert.equal(reads, 2);
  reads = 0; const missing = await priceMixOperations(["store", "category"], () => { reads++; });
  for (const controls of [undefined, ["category", "material"]] as const) {
    const result = await missing.execute({ ...input, controls: controls ? [...controls] : undefined }); assert.equal(result.status, "unsupported"); assert.equal(result.methods[0].status, "unsupported"); assert.ok(result.methods[0].checks.every((v) => v.status === "unavailable"));
  }
  assert.equal(reads, 0);
});

test("净口径不适用销售每单均额是参数错误，保留原口径并可改适用指标", async () => {
  const f = await setup([row({ netSales: 100 }), row({ orderId: "退货", quantity: -1, netSales: -20 })]); let reads = 0; const aggregate = f.session.aggregate; f.session.aggregate = (...args) => { reads++; return aggregate(...args); };
  const input = request({ metrics: ["amount_per_order"], scope: { period: after, population: "net", filters: {} } }); const original = structuredClone(input);
  await assert.rejects(f.operations.execute(input), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID" && /原.*口径|保持|保留|不能.*替代/.test(error.message));
  assert.equal(reads, 0); assert.deepEqual(input, original);
  const net = await f.operations.execute({ ...input, metrics: ["amount"] }); assert.equal(fact(net, "amount").value, 80); assert.equal(net.frames[0].scope.population, "net");
  const separateSales = await f.operations.execute({ ...input, scope: { ...input.scope, population: "sales" } }); assert.equal(separateSales.status, "completed"); assert.equal(fact(separateSales, "amount_per_order").value, 100); assert.equal(separateSales.frames[0].scope.population, "sales");
});

test("target与reference口径不同是可修错误，不能读取后偷偷解除原净口径", async () => {
  const f = await setup([row({ date: before.start, netSales: 100 }), row({ netSales: 120 }), row({ quantity: -1, netSales: -40 })]); let reads = 0; const aggregate = f.session.aggregate; f.session.aggregate = (...args) => { reads++; return aggregate(...args); };
  const input = request({ method: "compare", scope: { period: after, population: "net", filters: {} }, reference: { period: before, population: "sales", filters: {} } }); const original = structuredClone(input);
  await assert.rejects(f.operations.execute(input), (error: unknown) => error instanceof Error && "code" in error && error.code === "ANALYSIS_ARGUMENTS_INVALID" && /decompose|拆解/.test(error.message) && /原.*口径|约束|保留/.test(error.message));
  assert.equal(reads, 0); assert.deepEqual(input, original);
  const repaired = await f.operations.execute({ ...input, reference: { ...input.reference!, population: "net" } }); assert.equal(fact(repaired, "amount.delta").value, -20); assert.ok(repaired.frames.every((frame) => frame.scope.population === "net"));
  const decomposition = await f.operations.execute({ ...input, method: "decompose", reference: { ...input.reference!, population: "net" } }); assert.equal(fact(decomposition, "amount.decomposed_change").value, -20);
});
