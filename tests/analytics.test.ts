import assert from "node:assert/strict";
import test from "node:test";
import { runAnalysis, readEvidence } from "../app/lib/analytics/engine.ts";
import { importDataset } from "../app/lib/analytics/import.ts";

const csv = "明细ID,日期,门店,货类,净销售额,件数,成本,会员分组,活动编号\n" +
  "a,2025-08-01,A,黄金,100,1,60,新会员,c1\n" +
  "b,2025-08-01,A,黄金,200,2,100,老会员,c1\n" +
  "c,2026-08-01,A,黄金,150,1,80,新会员,c2\n" +
  "d,2026-08-01,A,黄金,180,2,110,老会员,c2\n" +
  "e,2026-08-02,A,黄金,-30,-1,-20,老会员,c2";

const dataset = () => ({ ...importDataset({ name: "实际导入", provenance: "imported", sales: { content: csv, format: "csv" }, currency: "CNY" }), id: "ds1", version: "v1", createdAt: "2026-10-10" });
const query = { period: { start: "2026-08-01", end: "2026-08-31" }, comparison: { start: "2025-08-01", end: "2025-08-31" }, filters: {} };

test("销售明细按分汇总且退款扣减，不按订单或规则行重复计数", () => {
  const report = runAnalysis(dataset(), query);
  assert.equal(report.metrics.sales, 300);
  assert.equal(report.metrics.quantity, 2);
  assert.equal(report.metrics.grossProfit, 130);
  assert.equal(report.baseline?.sales, 300);
  assert.equal(report.salesChangePercent, 0);
  assert.equal(report.metrics.rows, 3);
});

test("分组与明细使用同一范围和数据版本", () => {
  const ds = dataset();
  const report = runAnalysis(ds, query);
  const group = report.groups.find((x) => x.dimension === "memberSegment" && x.value === "新会员")!;
  assert.ok(group.current);
  assert.equal(group.current.sales, 150);
  assert.equal(group.baseline?.sales, 100);
  assert.equal(group.salesChangePercent, 50);
  const evidence = readEvidence(ds, report, group.id);
  assert.deepEqual(evidence.currentRows.map((r) => r.lineId), ["c"]);
  assert.deepEqual(evidence.baselineRows.map((r) => r.lineId), ["a"]);
  assert.equal(evidence.datasetVersion, "v1");
  assert.throws(() => readEvidence({ ...ds, version: "v2" }, report, group.id), /版本/);
  assert.throws(() => readEvidence(ds, report, "伪造证据"), /证据/);
});

test("部分成本缺失不计算整体毛利，零基期不生成增长率", () => {
  const ds = dataset();
  ds.rows[2].cost = null;
  const report = runAnalysis(ds, { ...query, comparison: { start: "2024-01-01", end: "2024-12-31" } });
  assert.equal(report.metrics.grossProfit, null);
  assert.equal(report.salesChangePercent, null);
  assert.match(report.limitations.join(" "), /成本/);
});

test("会员编号不等于会员标签，不按编号猜测新老会员", () => {
  const ds = dataset();
  for (const row of ds.rows) { row.memberSegment = null; row.memberId = row.lineId; }
  const report = runAnalysis(ds, query);
  assert.ok(!report.availableDimensions.includes("memberSegment"));
  assert.ok(!report.groups.some((g) => g.dimension === "memberSegment"));
});

test("筛选改变实际结果，重叠比较期和倒置日期被拒绝", () => {
  const ds = dataset();
  assert.equal(runAnalysis(ds, { ...query, filters: { memberSegments: ["新会员"] } }).metrics.sales, 150);
  assert.throws(() => runAnalysis(ds, { ...query, period: { start: "2026-09-01", end: "2026-08-01" } }), /日期/);
  assert.throws(() => runAnalysis(ds, { ...query, comparison: query.period }), /重叠/);
});

test("一个分组缺少任一期明细时不把未提供数据解释为零销售或下降百分比", () => {
  const ds = dataset(); ds.rows = [ds.rows[0], { ...ds.rows[2], category: "镶嵌" }];
  const report = runAnalysis(ds, query);
  const gold = report.groups.find((g) => g.dimension === "category" && g.value === "黄金")!;
  assert.equal(gold.salesChangePercent, null);
  assert.equal(gold.salesChange, null);
  assert.equal(gold.current, null);
  const diamond = report.groups.find((g) => g.dimension === "category" && g.value === "镶嵌")!;
  assert.equal(diamond.baseline, null);
  assert.equal(diamond.salesChange, null);
});

test("实际提供的正负明细抵消为零时可以计算真实下降，而非视为缺失", () => {
  const ds = dataset(); ds.rows = [ds.rows[0], { ...ds.rows[2], netSales: 100 }, { ...ds.rows[4], netSales: -100 }];
  const report = runAnalysis(ds, query);
  assert.equal(report.metrics.rows, 2);
  assert.equal(report.metrics.sales, 0);
  assert.equal(report.salesChangePercent, -100);
  const group = report.groups.find((g) => g.dimension === "category" && g.value === "黄金")!;
  assert.equal(group.current?.sales, 0);
  assert.equal(group.salesChangePercent, -100);
});
