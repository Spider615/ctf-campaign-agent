import { throwIfTurnCancelled } from "../cancellation.ts";
import { ANALYSIS_FILTER_DIMENSIONS, analysisMetricDefinitions, analysisMoneyCents, analysisSessionExpired, normalizeAnalysisAggregateQuery } from "./analysis-v2-operations.ts";
import type { AnalysisAggregateCell, AnalysisCapabilities, AnalysisDataProvider, AnalysisDataSession, AnalysisDimension, AnalysisMetric, AnalysisPopulation } from "./analysis-v2-types.ts";
import type { AnalyticsDataset, SalesRow } from "./types.ts";
import { aggregateScenarioRows, normalizeScenarioQuery } from "./analysis-v2-scenarios.ts";

const snapshotDimensions: Partial<Record<AnalysisDimension, keyof SalesRow>> = { day: "date", store: "store", region: "region", category: "category", sku: "sku", memberSegment: "memberSegment", offer: "campaignId" };
const dimensionValue = (row: SalesRow, dimension: AnalysisDimension): string | undefined => {
  const field = snapshotDimensions[dimension]; const value = field ? row[field] : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
};
const orderKey = (row: SalesRow) => row.store?.trim() && row.orderId?.trim() ? `${Array.from(row.store).length}:${row.store}:${row.orderId}` : undefined;
const participates = (row: SalesRow, population: AnalysisPopulation) => population === "sales" ? row.quantity > 0 && row.netSales > 0 : population === "net" ? row.quantity > 0 && row.netSales >= 0 || row.quantity < 0 : population === "returns" ? row.quantity < 0 : population === "zero_sales" ? row.quantity > 0 && row.netSales === 0 : row.quantity === 0 && row.netSales < 0;
function cellsFor(rows: SalesRow[], by: Array<AnalysisDimension | "order">): AnalysisAggregateCell[] {
  const groups = new Map<string, SalesRow[]>();
  for (const row of rows) { const key = JSON.stringify(by.map((dimension) => dimension === "order" ? orderKey(row) ?? null : dimensionValue(row, dimension) ?? null)); groups.set(key, [...(groups.get(key) ?? []), row]); }
  return [...groups].map(([key, selected]) => {
    const values: Array<string | null> = JSON.parse(key); const dimensions: AnalysisAggregateCell["dimensions"] = {};
    by.forEach((dimension, i) => { if (values[i] !== null) dimensions[dimension] = values[i]; });
    const total = (get: (row: SalesRow) => number | null, money = false): number | null => {
      const values = selected.map(get); if (values.some((value) => value === null || !Number.isFinite(value))) return null;
      const n = values.reduce<number>((sum, value) => sum + (money ? analysisMoneyCents(value!) : value!), 0);
      if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error("快照指标超出安全计算范围");
      return money ? n / 100 : n;
    };
    return { dimensions, rows: selected.length, amount: total((row) => row.netSales, true), quantity: total((row) => row.quantity), grams: total((row) => row.weightGrams),
      profit: selected.every((row) => row.cost !== null) ? selected.reduce((sum, row) => sum + analysisMoneyCents(row.netSales) - analysisMoneyCents(row.cost!), 0) / 100 : null,
      orders: selected.every((row) => orderKey(row)) ? new Set(selected.map(orderKey)).size : null,
      stores: selected.every((row) => row.store?.trim()) ? new Set(selected.map((row) => row.store)).size : null, tag_amount: null };
  });
}

export function createSnapshotAnalysisProvider(source: AnalyticsDataset): AnalysisDataProvider {
  // 保留导入版本；外部对象的后续编辑不能改变已打开的数据会话。
  const dataset = structuredClone(source);
  if (!dataset || dataset.schema !== "analytics-dataset/v1" || typeof dataset.currency !== "string" || !dataset.currency || !Array.isArray(dataset.rows)) throw new Error("分析快照格式或币种不正确");
  const dimensions = (Object.keys(snapshotDimensions) as AnalysisDimension[]).filter((dimension) => dataset.rows.some((row) => dimensionValue(row, dimension) !== undefined));
  const metrics: AnalysisMetric[] = ["amount", "quantity", "rows", "stores"];
  if (dataset.rows.some((row) => row.weightGrams !== null)) metrics.push("grams");
  if (dataset.rows.some((row) => row.cost !== null)) metrics.push("profit");
  if (dataset.rows.some((row) => orderKey(row))) metrics.push("orders", "amount_per_order");
  const capabilities: AnalysisCapabilities = { mode: "snapshot", name: dataset.name, coverage: { start: dataset.minDate, end: dataset.maxDate }, currency: dataset.currency, provenance: dataset.provenance, dimensions,
    metrics: analysisMetricDefinitions(dataset.currency, metrics, "snapshot"), methods: ["aggregate", "compare", "decompose", "scan", "robustness"], scenarios: /^(?:CNY|人民币|RMB|元)$/.test(dataset.currency) ? ["per_item", "amount_rate", ...(metrics.includes("grams") && dimensions.includes("category") && dimensions.includes("material") ? ["per_gram" as const] : []), ...(metrics.includes("orders") ? ["per_order" as const, "order_threshold" as const] : [])] : [],
    limitations: [...dataset.warnings, "观察数据上的算术比较不证明活动因果或最佳力度", "缺少门店开闭店与完整订单状态；共同观察门店不是正式同店", "导入快照没有材料、牌仔价或源零售毛利字段，不能重建这些指标", "订单仅指当前筛选内的成交部分；缺店号或单号记录不用于完整订单计算"] };
  return { async open(signal?: AbortSignal): Promise<AnalysisDataSession> {
    throwIfTurnCancelled(signal); let active = true; const cache = new Map<string, AnalysisAggregateCell[]>();
    const assertActive = () => { if (!active) throw analysisSessionExpired(); };
    const invalidate = () => { active = false; cache.clear(); };
    signal?.addEventListener("abort", invalidate, { once: true });
    const session: AnalysisDataSession = { snapshotId: `snapshot-${crypto.randomUUID()}`, datasetVersion: dataset.version, capabilities: structuredClone(capabilities), assertActive,
      async aggregate(input, querySignal) {
        if (querySignal?.aborted || signal?.aborted) invalidate();
        throwIfTurnCancelled(querySignal); throwIfTurnCancelled(signal); assertActive(); const query = normalizeAnalysisAggregateQuery(input, capabilities); const key = JSON.stringify(query); const cached = cache.get(key);
        if (cached) return structuredClone(cached);
        const excludedStores = new Set(query.excludeStores); const excludedOrders = new Set(query.excludeOrders);
        const rows = dataset.rows.filter((row) => row.date >= query.scope.period.start && row.date <= query.scope.period.end && participates(row, query.scope.population) && !excludedStores.has(row.store) && !excludedOrders.has(orderKey(row) ?? "") &&
          Object.entries(query.scope.filters).every(([key, values]) => values!.includes(dimensionValue(row, ANALYSIS_FILTER_DIMENSIONS[key as keyof typeof ANALYSIS_FILTER_DIMENSIONS]) ?? "")));
        const cells = cellsFor(rows, query.by); throwIfTurnCancelled(querySignal); throwIfTurnCancelled(signal); assertActive(); cache.set(key, cells); return structuredClone(cells);
      },
      async scenario(input, querySignal) {
        if (querySignal?.aborted || signal?.aborted) invalidate();
        throwIfTurnCancelled(querySignal); throwIfTurnCancelled(signal); assertActive(); const query = normalizeScenarioQuery(input, capabilities);
        const rows = dataset.rows.filter((row) => row.date >= query.scope.period.start && row.date <= query.scope.period.end && participates(row, "sales") && Object.entries(query.scope.filters).every(([key, values]) => values!.includes(dimensionValue(row, ANALYSIS_FILTER_DIMENSIONS[key as keyof typeof ANALYSIS_FILTER_DIMENSIONS]) ?? "")));
        const result = aggregateScenarioRows(rows.map((row) => ({ amount: row.netSales, grams: row.weightGrams, quantity: row.quantity, orderKey: orderKey(row) })), query.adjustment);
        throwIfTurnCancelled(querySignal); throwIfTurnCancelled(signal); assertActive(); return result;
      },
      async close() { invalidate(); signal?.removeEventListener("abort", invalidate); },
    };
    return session;
  } };
}
