import assert from "node:assert/strict";
import test from "node:test";
import { digitGuard, formatRoleValue, totalAcrossWindows } from "../app/lib/analytics/plan/bind.ts";
import type { PlanNode, PlanScope } from "../app/lib/analytics/plan/types.ts";
import type { AnalysisFact } from "../app/lib/analytics/analysis-v2-types.ts";

// 旧的结论绑定（bindClaims）已下线，正文引用的绑定测试在 analysis-plan-refs；这里只测共用的数字工具。
const scope: PlanScope = { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} };
const fact = (id: string, value: number | null, unit: string): AnalysisFact => ({ id, frameId: "f", metricId: "amount_per_day", label: id, value, unit, definition: "", objectIds: [], operationId: "op", limitations: [] });

test("正文数字只允许来自原话与业务名称", () => {
  const forbidden = digitGuard(["帮我复盘一下2025年七夕（8月23日到29日这7天）的销售表现，和8月其他日子比"], ["H-克减30元", "H-克减50元", "东区/B区"]);
  for (const ok of ["七夕7天日均高出", "8月其他日子", "H-克减30元档和H-克减50元档", "克减30元档的件数更多", "50档比30档卖得多", "东区/B区表现最好", "2025年七夕", "前三名"]) assert.deepEqual(forbidden(ok), [], ok);
  for (const bad of ["高了50元", "增长了35%", "约三倍，即3.2倍", "日均订单为21650单", "高了30元", "9月", "70档"]) assert.ok(forbidden(bad).length > 0, bad);
  assert.deepEqual(forbidden("毛利率16.02%，比30档高"), ["16.02%"]);
});

test("业务名称简称、档位简称和大小写不同的价位段名称不算算出来的数字", () => {
  const forbidden = digitGuard(["「H-克减30元」和「H-克减50元」"], ["30K-50K"]);
  for (const ok of ["克减50档比克减30档日均高", "50元档比30元档日均高", "30k-50k 价位段贡献最大"]) assert.deepEqual(forbidden(ok), [], ok);
  for (const bad of ["高出50元", "50元档高出30元"]) assert.ok(forbidden(bad).length > 0, bad);
});

test("百分比指标的差额写成个百分点", () => {
  assert.equal(formatRoleValue(fact("x", 0.97, "%"), "delta"), "+0.97个百分点");
  assert.equal(formatRoleValue(fact("x", 35.1, "%"), "change"), "+35.10%");
  assert.equal(formatRoleValue(fact("x", 47642.428571, "单/日"), "value"), "47,642.43单/日");
  assert.equal(formatRoleValue(fact("x", -850949.28, "人民币"), "contribution"), "-850,949.28元");
});

test("天数不同的两段不能比合计值，日均可以；同样长度的两段可以比合计", () => {
  const contrast = (target: PlanScope, reference: PlanScope): PlanNode => ({ id: "c", op: "contrast", target, reference, metrics: ["amount"] });
  const week = { ...scope, period: { start: "2025-08-23", end: "2025-08-29" } };
  assert.equal(totalAcrossWindows(contrast(week, scope), "amount", "change"), true);
  assert.equal(totalAcrossWindows(contrast(week, scope), "amount_per_day", "change"), false);
  assert.equal(totalAcrossWindows(contrast({ ...scope, filters: { festivals: ["七夕节"] } }, { ...scope, filters: { festivals: ["非节庆"] } }), "amount", "delta"), true);
  const lastYear = { ...scope, period: { start: "2024-08-01", end: "2024-08-31" } };
  assert.equal(totalAcrossWindows(contrast(scope, lastYear), "amount", "change"), false);
  const measure: PlanNode = { id: "m", op: "measure", scope: week, metrics: ["amount"] };
  assert.equal(totalAcrossWindows(measure, "amount", "value"), false);
});

test("计划范围里的日期可以写成「2025年8月」「8月23日」这类说法", async () => {
  const { digitGuard, periodLiterals } = await import("../app/lib/analytics/plan/bind.ts");
  const dates = ["2025-08-01", "2025-08-31", "2025-08-23"];
  // ISO 日期原样写时按业务名称处理（refs 里由 nodeLiterals 传入 names）。
  const forbidden = digitGuard(periodLiterals(dates), dates);
  for (const ok of ["2025年8月有成交的活动", "8月有成交", "8月23日起", "2025年8月1日至31日", "2025-08-01至2025-08-31"]) assert.deepEqual(forbidden(ok), [], ok);
  for (const bad of ["9月", "2024年", "高了30元"]) assert.ok(forbidden(bad).length > 0, bad);
});
