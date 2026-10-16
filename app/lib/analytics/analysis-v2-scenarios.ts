import type { AnalysisAdjustment, AnalysisCapabilities, AnalysisScenarioAggregate, AnalysisScenarioQuery } from "./analysis-v2-types.ts";
import { analysisArgumentsInvalid, normalizeAnalysisAggregateQuery } from "./analysis-v2-operations.ts";
import { decimalFraction, safeScenarioInteger, scenarioCents, scenarioProductCents, scenarioRateCents } from "./scenario-decimal.ts";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function normalizeScenarioAdjustment(value: unknown): AnalysisAdjustment {
  if (!record(value)) throw analysisArgumentsInvalid("情景调整规则不正确");
  const kind = value.kind;
  if (!["per_gram", "per_item", "per_order", "amount_rate", "order_threshold"].includes(String(kind))) throw analysisArgumentsInvalid("情景规则当前不支持，请按真实能力选择");
  const keys = kind === "amount_rate" ? ["kind", "rate"] : kind === "order_threshold" ? ["kind", "threshold", "amount"] : ["kind", "amount"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw analysisArgumentsInvalid("情景规则含未开放参数");
  const number = (key: string) => {
    const raw = value[key];
    if (typeof raw !== "string" || !/^\d{1,13}(?:\.\d{1,6})?$/.test(raw) || Number(raw) > 1e12) throw analysisArgumentsInvalid("规则数值须为非负十进制字符串，最多六位小数");
    return raw.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  };
  if (kind === "amount_rate") { const rate = number("rate"); if (Number(rate) > 1) throw analysisArgumentsInvalid("金额比例须在零与一之间"); return { kind, rate }; }
  const amount = number("amount");
  if (kind === "order_threshold") return { kind, amount, threshold: number("threshold") };
  return { kind: kind as "per_gram" | "per_item" | "per_order", amount };
}
export function normalizeScenarioQuery(input: AnalysisScenarioQuery, capabilities: AnalysisCapabilities): AnalysisScenarioQuery {
  if (!record(input) || Object.keys(input).some((key) => !["scope", "adjustment"].includes(key))) throw analysisArgumentsInvalid("情景范围参数不正确");
  const scope = normalizeAnalysisAggregateQuery({ scope: input.scope, by: [] }, capabilities).scope; const adjustment = normalizeScenarioAdjustment(input.adjustment);
  if (scope.population !== "sales") throw analysisArgumentsInvalid("逐行情景仅支持销售正金额 sales，退货和回收须另行核对");
  if (!/^(?:CNY|人民币|RMB|元)$/.test(capabilities.currency)) throw analysisArgumentsInvalid("当前精确情景只支持已核对的人民币分金额");
  const metric = adjustment.kind === "per_gram" ? "grams" : ["per_order", "order_threshold"].includes(adjustment.kind) ? "orders" : "quantity";
  if (!capabilities.metrics.some((item) => item.id === metric)) throw analysisArgumentsInvalid("源数据缺少该情景需要的单位或复合订单字段");
  return { scope, adjustment };
}

export type ScenarioRow = { amount: number; quantity: number; grams: number | null; orderKey?: string };
export function aggregateScenarioRows(rows: Iterable<ScenarioRow>, adjustment: AnalysisAdjustment): AnalysisScenarioAggregate {
  const orderBased = adjustment.kind === "per_order" || adjustment.kind === "order_threshold";
  const orders = new Map<string, bigint>(); let sampleRows = 0, missingUnits = 0, nonpositiveUnits = 0, units = 0, eligibleUnits = 0;
  let amount = BigInt(0), loss = BigInt(0);
  const reduction = (cents: bigint, count: number) => {
    const proposed = adjustment.kind === "amount_rate" ? scenarioRateCents(cents, adjustment.rate) : scenarioProductCents(adjustment.amount, count);
    return proposed < cents ? proposed : cents;
  };
  for (const row of rows) {
    sampleRows++; const cents = scenarioCents(row.amount); amount += cents;
    if (orderBased) { if (!row.orderKey) { missingUnits++; continue; } orders.set(row.orderKey, (orders.get(row.orderKey) ?? BigInt(0)) + cents); continue; }
    const count = adjustment.kind === "per_gram" ? row.grams : adjustment.kind === "per_item" ? row.quantity : 1;
    if (count === null || !Number.isFinite(count)) { missingUnits++; continue; }
    if (count <= 0) { nonpositiveUnits++; continue; }
    units += count; eligibleUnits++; loss += reduction(cents, count);
  }
  if (orderBased) {
    units = orders.size;
    const threshold = adjustment.kind === "order_threshold" ? scenarioCents(adjustment.threshold) : BigInt(0);
    for (const cents of orders.values()) if (cents >= threshold) { eligibleUnits++; loss += reduction(cents, 1); }
  }
  if (!Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER) throw new Error("情景数量超出安全计算范围");
  return { sampleRows, amountCents: safeScenarioInteger(amount), lossCents: missingUnits || nonpositiveUnits ? null : safeScenarioInteger(loss), units: missingUnits || nonpositiveUnits ? null : units, unit: adjustment.kind === "per_gram" ? "克" : orderBased ? "单" : adjustment.kind === "per_item" ? "件" : "实收", missingUnits, nonpositiveUnits, eligibleUnits };
}

export function normalizeNetChanges(values: unknown): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 20) throw analysisArgumentsInvalid("请提供有限的显式净成交量比例情景，最多二十个");
  const seen = new Set<string>(); const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !/^-?\d{1,7}(?:\.\d{1,12})?$/.test(value) || Number(value) <= -1 || Number(value) > 1e6) throw analysisArgumentsInvalid("净成交量比例须为大于负一的有限十进制字符串，不能填写百分数或表达式");
    const canonical = value.replace(/^(-?)0+(?=\d)/, "$1").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    const key = decimalFraction(canonical).numerator === BigInt(0) ? "0" : canonical;
    if (!seen.has(key)) { seen.add(key); result.push(key); }
  }
  return result.sort((a, b) => Number(a) - Number(b));
}
