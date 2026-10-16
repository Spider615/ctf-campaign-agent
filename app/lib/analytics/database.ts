import { normalizeDate } from "./import.ts";
import type { Period, AdvisorSource } from "./types.ts";
import type { AnalysisDataSession } from "./analysis-v2-types.ts";

export const HISTORY_DIMENSIONS = {
  overall: "整体", day: "日期", region: "大区", district: "分区", store: "门店", category: "业务小类", material: "材料", offer: "开单优惠名称",
  memberFlag: "是否会员销售", storeType: "分店性质", cityTier: "城市级别", mallGroup: "商场集团", offerRegion: "优惠与大区", regionCategory: "大区与货类",
  orderWeightBand: "订单成交部分克重分布", orderAmountBand: "订单成交部分金额分布",
} as const;
export type HistoryDimension = keyof typeof HISTORY_DIMENSIONS;
const filterColumns = { stores: "实体分店店号", regions: "大区描述", districts: "分区描述", categories: "业务小类描述", materials: "材料种类描述", offers: "优惠小类", memberFlags: "是否会员销售（1：是，0：否）", storeTypes: "分店性质" } as const;
export type HistoryQuery = { period: Period; by: HistoryDimension; population: "sales" | "net" | "recovery"; filters: Partial<Record<keyof typeof filterColumns, string[]>> };
export type DatabaseSummary = { available: boolean; name: string; minDate?: string; maxDate?: string; rowCount?: number; dimensions?: typeof HISTORY_DIMENSIONS; limitations: string[] };
export type DatabaseExplainRequest = { mode: "database"; question: string; history: Array<{ role: "user" | "assistant"; text: string }>; context?: string[] };
export type AnalyticsDatabase = { inspect(signal?: AbortSignal): Promise<DatabaseSummary>; query(input: unknown, signal?: AbortSignal): Promise<AdvisorSource[]>; openAnalysisSession?(signal?: AbortSignal): Promise<AnalysisDataSession> };
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function isDatabaseExplainRequest(value: unknown): value is DatabaseExplainRequest {
  return object(value) && Object.keys(value).every((key) => ["mode", "question", "history", "context"].includes(key)) && (value.context === undefined || Array.isArray(value.context) && value.context.length <= 200 && value.context.every((text) => typeof text === "string" && text.length <= 500)) && value.mode === "database" && typeof value.question === "string" && Boolean(value.question.trim()) && value.question.length <= 500 &&
    Array.isArray(value.history) && value.history.length <= 10 && value.history.every((item) => object(item) && ["user", "assistant"].includes(item.role as string) && typeof item.text === "string" && item.text.length <= 4000);
}

export function historyQuery(input: unknown): HistoryQuery {
  if (!object(input) || Object.keys(input).some((k) => !["period", "by", "population", "filters"].includes(k)) || !object(input.period) || typeof input.period.start !== "string" || typeof input.period.end !== "string") throw new Error("请提供历史分析周期和受支持条件");
  const period = { start: normalizeDate(input.period.start), end: normalizeDate(input.period.end) };
  if (period.start > period.end || new Date(period.end).getTime() - new Date(period.start).getTime() > 366 * 86400000) throw new Error("历史查询日期范围不正确");
  const by = input.by ?? "overall"; const population = input.population ?? "sales";
  if (typeof by !== "string" || !Object.hasOwn(HISTORY_DIMENSIONS, by)) throw new Error("没有这个历史分析维度");
  if (!["sales", "net", "recovery"].includes(population as string)) throw new Error("历史查询口径不正确");
  if (input.filters !== undefined && !object(input.filters)) throw new Error("历史筛选格式不正确");
  const filters: HistoryQuery["filters"] = {};
  for (const [key, values] of Object.entries(input.filters ?? {})) {
    if (!Object.hasOwn(filterColumns, key) || !Array.isArray(values) || values.length > 10 || values.some((v) => typeof v !== "string" || !v || v.length > 120)) throw new Error("历史筛选包含不支持的字段或取值");
    filters[key as keyof typeof filters] = [...new Set(values as string[])];
  }
  return { period, by: by as HistoryDimension, population: population as HistoryQuery["population"], filters };
}

const quoted = (name: string) => `\`${name}\``;
const completeSum = (name: string, money = false) => `CASE WHEN COUNT(${quoted(name)}) = COUNT(*) THEN ${money ? `SUM(ROUND(${quoted(name)} * 100, 0)) / 100` : `SUM(${quoted(name)})`} ELSE NULL END`;
export function buildSalesHistoryQuery(table: string, input: unknown) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) throw new Error("数据库表名不正确");
  const query = historyQuery(input); const values: string[] = [query.period.start.replaceAll("-", ""), query.period.end.replaceAll("-", "")];
  const where = ["`交易日期wid` BETWEEN ? AND ?", query.population === "sales" ? "(`销售件数` > 0 AND `实际销售金额` > 0)" : query.population === "net" ? "((`销售件数` > 0 AND `实际销售金额` >= 0) OR `销售件数` < 0)" : "(`销售件数` = 0 AND `实际销售金额` < 0)"];
  for (const [key, items] of Object.entries(query.filters)) if (items?.length) { where.push(`${quoted(filterColumns[key as keyof typeof filterColumns])} IN (${items.map(() => "?").join(",")})`); values.push(...items); }
  const labels: Partial<Record<HistoryDimension, string>> = {
    overall: "'全部选定成交记录'", day: "`交易日期wid`", region: "`大区描述`", district: "`分区描述`", store: "`实体分店店号`", category: "`业务小类描述`", material: "`材料种类描述`", offer: "`优惠小类`", memberFlag: "`是否会员销售（1：是，0：否）`", storeType: "`分店性质`", cityTier: "`城市级别`", mallGroup: "`商场集团`",
    offerRegion: "CONCAT(COALESCE(`优惠小类`, '未提供'), ' / ', COALESCE(`大区描述`, '未提供'))", regionCategory: "CONCAT(COALESCE(`大区描述`, '未提供'), ' / ', COALESCE(`业务小类描述`, '未提供'))",
  };
  const basicMetrics = `COUNT(*) AS rows_count, COUNT(DISTINCT \`实体分店店号\`) AS stores, CASE WHEN SUM(NULLIF(\`销售单号\`, '') IS NULL OR NULLIF(\`实体分店店号\`, '') IS NULL) = 0 THEN COUNT(DISTINCT \`实体分店店号\`, \`销售单号\`) ELSE NULL END AS orders, ${completeSum("实际销售金额", true)} AS amount, ${completeSum("销售件数")} AS quantity, ${completeSum("销售金重")} AS grams, ${completeSum("零售毛利", true)} AS profit, ${completeSum("销售牌仔价", true)} AS tag_amount`;
  let from = `${quoted(table)} WHERE ${where.join(" AND ")}`; let label = labels[query.by]; let metrics = basicMetrics;
  let definition = `${query.population === "sales" ? "销售正金额行：件数大于零且实收大于零" : query.population === "net" ? "销售、零元销售和退货的净额；不含零件数回收抵扣" : "零件数负金额的回收抵扣候选行，含义仍待业务确认"}。金额逐行按分汇总；零售毛利直接使用源字段，不按成本反推毛利率。订单按门店和单号组合去重，缺单号则不计算订单数。缺失指标不补零。`;
  if (query.by === "orderWeightBand" || query.by === "orderAmountBand") {
    if (query.population !== "sales") throw new Error("订单分布目前只支持销售正金额口径");
    const metric = query.by === "orderWeightBand" ? "grams" : "amount";
    label = query.by === "orderWeightBand" ? "CASE WHEN grams IS NULL THEN '克重未提供' WHEN grams < 5 THEN '低于5克' WHEN grams < 10 THEN '5至不足10克' WHEN grams < 20 THEN '10至不足20克' WHEN grams < 30 THEN '20至不足30克' ELSE '30克及以上' END" : "CASE WHEN amount IS NULL THEN '金额未提供' WHEN amount < 1000 THEN '低于1000元' WHEN amount < 3000 THEN '1000至不足3000元' WHEN amount < 5000 THEN '3000至不足5000元' WHEN amount < 10000 THEN '5000至不足10000元' ELSE '10000元及以上' END";
    from = `(SELECT \`实体分店店号\`, \`销售单号\`, COUNT(*) AS n, ${completeSum("实际销售金额", true)} AS amount, ${completeSum("销售件数")} AS quantity, ${completeSum("销售金重")} AS grams, ${completeSum("零售毛利", true)} AS profit, ${completeSum("销售牌仔价", true)} AS tag_amount FROM ${from} AND NULLIF(\`销售单号\`, '') IS NOT NULL AND NULLIF(\`实体分店店号\`, '') IS NOT NULL GROUP BY \`实体分店店号\`, \`销售单号\`) AS order_parts`;
    metrics = `SUM(n) AS rows_count, COUNT(DISTINCT \`实体分店店号\`) AS stores, COUNT(*) AS orders, ${["amount", "quantity", "grams", "profit", "tag_amount"].map((f) => `${completeSum(f)} AS ${f}`).join(", ")}`;
    definition += `按当前筛选内的成交部分重构订单后按${metric === "grams" ? "克重" : "金额"}固定分档；筛选外交易不计入，不能称为整张订单金额或克重。缺单号记录未参与此分布。`;
  }
  definition += "订单均额只覆盖当前分组和筛选内成交部分。每克金额与牌价实收差额应在同材料同货类内比较，不能视为每日金价，不等于活动的全部优惠。";
  const grouped = `SELECT COALESCE(${label}, '未提供') AS label, ${metrics} FROM ${from} GROUP BY label`;
  const ratios = query.population === "sales" ? "ROUND(amount / NULLIF(grams, 0), 6) AS amount_per_gram, ROUND((tag_amount - amount) / NULLIF(grams, 0), 6) AS gap_per_gram, ROUND(amount / NULLIF(orders, 0), 2) AS amount_per_order" : "NULL AS amount_per_gram, NULL AS gap_per_gram, NULL AS amount_per_order";
  return { sql: `SELECT /*+ MAX_EXECUTION_TIME(20000) */ grouped.*, ${ratios}, COUNT(*) OVER() AS group_count FROM (${grouped}) AS grouped ORDER BY ABS(amount) DESC, label LIMIT 20`, values, query, definition };
}
