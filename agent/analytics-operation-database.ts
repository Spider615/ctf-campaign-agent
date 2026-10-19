import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { TurnCancelledError, throwIfTurnCancelled } from "../app/lib/cancellation.ts";
import { analysisMetricDefinitions, analysisSessionExpired, normalizeAnalysisAggregateQuery, normalizeAnalysisPeriod } from "../app/lib/analytics/analysis-v2-operations.ts";
import type { AnalysisAggregateCell, AnalysisAggregateQuery, AnalysisCapabilities, AnalysisDataProvider, AnalysisDataSession, AnalysisDimension, AnalysisMetric, AnalysisOrderDistribution, AnalysisOrderDistributionQuery } from "../app/lib/analytics/analysis-v2-types.ts";
import type { HistoryConnection } from "./analytics-database.ts";
import type { AnalysisScenarioAggregate, AnalysisScenarioQuery } from "../app/lib/analytics/analysis-v2-types.ts";
import { normalizeScenarioQuery } from "../app/lib/analytics/analysis-v2-scenarios.ts";
import { ANALYSIS_DIMENSIONS, ANALYSIS_FILTER_DIMENSIONS, SEMANTIC_BASELINES, SEMANTIC_DATABASE_LIMITATIONS, SEMANTIC_DIMENSIONS, semanticDimensionCatalog, semanticFields, type SemanticFilterKey } from "../app/lib/analytics/semantic/model.ts";

export type MysqlAnalysisConfig = { host: string; port: number; user: string; password: string; database: string; table: string; evidenceDir: string };
// 单次完整查询保留资源上限；客户端额外留传输余量，避免合法慢查询清空整轮证据。
export const ANALYSIS_DATABASE_QUERY_TIMEOUT_MS = 60000;
const ANALYSIS_DATABASE_IO_TIMEOUT_MS = ANALYSIS_DATABASE_QUERY_TIMEOUT_MS + 5000;

type Dependencies = { connect: () => Promise<HistoryConnection>; pruneSource?: (connection: HistoryConnection, table: string, columns: readonly string[]) => Promise<string>; queryTimeoutMs?: number };
// 维度来源来自语义层；这里只负责把来源编译成 SQL 表达式和所需列。
export { sourceColumns } from "../app/lib/analytics/semantic/columns.ts";
import { sourceColumns } from "../app/lib/analytics/semantic/columns.ts";
const sourceOf = (dimension: AnalysisDimension) => SEMANTIC_DIMENSIONS[dimension].source;
// 店龄分段边界属于推断，见语义层定义。
const AGE_BANDS = "CASE WHEN `{c}` IS NULL OR TRIM(`{c}`) = '' THEN NULL WHEN CAST(`{c}` AS SIGNED) <= 1 THEN '0-1年' WHEN CAST(`{c}` AS SIGNED) <= 3 THEN '2-3年' WHEN CAST(`{c}` AS SIGNED) <= 5 THEN '4-5年' WHEN CAST(`{c}` AS SIGNED) <= 10 THEN '6-10年' ELSE '10年以上' END";
export function dimensionExpression(dimension: AnalysisDimension, lengths: GroupLengths = {}): string {
  const source = sourceOf(dimension); if (!source) throw new Error("数据库缺少分组维度字段");
  if (source.kind === "column") return boundedField(source.column, lengths[dimension]);
  if (source.kind === "coalesce") return `COALESCE(NULLIF(${quoted(source.column)}, ''), '${source.fallback}')`;
  if (source.kind === "composite") return `CASE WHEN NULLIF(${quoted(source.columns[0])}, '') IS NULL OR NULLIF(${quoted(source.columns[1])}, '') IS NULL THEN NULL ELSE CONCAT(${quoted(source.columns[0])}, '/', ${quoted(source.columns[1])}) END`;
  if (source.kind === "date_range") return `CASE WHEN NULLIF(${quoted(source.start)}, '') IS NULL OR NULLIF(${quoted(source.end)}, '') IS NULL THEN NULL ELSE CONCAT(LEFT(${quoted(source.start)}, 10), '至', LEFT(${quoted(source.end)}, 10)) END`;
  if (source.kind === "age_band") return AGE_BANDS.replaceAll("{c}", source.column);
  if (source.kind === "labels") {
    // 映射值来自语义层常量，不含用户输入；仍按 SQL 字符串规则转义单引号。
    const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `CASE ${quoted(source.column)} ${Object.entries(source.labels).map(([code, label]) => `WHEN ${text(code)} THEN ${text(label)}`).join(" ")} ELSE NULLIF(CAST(${quoted(source.column)} AS CHAR), '') END`;
  }
  return `CASE WHEN ${quoted(source.workday)} = 'Y' THEN '工作日' WHEN ${quoted(source.sunday)} = 'Y' THEN '周日' WHEN ${quoted(source.weekend)} = 'Y' THEN '周六' ELSE NULL END`;
}
const lengthMeasurable = (dimension: AnalysisDimension) => sourceOf(dimension)?.kind === "column";
// 会话打开时列出全部取值的维度：取值有限、模型常写错的业务分类。日期、门店、商场、SKU 等不列。
const DIMENSION_VALUE_LISTS: readonly AnalysisDimension[] = ["dayType", "festival", "region", "area", "district", "cityTier", "storeType", "storeGroup", "sameStore", "shopType", "storeComposition", "imageLevel", "salesLevel", "storeLevel", "retailExperience", "storeArea", "storeAge", "category", "productGroup", "material", "materialGroup", "priceBand", "seriesGroup", "keySeries", "campaignType", "memberFlag", "offer"];
const MAX_DIMENSION_VALUES = 600;
const dimensionValueCache = new Map<string, Map<string, string[]>>();
const metricColumns = { amount: "实际销售金额", quantity: "销售件数", grams: "销售金重", profit: "零售毛利", tag_amount: "销售牌仔价" } as const;
type GroupDimension = AnalysisAggregateQuery["by"][number];
type LengthField = GroupDimension | "saleNo";
type GroupLengths = Partial<Record<LengthField, number>>;
const required = ["_import_id", "交易日期wid", "实体分店店号", "实际销售金额", "销售件数", "币种描述"];
const quoted = (name: string) => `\`${name}\``;
const boundedField = (column: string, length?: number) => {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > 65535)) throw new Error("分析字段实际长度不正确");
  // 长度来自同快照全源 MAX；LEFT 保留源字段排序规则，实际值不截短。
  return length === undefined ? quoted(column) : `LEFT(${quoted(column)}, ${length})`;
};
const validOrderExpression = "NULLIF(CAST(`实体分店店号` AS CHAR), '') IS NOT NULL AND NULLIF(CAST(`销售单号` AS CHAR), '') IS NOT NULL";
const orderExpression = `CASE WHEN ${validOrderExpression} THEN CONCAT(CHAR_LENGTH(CAST(\`实体分店店号\` AS CHAR)), ':', CAST(\`实体分店店号\` AS CHAR), ':', CAST(\`销售单号\` AS CHAR)) ELSE NULL END`;
const completeSum = (column: string, money: boolean) => `CASE WHEN COUNT(${quoted(column)}) = COUNT(*) THEN ${money ? `SUM(ROUND(${quoted(column)} * 100, 0)) / 100` : `SUM(${quoted(column)})`} ELSE NULL END`;
const safeReadError = (message: string) => Object.assign(new Error(message), { code: "ANALYSIS_DATABASE_ERROR" });
const rows = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw safeReadError("分析数据库结果格式不正确");
  return value;
};
function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))) throw safeReadError("分析数据库指标格式不正确");
  const number = Number(value); if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) throw safeReadError("分析数据库指标超出安全计算范围"); return number;
}
function availableCapabilities(columns: readonly string[], currency: string, coverage: AnalysisCapabilities["coverage"]): AnalysisCapabilities {
  const dimensions = ANALYSIS_DIMENSIONS.filter((dimension) => { const source = sourceOf(dimension); return Boolean(source && sourceColumns(source).every((name) => columns.includes(name))); });
  const metrics: AnalysisMetric[] = ["rows", "stores", ...(Object.keys(metricColumns) as Array<keyof typeof metricColumns>).filter((metric) => columns.includes(metricColumns[metric]))];
  metrics.push("amount_per_day", "amount_per_item");
  metrics.push("amount_per_store"); if (columns.includes("零售毛利")) metrics.push("profit_per_store");
  if (columns.includes("销售单号")) metrics.push("orders", "amount_per_order", "orders_per_day");
  if (columns.includes("零售毛利")) metrics.push("margin_rate");
  if (columns.includes("销售牌仔价")) metrics.push("discount_rate");
  if (columns.includes("销售金重") && dimensions.includes("category") && dimensions.includes("material")) { metrics.push("amount_per_gram"); if (columns.includes("销售牌仔价")) metrics.push("tag_per_gram", "gap_per_gram"); }
  return { mode: "database", name: "周大福历史经营数据", coverage, currency, provenance: "imported", dimensions, metrics: analysisMetricDefinitions(currency, metrics, "database"), methods: ["aggregate", "compare", "decompose", "scan", "robustness"], scenarios: /^(?:CNY|人民币|RMB|元)$/.test(currency) ? ["per_item", "amount_rate", ...(metrics.includes("grams") && dimensions.includes("category") && dimensions.includes("material") ? ["per_gram" as const] : []), ...(metrics.includes("orders") ? ["per_order" as const, "order_threshold" as const] : [])] : [],
    dimensionCatalog: semanticDimensionCatalog(dimensions), baselines: SEMANTIC_BASELINES.filter((item) => item.id !== "same_store" || dimensions.includes("sameStore")).filter((item) => item.id !== "non_festival" || dimensions.includes("festival")).filter((item) => item.id !== "plain_order" || dimensions.includes("offer")).map((item) => ({ ...item })),
    limitations: [...SEMANTIC_DATABASE_LIMITATIONS] };
}

export function buildAnalysisAggregateQuery(table: string, input: AnalysisAggregateQuery, columns: readonly string[], groupLengths: GroupLengths = {}, includeOrderIds = false) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) throw new Error("分析数据库表名不正确");
  if (required.some((name) => !columns.includes(name))) throw new Error("数据库缺少分析必要字段");
  const coverage = normalizeAnalysisPeriod(input.scope.period); const capabilities = availableCapabilities(columns, "原币", coverage); const query = normalizeAnalysisAggregateQuery(input, capabilities);
  const population = query.scope.population; const where = ["`交易日期wid` BETWEEN ? AND ?", population === "sales" ? "(`销售件数` > 0 AND `实际销售金额` > 0)" : population === "net" ? "((`销售件数` > 0 AND `实际销售金额` >= 0) OR `销售件数` < 0)" : population === "returns" ? "(`销售件数` < 0)" : population === "zero_sales" ? "(`销售件数` > 0 AND `实际销售金额` = 0)" : "(`销售件数` = 0 AND `实际销售金额` < 0)"];
  const params = [query.scope.period.start.replaceAll("-", ""), query.scope.period.end.replaceAll("-", "")];
  const requiredColumns = new Set(["交易日期wid", "实际销售金额", "销售件数", "实体分店店号"]);
  const clause = (column: string, values: string[], exclude = false) => { where.push(`${column} ${exclude ? "NOT IN" : "IN"} (${values.map(() => "?").join(",")})`); params.push(...values); };
  for (const [key, values] of Object.entries(query.scope.filters)) {
    const dimension = ANALYSIS_FILTER_DIMENSIONS[key as SemanticFilterKey]; const source = dimension ? sourceOf(dimension) : undefined;
    if (!source || sourceColumns(source).some((name) => !columns.includes(name))) throw new Error("数据库缺少筛选字段"); sourceColumns(source).forEach((name) => requiredColumns.add(name));
    // 日期对外写作 2025-08-23，源字段 交易日期wid 存 20250823；分组输出已转回带横线的写法，筛选时反向转换。
    clause(source.kind === "column" ? quoted(source.column) : `(${dimensionExpression(dimension)})`, dimension === "day" ? values!.map((value) => value.replaceAll("-", "")) : values!);
  }
  if (query.excludeStores?.length) clause("`实体分店店号`", query.excludeStores, true);
  if (query.excludeOrders?.length) { if (!columns.includes("销售单号")) throw new Error("当前数据缺少复合订单字段"); requiredColumns.add("销售单号"); clause(`(${orderExpression})`, query.excludeOrders, true); }
  const castGroup = (expression: string, dimension: GroupDimension) => {
    const length = groupLengths[dimension];
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > 65535)) throw new Error("分析分组实际长度不正确");
    return `CAST(${expression} AS CHAR${length === undefined ? "" : `(${length})`})`;
  };
  const dimensions = query.by.map((dimension) => {
    if (dimension === "order") { requiredColumns.add("销售单号"); return `${groupLengths.order === undefined ? orderExpression : castGroup(orderExpression, dimension)} AS d_order`; }
    const source = sourceOf(dimension); if (!source || sourceColumns(source).some((name) => !columns.includes(name))) throw new Error("数据库缺少分组维度字段"); sourceColumns(source).forEach((name) => requiredColumns.add(name));
    return `${source.kind === "column" ? castGroup(quoted(source.column), dimension) : `CAST(${dimensionExpression(dimension)} AS CHAR)`} AS d_${dimension}`;
  });
  const selected = query.metrics ? new Set<AnalysisMetric>(query.metrics.flatMap((metric) => semanticFields(metric))) : null;
  const metrics = (Object.keys(metricColumns) as Array<keyof typeof metricColumns>).map((metric) => { const column = metricColumns[metric]; if (!columns.includes(column) || selected && !selected.has(metric)) return `NULL AS ${metric}`; requiredColumns.add(column); return `${completeSum(column, ["amount", "profit", "tag_amount"].includes(metric))} AS ${metric}`; });
  if (includeOrderIds && !columns.includes("销售单号")) throw new Error("当前数据缺少复合订单字段");
  const orders = !includeOrderIds && columns.includes("销售单号") && (!selected || selected.has("orders")) ? `CASE WHEN SUM(CASE WHEN ${validOrderExpression} THEN 0 ELSE 1 END) = 0 THEN COUNT(DISTINCT ${boundedField("实体分店店号", groupLengths.store)}, ${boundedField("销售单号", groupLengths.saleNo)}) ELSE COUNT(DISTINCT CASE WHEN ${validOrderExpression} THEN CONCAT(CHAR_LENGTH(CAST(\`实体分店店号\` AS CHAR)), ':', CAST(\`实体分店店号\` AS CHAR), ':', CAST(\`销售单号\` AS CHAR)) END) END AS orders, SUM(CASE WHEN ${validOrderExpression} THEN 0 ELSE 1 END) AS orders_missing_rows` : "NULL AS orders";
  if (orders !== "NULL AS orders") requiredColumns.add("销售单号");
  if (includeOrderIds) requiredColumns.add("销售单号");
  const stores = !selected || selected.has("stores") ? `CASE WHEN COUNT(NULLIF(CAST(\`实体分店店号\` AS CHAR), '')) = COUNT(*) THEN COUNT(DISTINCT ${boundedField("实体分店店号", groupLengths.store)}) ELSE NULL END AS stores` : "NULL AS stores";
  // 大活动的单个身份数组会拖慢聚合；源行身份分桶覆盖每条明细，跨桶订单仍由完整集合去重。
  const bucketIdentities = includeOrderIds && !query.by.includes("store");
  if (bucketIdentities) requiredColumns.add("_import_id");
  const groupKeys = [...query.by.map((dimension) => `d_${dimension}`), ...(bucketIdentities ? ["MOD(CRC32(CAST(`_import_id` AS CHAR)), 128)"] : [])];
  const grouped = groupKeys.length ? ` GROUP BY ${groupKeys.join(", ")}` : "";
  // 不按金额截取；资源截止使整个快照失效，不产生部分结果。
  const sql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ ${[...dimensions, "COUNT(*) AS rows_count", ...metrics, orders, stores, ...(includeOrderIds ? [`JSON_ARRAYAGG(${orderExpression}) AS order_ids`] : [])].join(", ")} FROM ${quoted(table)} WHERE ${where.join(" AND ")}${grouped}`;
  return { sql, params, query, requiredColumns: [...requiredColumns] };
}

export function buildAnalysisScenarioQuery(table: string, input: AnalysisScenarioQuery, columns: readonly string[], groupLengths: GroupLengths = {}) {
  const base = buildAnalysisAggregateQuery(table, { scope: input.scope, by: [], metrics: ["amount"] }, columns);
  const query = normalizeScenarioQuery(input, availableCapabilities(columns, "CNY", base.query.scope.period)); const rule = query.adjustment;
  const orderBased = rule.kind === "per_order" || rule.kind === "order_threshold";
  const requiredColumns = new Set(base.requiredColumns);
  const source = base.sql.slice(base.sql.indexOf(" FROM "));
  const amount = "CAST(ROUND(`实际销售金额` * 100, 0) AS DECIMAL(38,0))";
  let inner: string;
  if (orderBased) {
    requiredColumns.add("销售单号");
    inner = `SELECT COUNT(*) AS sample_rows, SUM(${amount}) AS amount_cents, 1 AS units, SUM(CASE WHEN ${validOrderExpression} THEN 0 ELSE 1 END) AS missing_units, 0 AS nonpositive_units${source} GROUP BY ${boundedField("实体分店店号", groupLengths.store)}, ${boundedField("销售单号", groupLengths.saleNo)}`;
  } else {
    const column = rule.kind === "per_gram" ? "销售金重" : rule.kind === "per_item" ? "销售件数" : undefined;
    if (column) requiredColumns.add(column);
    const units = column ? `CAST(${quoted(column)} AS DECIMAL(38,12))` : "1";
    inner = `SELECT 1 AS sample_rows, ${amount} AS amount_cents, ${units} AS units, ${column ? `${quoted(column)} IS NULL` : "0"} AS missing_units, ${column ? `CASE WHEN ${quoted(column)} <= 0 THEN 1 ELSE 0 END` : "0"} AS nonpositive_units${source}`;
  }
  const params: string[] = [];
  const parameter = (value: string) => { params.push(value); return "CAST(? AS DECIMAL(30,6))"; };
  const threshold = () => `amount_cents >= ROUND(${parameter(rule.kind === "order_threshold" ? rule.threshold : "0")} * 100, 0)`;
  const proposed = rule.kind === "amount_rate" ? `ROUND(${parameter(rule.rate)} * amount_cents, 0)` : rule.kind === "order_threshold" ? `CASE WHEN ${threshold()} THEN ROUND(${parameter(rule.amount)} * 100, 0) ELSE 0 END` : `ROUND(${parameter(rule.amount)} * ${orderBased ? "1" : "units"} * 100, 0)`;
  const loss = `CASE WHEN SUM(missing_units) + SUM(nonpositive_units) > 0 THEN NULL ELSE SUM(LEAST(amount_cents, ${proposed})) END`;
  const eligible = rule.kind === "order_threshold" ? `SUM(CASE WHEN ${threshold()} THEN 1 ELSE 0 END)` : "SUM(CASE WHEN missing_units = 0 AND nonpositive_units = 0 THEN 1 ELSE 0 END)";
  const sql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ SUM(sample_rows) AS sample_rows, SUM(amount_cents) AS amount_cents, ${loss} AS loss_cents, SUM(units) AS units, SUM(missing_units) AS missing_units, SUM(nonpositive_units) AS nonpositive_units, ${eligible} AS eligible_units FROM (${inner}) AS scenario_units`;
  return { sql, params: [...params, ...base.params], query, requiredColumns: [...requiredColumns], by: orderBased ? ["store", "order"] as GroupDimension[] : [] };
}

export function buildAnalysisOrderDistributionQuery(table: string, input: AnalysisOrderDistributionQuery, columns: readonly string[], groupLengths: GroupLengths = {}) {
  if (!input || Object.keys(input).some((key) => !["scope", "metrics"].includes(key)) || !Array.isArray(input.metrics) || !input.metrics.length) throw new Error("订单分布参数不正确");
  const plan = buildAnalysisAggregateQuery(table, { scope: input.scope, by: [] }, columns);
  const available = availableCapabilities(columns, "原币", plan.query.scope.period);
  if (!available.metrics.some((metric) => metric.id === "orders") || plan.query.scope.population !== "sales") throw new Error("订单分布仅支持带复合订单标识的销售正金额数据");
  if (input.metrics.some((metric) => !available.metrics.some((item) => item.id === metric) || metric.endsWith("per_gram"))) throw new Error("原生订单分布包含不支持的指标");
  const metrics = [...new Set(input.metrics)].sort(); const query = { scope: plan.query.scope, metrics };
  const requiredColumns = new Set(["交易日期wid", "销售件数", "实际销售金额", "实体分店店号", "销售单号", ...plan.requiredColumns]);
  const rawMetrics = [...new Set(metrics.map((metric) => metric === "amount_per_order" ? "amount" : metric).filter((metric): metric is keyof typeof metricColumns => Object.hasOwn(metricColumns, metric)))];
  const selections = rawMetrics.map((metric) => { const column = metricColumns[metric]; requiredColumns.add(column); return `${completeSum(column, ["amount", "profit", "tag_amount"].includes(metric))} AS ${metric}`; });
  const validOrder = "(NULLIF(CAST(`实体分店店号` AS CHAR), '') IS NOT NULL AND NULLIF(CAST(`销售单号` AS CHAR), '') IS NOT NULL)";
  const value = (metric: AnalysisMetric) => ["orders", "stores"].includes(metric) ? "1" : metric === "rows" ? "rows_count" : metric === "amount_per_order" ? "amount" : metric;
  const fields = [...new Set(metrics.map(value))];
  const metricValue = `CASE metric_registry.distribution_key ${fields.map((field) => `WHEN '${field}' THEN ${field}`).join(" ")} END`;
  const histograms = `SELECT metric_registry.distribution_key, ${metricValue} AS metric_value, COUNT(CASE WHEN valid_order THEN 1 END) AS order_count, COUNT(CASE WHEN valid_order THEN ${metricValue} END) AS present_count, COALESCE(SUM(CASE WHEN valid_order THEN rows_count ELSE 0 END), 0) AS sample_rows, COALESCE(SUM(CASE WHEN NOT valid_order THEN rows_count ELSE 0 END), 0) AS excluded_rows FROM per_order CROSS JOIN (${fields.map((field) => `SELECT '${field}' AS distribution_key`).join(" UNION ALL ")}) AS metric_registry GROUP BY distribution_key, metric_value`;
  const quantiles = (["p50", "p90", "p99"] as const).map((name, index) => `CASE WHEN MAX(total_present) = MAX(total_orders) AND MAX(total_orders) > 0 THEN MIN(CASE WHEN order_count > 0 AND cumulative_orders >= CEIL(${[0.5, 0.9, 0.99][index]} * total_orders) THEN metric_value END) ELSE NULL END AS ${name}`);
  const selectionsOut = metrics.flatMap((metric) => (["p50", "p90", "p99"] as const).map((name) => `MAX(CASE WHEN distribution_key = '${value(metric)}' THEN ${name} END) AS q_${metric}_${name}`));
  const where = plan.sql.slice(plan.sql.indexOf(" WHERE "));
  // 完整筛选内逐单聚合后按最近秩取分位数；任何订单缺指标时返回 NULL，不抽样、不截前列。
  const sql = `WITH per_order AS (SELECT ${validOrder} AS valid_order, COUNT(*) AS rows_count${selections.length ? `, ${selections.join(", ")}` : ""} FROM ${quoted(table)}${where} GROUP BY valid_order, ${boundedField("实体分店店号", groupLengths.store)}, ${boundedField("销售单号", groupLengths.saleNo)}), order_histograms AS (${histograms}), ranked_orders AS (SELECT *, SUM(order_count) OVER (PARTITION BY distribution_key) AS total_orders, SUM(present_count) OVER (PARTITION BY distribution_key) AS total_present, SUM(sample_rows) OVER (PARTITION BY distribution_key) AS total_rows, SUM(excluded_rows) OVER (PARTITION BY distribution_key) AS total_excluded, SUM(order_count) OVER (PARTITION BY distribution_key ORDER BY metric_value ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_orders FROM order_histograms), order_quantiles AS (SELECT distribution_key, MAX(total_orders) AS order_count, MAX(total_rows) AS sample_rows, MAX(total_excluded) AS excluded_rows, ${quantiles.join(", ")} FROM ranked_orders GROUP BY distribution_key) SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ COALESCE(MAX(order_count), 0) AS order_count, COALESCE(MAX(sample_rows), 0) AS sample_rows, COALESCE(MAX(excluded_rows), 0) AS excluded_rows, ${selectionsOut.join(", ")} FROM order_quantiles`;
  return { sql, params: plan.params, query, requiredColumns: [...requiredColumns] };
}

export function createMysqlAnalysisProvider(config: MysqlAnalysisConfig, dependencies: Dependencies = { connect: () => mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, charset: "utf8mb4", connectTimeout: 5000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true }) }): AnalysisDataProvider {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.table) || !config.database || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !isAbsolute(config.evidenceDir)) throw new Error("本地分析数据库配置不正确");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const insideRepository = (path: string) => { const pathRelative = relative(repository, path); return !pathRelative || !pathRelative.startsWith("..") && !isAbsolute(pathRelative); };
  if (insideRepository(resolve(config.evidenceDir))) throw new Error("私有分析证据必须保存在仓库外目录");
  return { async open(signal?: AbortSignal): Promise<AnalysisDataSession> {
    throwIfTurnCancelled(signal); const snapshotId = `mysql-snapshot-${randomUUID()}`; const datasetVersion = `mysql-version-${randomUUID()}`;
    let connection: HistoryConnection | undefined; let active = true; let destroyed = false; let failureMessage: string | undefined; let terminationError: Error | undefined; const lifecycle = new AbortController();
    const cache = new Map<string, Promise<AnalysisAggregateCell[]>>(); const orderSetCache = new Map<string, Promise<AnalysisAggregateCell[] | null>>(); const identityCounts = new Map<string, Promise<number>>(); const distributionCache = new Map<string, Promise<AnalysisOrderDistribution>>(); let queue: Promise<unknown> = Promise.resolve();
    const scenarioCache = new Map<string, Promise<AnalysisScenarioAggregate>>();
    const variableColumns = new Set<string>(); const groupLengths = new Map<LengthField, number | undefined>();
    const destroy = () => { if (connection && !destroyed) { destroyed = true; connection.destroy(); } };
    const invalidate = (message?: string, error?: Error) => { active = false; failureMessage = message ?? failureMessage; terminationError = error ?? terminationError ?? analysisSessionExpired(failureMessage); cache.clear(); orderSetCache.clear(); identityCounts.clear(); distributionCache.clear(); scenarioCache.clear(); destroy(); signal?.removeEventListener("abort", aborted); if (!lifecycle.signal.aborted) lifecycle.abort(); };
    const assertActive = () => { if (!active) throw analysisSessionExpired(failureMessage); };
    const aborted = () => invalidate(undefined, new TurnCancelledError()); signal?.addEventListener("abort", aborted, { once: true });
    const resource = async <T>(job: () => Promise<T>, querySignal?: AbortSignal, deadline = true): Promise<T> => {
      throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive(); let timer: ReturnType<typeof setTimeout> | undefined; let onAbort = () => {};
      try {
        const value = await new Promise<T>((resolve, reject) => {
          onAbort = () => { const error = signal?.aborted || querySignal?.aborted ? new TurnCancelledError() : terminationError ?? analysisSessionExpired(failureMessage); invalidate(undefined, error); reject(error); };
          signal?.addEventListener("abort", onAbort, { once: true }); querySignal?.addEventListener("abort", onAbort, { once: true }); lifecycle.signal.addEventListener("abort", onAbort, { once: true });
          if (deadline) timer = setTimeout(() => { const message = "分析数据库资源查询超时，快照已失效，需要重开并重算"; invalidate(message); reject(analysisSessionExpired(message)); }, dependencies.queryTimeoutMs ?? ANALYSIS_DATABASE_IO_TIMEOUT_MS);
          void Promise.resolve().then(job).then(resolve, reject); if (signal?.aborted || querySignal?.aborted) onAbort();
        });
        throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive(); return value;
      } catch (error) {
        const safe = error instanceof Error && (error.name === "AbortError" || "code" in error && ["ANALYSIS_SESSION_EXPIRED", "ANALYSIS_DATABASE_ERROR"].includes(String(error.code))) ? error : error && typeof error === "object" && "code" in error && String(error.code) === "ER_QUERY_TIMEOUT" ? analysisSessionExpired("分析数据库资源查询超时，快照已失效，需要重开并重算") : safeReadError("分析数据库读取失败，请检查连接与字段映射后重试");
        invalidate(undefined, safe); throw safe;
      } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); querySignal?.removeEventListener("abort", onAbort); lifecycle.signal.removeEventListener("abort", onAbort); }
    };
    const capture = async (sql: string, params: string[], result: unknown, query?: AnalysisAggregateQuery | AnalysisOrderDistributionQuery | AnalysisScenarioQuery) => {
      assertActive(); throwIfTurnCancelled(signal); const recordId = `Q-${randomUUID()}`;
      try { await writeFile(join(config.evidenceDir, `${recordId}.json`), JSON.stringify({ schema: "ctf-mysql-evidence/v2", recordId, snapshotId, datasetVersion, capturedAt: new Date().toISOString(), sql, params, rows: result, ...(query ? { query } : {}) }, null, 2), { flag: "wx", mode: 0o600 }); }
      catch { throw safeReadError("分析查询证据未能保存，本次结果不用于回答"); }
      assertActive();
    };
    try {
      const pendingConnection = dependencies.connect(); void pendingConnection.then((late) => { if (!active) { connection = late; destroy(); } }, () => undefined);
      connection = await resource(() => pendingConnection);
      await resource(async () => { await mkdir(config.evidenceDir, { recursive: true, mode: 0o700 }); const path = await realpath(config.evidenceDir); if (insideRepository(path)) throw safeReadError("私有分析证据必须保存在仓库外目录"); });
      await resource(async () => {
        await connection!.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await connection!.query("SET SESSION TRANSACTION READ ONLY");
        await connection!.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      });
      const columns = await resource(async () => { const [result] = await connection!.query(`SHOW COLUMNS FROM ${quoted(config.table)}`); const records = rows(result); const fields = records.map((row) => String(row.Field)); if (required.some((field) => !fields.includes(field))) throw safeReadError("分析数据库缺少必要字段，请核对源销售明细"); for (const row of records) if (typeof row.Type === "string" && /text|char|blob|binary/i.test(row.Type)) variableColumns.add(String(row.Field)); return fields; });
      const relation = await resource(async () => dependencies.pruneSource ? dependencies.pruneSource(connection!, config.table, required) : quoted(config.table));
      const sql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ COUNT(*) AS rows_count, COUNT(DISTINCT \`_import_id\`) AS unique_rows, MIN(\`交易日期wid\`) AS min_day, MAX(\`交易日期wid\`) AS max_day, COUNT(DISTINCT NULLIF(\`币种描述\`, '')) AS currencies, MIN(\`币种描述\`) AS currency, SUM(NULLIF(\`币种描述\`, '') IS NULL) AS missing_currency FROM ${relation}`;
      const coverage = await resource(async () => {
        const [result] = await connection!.execute(sql); const record = rows(result)[0];
        if (!record || !numeric(record.rows_count) || numeric(record.rows_count) !== numeric(record.unique_rows) || !/^\d{8}$/.test(String(record.min_day)) || !/^\d{8}$/.test(String(record.max_day))) throw safeReadError("分析源行身份或日期异常，不能作为证据");
        if (numeric(record.currencies) !== 1 || numeric(record.missing_currency) !== 0 || typeof record.currency !== "string" || !record.currency.trim() || record.currency.length > 40) throw safeReadError("分析源币种混合或缺失，不能直接汇总");
        const date = (value: unknown) => String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"); const period = normalizeAnalysisPeriod({ start: date(record.min_day), end: date(record.max_day) });
        await capture(sql, [], result); return { period, currency: record.currency, rows: numeric(record.rows_count) };
      });
      const capabilities = availableCapabilities(columns, coverage.currency, coverage.period);
      // 取值不多的维度读出全部实际取值：模型写筛选值时照抄，校验时据此拦截写错的值。
      // 一次 UNION 查询读完，同一张表同一行数在进程内只读一次。
      const catalog = capabilities.dimensionCatalog ?? [];
      const listed = catalog.filter((item) => DIMENSION_VALUE_LISTS.includes(item.id));
      if (listed.length) {
        const cacheKey = `${config.database}.${config.table}:${coverage.rows}:${coverage.period.start}:${coverage.period.end}`;
        let cached = dimensionValueCache.get(cacheKey);
        if (!cached) {
          const relation = dependencies.pruneSource ? await resource(() => dependencies.pruneSource!(connection!, config.table, listed.flatMap((item) => sourceColumns(sourceOf(item.id)!)))) : quoted(config.table);
          // 每个维度各取去重值，合并成一条查询；超过上限的维度不列取值。
          const parts = listed.map((item, index) => `(SELECT '${item.id}' AS d, v FROM (SELECT CAST(${dimensionExpression(item.id)} AS CHAR) AS v FROM ${relation} GROUP BY v LIMIT ${MAX_DIMENSION_VALUES + 1}) AS t${index})`);
          const sql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ d, v FROM (${parts.join(" UNION ALL ")}) AS dimension_values`;
          const [result] = await resource(() => connection!.execute(sql));
          const found = new Map<string, string[]>();
          for (const row of rows(result)) { const value = row.v; if (typeof value !== "string" || !value.trim()) continue; const list = found.get(String(row.d)) ?? []; list.push(value); found.set(String(row.d), list); }
          cached = new Map([...found].filter(([, values]) => values.length <= MAX_DIMENSION_VALUES).map(([id, values]) => [id, values.sort()]));
          dimensionValueCache.set(cacheKey, cached);
        }
        for (const item of listed) { const values = cached.get(item.id); if (values) item.values = [...values]; }
      }
      const prepareRelation = async (requiredColumns: readonly string[], by: GroupDimension[], querySignal?: AbortSignal) => {
        const currentRelation = dependencies.pruneSource ? await resource(() => dependencies.pruneSource!(connection!, config.table, requiredColumns), querySignal) : quoted(config.table);
        const lengthColumn = (field: LengthField) => { if (field === "saleNo") return "销售单号"; const source = sourceOf(field as AnalysisDimension); return source?.kind === "column" ? source.column : ""; };
        const candidates = new Set<LengthField>([...by.filter((dimension) => dimension === "order" || lengthMeasurable(dimension)), ...(requiredColumns.includes("实体分店店号") ? ["store" as const] : []), ...(requiredColumns.includes("销售单号") ? ["saleNo" as const] : [])]);
        const measure = [...candidates].filter((dimension) => !groupLengths.has(dimension) && (dimension === "order" ? ["实体分店店号", "销售单号"].some((column) => variableColumns.has(column)) : variableColumns.has(lengthColumn(dimension))));
        if (measure.length) {
          // TEXT 分组先测量同一快照全源长度；超出优化范围仍保留完整值，不用采样或固定长度截断。
          const widthColumns = [...new Set(measure.flatMap((dimension) => dimension === "order" ? ["实体分店店号", "销售单号"] : [lengthColumn(dimension)]))];
          const widthRelation = dependencies.pruneSource ? await resource(() => dependencies.pruneSource!(connection!, config.table, widthColumns), querySignal) : quoted(config.table);
          const widthSql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ ${measure.map((dimension) => `MAX(CHAR_LENGTH(${dimension === "order" ? orderExpression : quoted(lengthColumn(dimension))})) AS w_${dimension}`).join(", ")} FROM ${widthRelation}`;
          const [measured] = await resource(() => connection!.execute(widthSql), querySignal); const values = rows(measured);
          if (values.length !== 1) throw safeReadError("分析分组长度结果不正确");
          for (const dimension of measure) {
            const length = numeric(values[0][`w_${dimension}`]);
            if (length !== null && (!Number.isSafeInteger(length) || length < 0)) throw safeReadError("分析分组实际长度不正确");
            groupLengths.set(dimension, length !== null && length > 65535 ? undefined : Math.max(1, length ?? 0));
          }
          await resource(() => capture(widthSql, [], measured), querySignal);
        }
        return currentRelation;
      };
      const lengths = () => Object.fromEntries([...groupLengths].filter(([, length]) => length !== undefined));
      const session: AnalysisDataSession = { snapshotId, datasetVersion, capabilities, assertActive,
        async scenario(input, querySignal) {
          if (querySignal?.aborted) invalidate(undefined, new TurnCancelledError());
          throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive();
          const query = normalizeScenarioQuery(input, capabilities); const key = JSON.stringify(query); const cached = scenarioCache.get(key);
          if (cached) return structuredClone(await resource(() => cached, querySignal, false));
          const pending = queue.then(async () => {
            assertActive(); let plan = buildAnalysisScenarioQuery(config.table, query, columns);
            const relation = await prepareRelation(plan.requiredColumns, plan.by, querySignal);
            plan = buildAnalysisScenarioQuery(config.table, query, columns, lengths());
            const sql = plan.sql.replace(`FROM ${quoted(config.table)} WHERE`, `FROM ${relation} WHERE`);
            const [raw] = await resource(() => connection!.execute(sql, plan.params), querySignal); const records = rows(raw);
            if (records.length !== 1) throw safeReadError("情景完整聚合结果不正确");
            const record = records[0];
            const count = (key: string) => { const value = numeric(record[key]); if (value === null || !Number.isSafeInteger(value) || value < 0) throw safeReadError("情景完整计数不正确"); return value; };
            const sampleRows = numeric(record.sample_rows) ?? 0;
            const missingUnits = sampleRows ? count("missing_units") : 0, nonpositiveUnits = sampleRows ? count("nonpositive_units") : 0;
            const amountCents = sampleRows ? count("amount_cents") : 0, lossCents = missingUnits || nonpositiveUnits ? null : sampleRows ? count("loss_cents") : 0;
            const unit = query.adjustment.kind === "per_gram" ? "克" : ["per_order", "order_threshold"].includes(query.adjustment.kind) ? "单" : query.adjustment.kind === "per_item" ? "件" : "实收";
            const result: AnalysisScenarioAggregate = { sampleRows, amountCents, lossCents, units: missingUnits || nonpositiveUnits ? null : numeric(record.units), unit, missingUnits, nonpositiveUnits, eligibleUnits: sampleRows ? count("eligible_units") : 0 };
            if (!Number.isSafeInteger(sampleRows) || sampleRows < 0 || lossCents !== null && lossCents > amountCents || result.units !== null && (result.units < 0 || !Number.isFinite(result.units))) throw safeReadError("情景基数、单位与损失不一致");
            await resource(() => capture(sql, plan.params, raw, query), querySignal); assertActive(); return result;
          });
          queue = pending.catch(() => undefined); scenarioCache.set(key, pending);
          return structuredClone(await resource(() => pending, querySignal, false));
        },
        async aggregate(input, querySignal) {
          if (querySignal?.aborted) invalidate(undefined, new TurnCancelledError());
          throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive(); const query = normalizeAnalysisAggregateQuery(input, capabilities); const key = JSON.stringify(query); const cached = cache.get(key);
          if (cached) { const result = await resource(() => cached, querySignal, false); return structuredClone(result); }
          const pending = queue.then(async () => {
            throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive();
            let plan = buildAnalysisAggregateQuery(config.table, query, columns);
            const currentRelation = await prepareRelation(plan.requiredColumns, query.by, querySignal);
            plan = buildAnalysisAggregateQuery(config.table, query, columns, lengths());
            const sql = plan.sql.replace(`FROM ${quoted(config.table)} WHERE`, `FROM ${currentRelation} WHERE`); const [result] = await resource(() => connection!.execute(sql, plan.params), querySignal); const data = rows(result); const cells: AnalysisAggregateCell[] = [];
            for (const record of data) {
              const n = numeric(record.rows_count); if (n === 0) continue;
              if (n === null || !Number.isSafeInteger(n) || n < 0) throw safeReadError("分析源明细数量不正确");
              const dimensions: AnalysisAggregateCell["dimensions"] = {};
              for (const dimension of query.by) { const value = record[`d_${dimension}`]; if (value !== null && value !== undefined && String(value).trim()) dimensions[dimension] = dimension === "day" ? String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : String(value); }
              cells.push({ dimensions, rows: n, amount: numeric(record.amount), quantity: numeric(record.quantity), grams: numeric(record.grams), profit: numeric(record.profit), orders: numeric(record.orders), stores: numeric(record.stores), tag_amount: numeric(record.tag_amount), orderMissingRows: numeric(record.orders_missing_rows ?? null) });
            }
            await resource(() => capture(sql, plan.params, data, query), querySignal); assertActive(); return cells;
          });
          queue = pending.catch(() => undefined); cache.set(key, pending);
          // 排队期间的取消也终止连接，不等待前一个数据库操作完成。
          const result = await resource(() => pending, querySignal, false); return structuredClone(result);
        },
        async aggregateWithOrderIds(input, querySignal) {
          if (querySignal?.aborted) invalidate(undefined, new TurnCancelledError());
          throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive(); const query = normalizeAnalysisAggregateQuery(input, capabilities);
          if (query.by.includes("order")) throw new Error("订单集合聚合不接受逐单分组");
          const key = JSON.stringify(query); const cached = orderSetCache.get(key);
          if (cached) return structuredClone(await resource(() => cached, querySignal, false));
          const pending = queue.then(async () => {
            assertActive();
            const countQuery = { ...query, by: [], metrics: ["orders"] as AnalysisMetric[] }; const countKey = JSON.stringify({ scope: query.scope, excludeStores: query.excludeStores, excludeOrders: query.excludeOrders });
            let countPending = identityCounts.get(countKey);
            if (!countPending) {
              countPending = (async () => {
                const plan = buildAnalysisAggregateQuery(config.table, countQuery, columns); const relation = await prepareRelation(plan.requiredColumns, [], querySignal);
                // CASE 的非空条件直接判断即可；不为每条明细拼接身份后再做相同的存在性检查。
                const sql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ COUNT(DISTINCT ${boundedField("实体分店店号", groupLengths.get("store"))}, ${boundedField("销售单号", groupLengths.get("saleNo"))}) AS orders_observed FROM ${relation}${plan.sql.slice(plan.sql.indexOf(" WHERE "))} AND (${validOrderExpression})`;
                const [raw] = await resource(() => connection!.execute(sql, plan.params), querySignal); const records = rows(raw); const n = records.length === 1 ? numeric(records[0].orders_observed) : null;
                if (n === null || !Number.isSafeInteger(n) || n < 0) throw safeReadError("复合订单身份核对结果不正确");
                await resource(() => capture(sql, plan.params, raw, countQuery), querySignal); return n;
              })();
              identityCounts.set(countKey, countPending);
            }
            const observed = await countPending;
            let plan = buildAnalysisAggregateQuery(config.table, query, columns, {}, true); const relation = await prepareRelation(plan.requiredColumns, query.by, querySignal);
            plan = buildAnalysisAggregateQuery(config.table, query, columns, lengths(), true);
            const sql = plan.sql.replace(`FROM ${quoted(config.table)} WHERE`, `FROM ${relation} WHERE`); const [raw] = await resource(() => connection!.execute(sql, plan.params), querySignal); const data = rows(raw);
            const cells: AnalysisAggregateCell[] = []; const allOrders = new Set<string>();
            for (const record of data) {
              const n = numeric(record.rows_count); if (n === 0) continue;
              if (n === null || !Number.isSafeInteger(n) || n < 0) throw safeReadError("分析源明细数量不正确");
              let ids: unknown = record.order_ids;
              if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { throw safeReadError("复合订单集合格式不正确"); } }
              if (!Array.isArray(ids) || ids.length !== n || ids.some((id) => id !== null && (typeof id !== "string" || !id))) throw safeReadError("复合订单集合与完整明细不一致");
              const orderIds = [...new Set(ids as Array<string | null>)]; for (const id of orderIds) if (id !== null) allOrders.add(id);
              const dimensions: AnalysisAggregateCell["dimensions"] = {};
              for (const dimension of query.by) { const value = record[`d_${dimension}`]; if (value !== null && value !== undefined && String(value).trim()) dimensions[dimension] = dimension === "day" ? String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : String(value); }
              cells.push({ dimensions, rows: n, amount: numeric(record.amount), quantity: numeric(record.quantity), grams: numeric(record.grams), profit: numeric(record.profit), orders: orderIds.includes(null) ? null : orderIds.length, stores: numeric(record.stores), tag_amount: numeric(record.tag_amount), orderMissingRows: (ids as Array<string | null>).filter((id) => id === null).length, orderIds });
            }
            await resource(() => capture(sql, plan.params, data, query), querySignal); assertActive();
            // 复合字符串必须与源数据库全范围去重一一对应；排序规则等导致不一致时回到逐单算法。
            return allOrders.size === observed ? cells : null;
          });
          queue = pending.catch(() => undefined); orderSetCache.set(key, pending);
          return structuredClone(await resource(() => pending, querySignal, false));
        },
        async orderDistribution(input, querySignal) {
          if (querySignal?.aborted) invalidate(undefined, new TurnCancelledError());
          throwIfTurnCancelled(signal); throwIfTurnCancelled(querySignal); assertActive();
          let plan = buildAnalysisOrderDistributionQuery(config.table, input, columns);
          const scope = normalizeAnalysisAggregateQuery({ scope: plan.query.scope, by: [] }, capabilities).scope;
          plan = buildAnalysisOrderDistributionQuery(config.table, { ...plan.query, scope }, columns); const key = JSON.stringify(plan.query); const cached = distributionCache.get(key);
          if (cached) return structuredClone(await resource(() => cached, querySignal, false));
          const pending = queue.then(async () => {
            assertActive(); const relation = await prepareRelation(plan.requiredColumns, [], querySignal);
            plan = buildAnalysisOrderDistributionQuery(config.table, plan.query, columns, lengths());
            const sql = plan.sql.replace(`FROM ${quoted(config.table)} WHERE`, `FROM ${relation} WHERE`);
            const [result] = await resource(() => connection!.execute(sql, plan.params), querySignal); const records = rows(result);
            if (records.length !== 1) throw safeReadError("订单分布摘要格式不正确"); const record = records[0];
            const count = (name: string) => { const n = numeric(record[name]); if (n === null || !Number.isSafeInteger(n) || n < 0) throw safeReadError("订单分布样本数量不正确"); return n; };
            const summary: AnalysisOrderDistribution = { sampleRows: count("sample_rows"), excludedRows: count("excluded_rows"), orderCount: count("order_count"), quantiles: {} };
            if (summary.orderCount > summary.sampleRows) throw safeReadError("订单分布数量与明细行数不一致");
            for (const metric of plan.query.metrics) summary.quantiles[metric] = { p50: numeric(record[`q_${metric}_p50`]), p90: numeric(record[`q_${metric}_p90`]), p99: numeric(record[`q_${metric}_p99`]) };
            await resource(() => capture(sql, plan.params, result, plan.query), querySignal); assertActive(); return summary;
          });
          queue = pending.catch(() => undefined); distributionCache.set(key, pending);
          return structuredClone(await resource(() => pending, querySignal, false));
        },
        async close() { invalidate(); },
      };
      return session;
    } catch (error) {
      const safe = error instanceof Error && (error.name === "AbortError" || "code" in error && ["ANALYSIS_SESSION_EXPIRED", "ANALYSIS_DATABASE_ERROR"].includes(String(error.code))) ? error : safeReadError("分析数据库读取失败，请检查连接与字段映射后重试");
      invalidate(undefined, safe); throw safe;
    }
  } };
}
