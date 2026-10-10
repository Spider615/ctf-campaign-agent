import { normalizeDate } from "./import.ts";
import { DIMENSIONS, DIMENSION_LABELS, type AnalysisGroup, type AnalysisQuery, type AnalysisReport, type AnalyticsDataset, type Dimension, type EvidenceResult, type Metrics, type Period, type SalesRow } from "./types.ts";

const groupKeys: Record<Dimension, Array<keyof SalesRow>> = {
  region: ["region"], city: ["city"], store: ["store"], category: ["category"], sku: ["sku"],
  memberSegment: ["memberSegment"], campaignId: ["campaignId"], regionCategory: ["region", "category"], categoryMember: ["category", "memberSegment"],
};
const filterKeys = { stores: "store", regions: "region", categories: "category", campaignIds: "campaignId", memberSegments: "memberSegment" } as const;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function periodOf(value: unknown): Period {
  if (!record(value) || typeof value.start !== "string" || typeof value.end !== "string") throw new Error("请提供分析开始和结束日期");
  const period = { start: normalizeDate(value.start), end: normalizeDate(value.end) };
  if (period.start > period.end) throw new Error("开始日期不能晚于结束日期");
  return period;
}
export function validateAnalysisQuery(value: unknown): AnalysisQuery {
  if (!record(value)) throw new Error("分析请求格式不正确");
  const period = periodOf(value.period); const comparison = value.comparison ? periodOf(value.comparison) : null;
  if (comparison && period.start <= comparison.end && comparison.start <= period.end) throw new Error("分析期和比较期不能重叠");
  if (value.filters !== undefined && !record(value.filters)) throw new Error("筛选条件格式不正确");
  const filters: AnalysisQuery["filters"] = {};
  for (const [key, items] of Object.entries(value.filters ?? {})) {
    if (!Object.hasOwn(filterKeys, key) || !Array.isArray(items) || items.length > 100 || items.some((v) => typeof v !== "string" || !v || v.length > 120)) throw new Error("筛选条件包含不支持的字段或取值");
    filters[key as keyof typeof filterKeys] = [...new Set(items as string[])];
  }
  return { period, comparison, filters };
}

const inPeriod = (r: SalesRow, p: Period) => r.date >= p.start && r.date <= p.end;
function selectedRows(dataset: AnalyticsDataset, query: AnalysisQuery) {
  return dataset.rows.filter((r) => Object.entries(query.filters).every(([key, values]) => !values?.length || values.includes(r[filterKeys[key as keyof typeof filterKeys]] ?? "")));
}
const rounded = (v: number, decimals = 2) => Number(v.toFixed(decimals));
export function aggregateMetrics(rows: SalesRow[]): Metrics {
  const cents = rows.reduce((n, r) => n + Math.round(r.netSales * 100), 0);
  const profit = rows.length && rows.every((r) => r.cost !== null) ? cents - rows.reduce((n, r) => n + Math.round(r.cost! * 100), 0) : null;
  return {
    rows: rows.length, sales: cents / 100, quantity: rows.reduce((n, r) => n + r.quantity, 0),
    grossProfit: profit === null ? null : profit / 100, grossMargin: profit !== null && cents > 0 ? rounded(profit / cents * 100) : null,
    weightGrams: rows.length && rows.every((r) => r.weightGrams !== null) ? rounded(rows.reduce((n, r) => n + r.weightGrams!, 0), 6) : null,
    orders: rows.length && rows.every((r) => r.orderId !== null) ? new Set(rows.map((r) => r.orderId)).size : null,
    members: rows.length && rows.every((r) => r.memberId !== null) ? new Set(rows.map((r) => r.memberId)).size : null,
  };
}
export function changePercent(current: number, baseline: number): number | null {
  return baseline > 0 ? rounded((current - baseline) / baseline * 100) : null;
}
function valuesOf(row: SalesRow, dimension: Dimension): string[] { return groupKeys[dimension].map((k) => String(row[k] ?? "未提供")); }
const fmt = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export function runAnalysis(dataset: AnalyticsDataset, input: AnalysisQuery): AnalysisReport {
  if (!dataset.id || !dataset.version) throw new Error("请先保存数据集并确认数据版本");
  const query = validateAnalysisQuery(input); const scope = selectedRows(dataset, query);
  const currentRows = scope.filter((r) => inPeriod(r, query.period));
  const baselineRows = query.comparison ? scope.filter((r) => inPeriod(r, query.comparison!)) : [];
  if (!currentRows.length) throw new Error("当前范围没有销售明细，请调整日期或筛选条件");
  const metrics = aggregateMetrics(currentRows); const baseline = query.comparison && baselineRows.length ? aggregateMetrics(baselineRows) : null;
  const covered = [...currentRows, ...baselineRows];
  const availableDimensions = DIMENSIONS.filter((d) => covered.some((r) => groupKeys[d].every((k) => r[k] !== null && r[k] !== "未知")));
  const limitations = [...dataset.warnings];
  limitations.push("指标只覆盖所提供的销售明细；未导入的交易不能视为没有销售，历史差异不能直接归因于优惠力度");
  if (query.comparison && !baselineRows.length) limitations.push("比较期没有销售明细，不能计算增长率或推断活动变化");
  else if (baseline && baseline.sales <= 0) limitations.push("比较期净销售额不大于 0，未计算销售增长率");
  if (metrics.grossProfit === null && !limitations.some((x) => x.includes("成本"))) limitations.push("所选明细成本不完整，未计算整体毛利");
  const groups: AnalysisGroup[] = [];
  for (const dimension of availableDimensions) {
    const buckets = new Map<string, { values: string[]; current: SalesRow[]; baseline: SalesRow[] }>();
    const add = (r: SalesRow, side: "current" | "baseline") => {
      const values = valuesOf(r, dimension); const key = JSON.stringify(values);
      if (!buckets.has(key)) buckets.set(key, { values, current: [], baseline: [] });
      buckets.get(key)![side].push(r);
    };
    currentRows.forEach((r) => add(r, "current")); baselineRows.forEach((r) => add(r, "baseline"));
    const computed = [...buckets.values()].map((b) => {
      const current = b.current.length ? aggregateMetrics(b.current) : null; const base = query.comparison && b.baseline.length ? aggregateMetrics(b.baseline) : null;
      const value = dimension === "campaignId"
        ? `${dataset.rules.find((r) => r.campaignId === b.values[0])?.name ?? b.values[0]}（${b.values[0]}）`
        : b.values.join(" / ");
      return { id: "", dimension, values: b.values, value, current, baseline: base, salesChange: current && base ? rounded(current.sales - base.sales) : null, salesChangePercent: current && base ? changePercent(current.sales, base.sales) : null };
    }).sort((a, b) => Math.abs((query.comparison ? b.salesChange : b.current?.sales) ?? 0) - Math.abs((query.comparison ? a.salesChange : a.current?.sales) ?? 0) || a.value.localeCompare(b.value, "zh-CN"));
    if (computed.length > 20) limitations.push(`${DIMENSION_LABELS[dimension]}有 ${computed.length} 组，本报告展示销售变化绝对值最大的前 20 组`);
    computed.slice(0, 20).forEach((g, i) => groups.push({ ...g, id: `${dimension}-${i + 1}` }));
  }
  if (groups.some((g) => !g.current || query.comparison && !g.baseline)) limitations.push("部分分组缺少某期明细，标为无明细，不将其解释为零销售，也不计算差额或增长率");
  limitations.push("分组洞察只选择分析期、以及存在时的比较期均至少 5 条明细的分组；差异不是因果或统计显著性证明");
  const insights = groups.filter((g): g is AnalysisGroup & { current: Metrics } => g.current !== null && g.current.rows >= 5 && (!query.comparison || (g.baseline?.rows ?? 0) >= 5))
    .sort((a, b) => Math.abs((query.comparison ? b.salesChange : b.current.sales) ?? 0) - Math.abs((query.comparison ? a.salesChange : a.current.sales) ?? 0)).slice(0, 6).map((g, i) => ({
      id: `insight-${i + 1}`, kind: "observation" as const, evidenceId: g.id,
      title: `${DIMENSION_LABELS[g.dimension]}「${g.value}」${query.comparison ? "的销售变化" : "的销售表现"}`,
      explanation: query.comparison
        ? `分析期 ${g.current.rows} 条明细，净销售额 ${fmt(g.current.sales)} 元；比较期 ${g.baseline!.rows} 条，净销售额 ${fmt(g.baseline!.sales)} 元。差额 ${fmt(g.salesChange!)} 元${g.salesChangePercent === null ? "，未计算增长率" : `，变化 ${fmt(g.salesChangePercent)}%`}。这些是观测差异，仍需结合活动条件核对解释。`
        : `本范围 ${g.current.rows} 条明细，净销售额 ${fmt(g.current.sales)} 元，净件数 ${g.current.quantity}。尚未设置比较期，不能据此判断增长或活动增量。`,
    }));
  return {
    schema: "analysis/v1", id: "", createdAt: "", datasetId: dataset.id, datasetVersion: dataset.version, datasetName: dataset.name,
    provenance: dataset.provenance, currency: dataset.currency, query, metrics, baseline,
    salesChangePercent: baseline ? changePercent(metrics.sales, baseline.sales) : null,
    availableDimensions: [...availableDimensions], groups, insights, limitations: [...new Set(limitations)],
  };
}

export function readEvidence(dataset: AnalyticsDataset, report: AnalysisReport, evidenceId: string): EvidenceResult {
  if (dataset.version !== report.datasetVersion || dataset.id !== report.datasetId) throw new Error("数据版本与报告不一致，不能替换原始证据");
  const group = report.groups.find((g) => g.id === evidenceId);
  if (evidenceId !== "overall" && !group) throw new Error("没有这条分析证据");
  const rows = selectedRows(dataset, report.query).filter((r) => !group || JSON.stringify(valuesOf(r, group.dimension)) === JSON.stringify(group.values));
  const currentRows = rows.filter((r) => inPeriod(r, report.query.period));
  const baselineRows = report.query.comparison ? rows.filter((r) => inPeriod(r, report.query.comparison!)) : [];
  const ids = new Set([...currentRows, ...baselineRows].map((r) => r.campaignId));
  return { datasetVersion: dataset.version, title: group ? `${DIMENSION_LABELS[group.dimension]}：${group.value}` : "本次分析的全部销售明细", currentRows, baselineRows, rules: dataset.rules.filter((r) => ids.has(r.campaignId)), query: report.query };
}
