import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_DIMENSIONS, ANALYSIS_FILTER_DIMENSIONS, ANALYSIS_FILTER_KEYS, ANALYSIS_METRICS, SEMANTIC_DIMENSIONS, SEMANTIC_METRICS, semanticDatabaseColumns, semanticFields } from "../app/lib/analytics/semantic/model.ts";
import { analysisMetricDefinitions, createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { buildAnalysisAggregateQuery } from "../agent/analytics-operation-database.ts";
import type { AnalysisAggregateCell, AnalysisAggregateQuery, AnalysisDataSession, AnalysisFact } from "../app/lib/analytics/analysis-v2-types.ts";

const columns = semanticDatabaseColumns();
const scope = { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales" as const, filters: {} };

test("语义模型自洽：每个维度有唯一筛选键，父级存在，比率只引用基础度量", () => {
  assert.equal(new Set(ANALYSIS_DIMENSIONS.map((id) => SEMANTIC_DIMENSIONS[id].filter)).size, ANALYSIS_DIMENSIONS.length);
  assert.deepEqual([...ANALYSIS_FILTER_KEYS].sort(), ANALYSIS_DIMENSIONS.map((id) => SEMANTIC_DIMENSIONS[id].filter).sort());
  for (const id of ANALYSIS_DIMENSIONS) {
    const parent = SEMANTIC_DIMENSIONS[id].parent;
    if (parent) assert.ok(ANALYSIS_DIMENSIONS.includes(parent), `${id} 的父级 ${parent} 不存在`);
    assert.equal(ANALYSIS_FILTER_DIMENSIONS[SEMANTIC_DIMENSIONS[id].filter], id);
  }
  for (const id of ANALYSIS_METRICS) {
    for (const field of semanticFields(id)) assert.ok(!SEMANTIC_METRICS[field].ratio, `${id} 的 ${field} 不是基础度量`);
    for (const dimension of SEMANTIC_METRICS[id].requires) assert.ok(ANALYSIS_DIMENSIONS.includes(dimension));
  }
});

test("推断档的口径不能冒充已确认：毛利、折扣率、一般開單、同店都标为 assumption", () => {
  for (const id of ["profit", "margin_rate", "discount_rate", "tag_per_gram"] as const) assert.equal(SEMANTIC_METRICS[id].basis, "assumption");
  for (const id of ["offer", "sameStore", "area", "storeAge"] as const) assert.equal(SEMANTIC_DIMENSIONS[id].basis, "assumption");
});

test("分区按「大区/分区」复合键分组，同名分区在不同大区不会合并", () => {
  const plan = buildAnalysisAggregateQuery("sales", { scope, by: ["district"], metrics: ["amount"] }, columns);
  assert.match(plan.sql, /CONCAT\(`大区描述`, '\/', `分区描述`\)/);
  assert.ok(!/CAST\(`分区描述` AS CHAR/.test(plan.sql));
  const filtered = buildAnalysisAggregateQuery("sales", { scope: { ...scope, filters: { districts: ["南区/B区"] } }, by: [], metrics: ["amount"] }, columns);
  assert.match(filtered.sql, /\(CASE WHEN .*CONCAT\(`大区描述`, '\/', `分区描述`\).*\) IN \(\?\)/);
  assert.ok(filtered.params.includes("南区/B区"));
});

test("节庆、日类型、活动期次、店龄段由语义来源编译，不要求模型自己推窗口", () => {
  const plan = buildAnalysisAggregateQuery("sales", { scope: { ...scope, filters: { festivals: ["七夕节"] } }, by: ["dayType", "offerPeriod", "storeAge"], metrics: ["amount"] }, columns);
  assert.match(plan.sql, /COALESCE\(NULLIF\(`节庆`, ''\), '非节庆'\)/);
  assert.match(plan.sql, /WHEN `工作日标识` = 'Y' THEN '工作日'/);
  assert.match(plan.sql, /CONCAT\(LEFT\(`活动开始日期`, 10\), '至', LEFT\(`活动结束日期`, 10\)\)/);
  assert.match(plan.sql, /'10年以上'/);
  for (const name of ["节庆", "周日标识", "周末标识", "工作日标识", "活动开始日期", "活动结束日期", "店龄"]) assert.ok(plan.requiredColumns.includes(name), name);
  assert.ok(plan.params.includes("七夕节"));
});

test("折扣率与毛利率的分子分母都进 SQL 选择，未请求的字段不读", () => {
  const plan = buildAnalysisAggregateQuery("sales", { scope, by: [], metrics: ["discount_rate"] }, columns);
  assert.ok(plan.requiredColumns.includes("销售牌仔价")); assert.ok(plan.requiredColumns.includes("实际销售金额"));
  assert.ok(!plan.requiredColumns.includes("零售毛利")); assert.match(plan.sql, /NULL AS profit/);
});

test("缺列的维度不进能力目录，不能分组也不能筛选", () => {
  const without = columns.filter((name) => name !== "节庆");
  assert.throws(() => buildAnalysisAggregateQuery("sales", { scope, by: ["festival"], metrics: ["amount"] } as AnalysisAggregateQuery, without), /维度|字段/);
  assert.throws(() => buildAnalysisAggregateQuery("sales", { scope: { ...scope, filters: { festivals: ["七夕节"] } }, by: [], metrics: ["amount"] }, without), /维度|字段/);
});

// 合成会话按查询返回明细：每天一行，按请求维度分组；验证日均分母是有成交的日期数。
type Row = { day: string; festival: string; store: string; amount: number };
function session(rows: Row[]): AnalysisDataSession {
  const metrics = ["amount", "quantity", "profit", "tag_amount", "rows", "amount_per_day", "margin_rate", "discount_rate"] as const;
  return { snapshotId: "semantic-fixture", datasetVersion: "semantic-fixture-v1", close: async () => {},
    capabilities: { mode: "snapshot", name: "语义层夹具", coverage: { start: "2025-08-01", end: "2025-08-31" }, currency: "CNY", provenance: "sample", dimensions: ["day", "festival", "store"], metrics: analysisMetricDefinitions("CNY", [...metrics], "snapshot"), methods: ["aggregate", "compare", "decompose", "scan", "robustness"], limitations: [] },
    async aggregate(query) {
      const selected = rows.filter((row) => row.day >= query.scope.period.start && row.day <= query.scope.period.end && (!query.scope.filters.festivals || query.scope.filters.festivals.includes(row.festival)) && (!query.scope.filters.stores || query.scope.filters.stores.includes(row.store)));
      const groups = new Map<string, Row[]>();
      for (const row of selected) { const key = JSON.stringify(query.by.map((dimension) => (row as Record<string, string | number>)[dimension])); groups.set(key, [...(groups.get(key) ?? []), row]); }
      return [...groups].map(([key, items]): AnalysisAggregateCell => { const values = JSON.parse(key) as string[]; const amount = items.reduce((sum, row) => sum + row.amount, 0);
        return { dimensions: Object.fromEntries(query.by.map((dimension, index) => [dimension, values[index]])), rows: items.length, amount, quantity: items.length, grams: null, profit: amount / 5, orders: null, stores: new Set(items.map((row) => row.store)).size, tag_amount: amount * 1.25 }; });
    } };
}
const day = (n: number) => `2025-08-${String(n).padStart(2, "0")}`;
// 七夕 8/23–29 每天 100；其余日子每天 50，但 8/30、8/31 没有成交。
const month: Row[] = Array.from({ length: 29 }, (_, i) => ({ day: day(i + 1), festival: i + 1 >= 23 ? "七夕节" : "非节庆", store: "A", amount: i + 1 >= 23 ? 100 : 50 }));
const value = (facts: AnalysisFact[], metricId: string) => facts.find((fact) => fact.metricId === metricId)!.value;
const month31 = { start: "2025-08-01", end: "2025-08-31" };

test("不同长度窗口用日均直接比较：分母是有成交的日期数，不是整月日历天数", async () => {
  const result = await createAnalysisOperations(session(month), { filters: {} }).execute({ needIds: ["need-1"], purpose: "七夕日均对非节庆", method: "compare", metrics: ["amount_per_day"],
    scope: { period: month31, population: "sales", filters: { festivals: ["七夕节"] } }, reference: { period: month31, population: "sales", filters: { festivals: ["非节庆"] } } });
  assert.deepEqual(result.facts.filter((fact) => fact.metricId === "period_days").map((fact) => fact.value), [7, 22]);
  assert.deepEqual(result.facts.filter((fact) => fact.metricId === "amount_per_day").map((fact) => fact.value), [100, 50]);
  assert.equal(value(result.facts, "amount_per_day.delta"), 50); assert.equal(value(result.facts, "amount_per_day.relative_change"), 100);
});

test("按节庆分组时每组用自己的成交日期数", async () => {
  const result = await createAnalysisOperations(session(month), { filters: {} }).execute({ needIds: ["need-1"], purpose: "节庆分组日均", method: "aggregate", metrics: ["amount_per_day"], by: ["festival"], scope: { period: month31, population: "sales", filters: {} } });
  assert.deepEqual(result.facts.filter((fact) => fact.metricId === "amount_per_day").map((fact) => fact.value).sort((a, b) => a! - b!), [50, 100]);
});

test("多门店同日成交只算一天", async () => {
  const rows: Row[] = [...month, ...month.map((row) => ({ ...row, store: "B" }))];
  const result = await createAnalysisOperations(session(rows), { filters: {} }).execute({ needIds: ["need-1"], purpose: "多店日均", method: "aggregate", metrics: ["amount_per_day"], scope: { period: month31, population: "sales", filters: { festivals: ["七夕节"] } } });
  assert.equal(value(result.facts, "amount_per_day"), 200); assert.equal(value(result.facts, "period_days"), 7);
});

test("折扣率 = (牌价 − 实收) ÷ 牌价，毛利率 = 毛利 ÷ 实收，均按百分比输出并保留分子分母", async () => {
  const result = await createAnalysisOperations(session(month), { filters: {} }).execute({ needIds: ["need-1"], purpose: "让利与毛利", method: "aggregate", metrics: ["discount_rate", "margin_rate"], scope: { period: month31, population: "sales", filters: {} } });
  assert.ok(Math.abs(value(result.facts, "discount_rate")! - 20) < 1e-9);
  assert.ok(Math.abs(value(result.facts, "margin_rate")! - 20) < 1e-9);
  const discount = result.facts.find((fact) => fact.metricId === "discount_rate")!;
  assert.equal(discount.unit, "%"); assert.ok(discount.derivation && "op" in discount.derivation);
  assert.ok(result.facts.some((fact) => fact.metricId === "tag_amount") && result.facts.some((fact) => fact.metricId === "amount"));
});

test("缺销售单号的行不计入订单并注明行数，不让整体订单和单均失效", async () => {
  const rows = month.map((row, index) => ({ ...row, order: index === 0 ? null : `O${index}` }));
  const base = session(rows);
  const withOrders: AnalysisDataSession = { ...base, capabilities: { ...base.capabilities, metrics: analysisMetricDefinitions("CNY", ["amount", "rows", "orders", "amount_per_order"], "snapshot") },
    async aggregate(query) { return (await base.aggregate(query)).map((cell) => ({ ...cell, orders: 28, orderMissingRows: 1 })); } };
  const result = await createAnalysisOperations(withOrders, { filters: {} }).execute({ needIds: ["need-1"], purpose: "缺单号", method: "aggregate", metrics: ["orders", "amount_per_order"], scope: { period: month31, population: "sales", filters: {} } });
  const orders = result.facts.find((fact) => fact.metricId === "orders")!;
  assert.equal(orders.value, 28); assert.ok(orders.limitations.some((text) => /1 行缺店号或销售单号/.test(text)));
  assert.ok(value(result.facts, "amount_per_order") !== null);
});

test("订单 SQL：无缺单号时用原去重，有缺单号时只数完整标识并返回排除行数", () => {
  const plan = buildAnalysisAggregateQuery("sales", { scope, by: [], metrics: ["orders"] }, columns);
  assert.match(plan.sql, /COUNT\(DISTINCT `实体分店店号`, `销售单号`\)/);
  assert.match(plan.sql, /AS orders_missing_rows/);
});

test("每店实收 = 实收 ÷ 有成交门店数，每店毛利同理", async () => {
  const rows: Row[] = [...month, ...month.map((row) => ({ ...row, store: "B" }))];
  const base = session(rows);
  const withStores: AnalysisDataSession = { ...base, capabilities: { ...base.capabilities, metrics: analysisMetricDefinitions("CNY", ["amount", "profit", "stores", "rows", "amount_per_store", "profit_per_store"], "snapshot") } };
  const result = await createAnalysisOperations(withStores, { filters: {} }).execute({ needIds: ["need-1"], purpose: "每店", method: "aggregate", metrics: ["amount_per_store", "profit_per_store"], scope: { period: month31, population: "sales", filters: { festivals: ["七夕节"] } } });
  assert.equal(value(result.facts, "amount_per_store"), 700);
  assert.equal(value(result.facts, "profit_per_store"), 140);
});

test("每店指标的单位与门店数一致，派生事实通过证据单位校验", async () => {
  const { createEvidenceRegistry } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  const rows: Row[] = [...month, ...month.map((row) => ({ ...row, store: "B" }))];
  const base = session(rows);
  const withStores: AnalysisDataSession = { ...base, capabilities: { ...base.capabilities, metrics: analysisMetricDefinitions("CNY", ["amount", "profit", "stores", "rows", "amount_per_store", "profit_per_store"], "snapshot") } };
  const result = await createAnalysisOperations(withStores, { filters: {} }).execute({ needIds: ["need-1"], purpose: "每店对照", method: "compare", metrics: ["amount_per_store"], scope: { period: month31, population: "sales", filters: { festivals: ["七夕节"] } }, reference: { period: month31, population: "sales", filters: { festivals: ["非节庆"] } } });
  await createEvidenceRegistry().ingestAsync(result);
  assert.equal(result.facts.find((fact) => fact.metricId === "amount_per_store")!.unit, "CNY/家");
});

test("对比时同时要每单和每店指标，紧凑订单集合路径仍按门店去重，每店指标不变成空值", async () => {
  const rows: Row[] = [...month, ...month.map((row) => ({ ...row, store: "B" }))];
  const base = session(rows);
  // 带订单集合的读取：和真实适配器一样，不按门店分组时把明细按身份分桶，同一分组会拆成多格，
  // 每格只带订单号和本格门店数，不带门店维度。
  const withOrders: AnalysisDataSession = { ...base,
    capabilities: { ...base.capabilities, metrics: analysisMetricDefinitions("CNY", ["amount", "profit", "stores", "orders", "rows", "amount_per_store", "amount_per_order"], "snapshot") },
    aggregateWithOrderIds: async (query) => query.by.includes("store")
      ? (await base.aggregate(query)).map((cell) => ({ ...cell, orderIds: [JSON.stringify(cell.dimensions)] }))
      : (await base.aggregate({ ...query, by: [...query.by, "store"] })).map(({ dimensions: { store, ...rest }, ...cell }) => ({ ...cell, dimensions: rest, orderIds: [`${store}:${JSON.stringify(rest)}`] })) };
  const result = await createAnalysisOperations(withOrders, { filters: {} }).execute({ needIds: ["need-1"], purpose: "每店对照", method: "compare", metrics: ["amount_per_store", "amount_per_order"], scope: { period: month31, population: "sales", filters: { festivals: ["七夕节"] } }, reference: { period: month31, population: "sales", filters: { festivals: ["非节庆"] } } });
  const perStore = result.facts.filter((fact) => fact.metricId === "amount_per_store").map((fact) => fact.value);
  assert.deepEqual(perStore, [700, 1100]);
});

test("日期筛选按源字段格式比较：2025-08-23 写作 20250823", () => {
  const plan = buildAnalysisAggregateQuery("sales", { scope: { ...scope, filters: { days: ["2025-08-23", "2025-08-24"] } }, by: [], metrics: ["amount"] }, columns);
  assert.match(plan.sql, /`交易日期wid` IN \(\?,\?\)/);
  assert.ok(plan.params.includes("20250823") && plan.params.includes("20250824"));
  assert.ok(!plan.params.includes("2025-08-23"));
});
