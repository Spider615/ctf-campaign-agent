import { validateAnalysisQuery } from "./engine.ts";
import { DIMENSIONS, MAX_SALES_ROWS, MAX_SNAPSHOT_BYTES, type AnalysisReport, type AnalyticsExplainRequest, type AnalyticsExplainResult, type Dimension } from "./types.ts";
import { normalizeDate } from "./import.ts";
import type { AdvisorSource } from "./types.ts";
import { composeAdvice, isAdvisorSource, reportSource } from "./advisor.ts";
import { isQuickAnalyticsReply } from "./dialogue.ts";
import { ANALYTICS_TOOLS } from "./tool-names.ts";
import { isToolTrace } from "../tool-trace.ts";
import { publicAnalyticsTrace } from "./trace.ts";

export { ANALYTICS_TOOLS } from "./tool-names.ts";
export function selectedInsights(report: AnalysisReport, explanation: AnalyticsExplainResult | null) {
  return explanation === null ? report.insights : report.insights.filter((i) => explanation.insightIds.includes(i.id));
}
export type AnalyticsTool = typeof ANALYTICS_TOOLS[number];
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const nullableNumber = (v: unknown) => v === null || finite(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
const metrics = (v: unknown) => object(v) && Number.isInteger(v.rows) && (v.rows as number) >= 0 && finite(v.sales) && finite(v.quantity) &&
  ["grossProfit", "grossMargin", "weightGrams", "orders", "members"].every((key) => nullableNumber(v[key]));
function isoDate(v: unknown): boolean {
  if (!text(v, 10)) return false;
  try { return normalizeDate(v as string) === v; } catch { return false; }
}

export function isAnalyticsExplainRequest(value: unknown): value is AnalyticsExplainRequest {
  if (!object(value) || typeof value.question !== "string" || value.question.length > 500 || !object(value.report)) return false;
  const r = value.report;
  if (r.schema !== "analysis/v1" || !text(r.id, 160) || !text(r.datasetId, 160) || !text(r.datasetVersion, 160) || !text(r.datasetName, 80) ||
    !["sample", "imported"].includes(r.provenance as string) || r.currency !== "CNY" || !metrics(r.metrics) || r.baseline !== null && !metrics(r.baseline) || !nullableNumber(r.salesChangePercent) ||
    !Array.isArray(r.groups) || r.groups.length > 180 || !Array.isArray(r.insights) || r.insights.length > 6 ||
    !Array.isArray(r.availableDimensions) || r.availableDimensions.some((d) => !DIMENSIONS.includes(d)) || !strings(r.limitations)) return false;
  try { validateAnalysisQuery(r.query); } catch { return false; }
  if (value.dataset !== undefined) {
    const d = value.dataset;
    if (!object(d) || d.schema !== "analytics-dataset/v1" || d.id !== r.datasetId || d.version !== r.datasetVersion ||
      d.provenance !== r.provenance || d.currency !== "CNY" || !text(d.name, 80) ||
      !Array.isArray(d.rows) || !d.rows.length || d.rows.length > MAX_SALES_ROWS || !strings(d.warnings) || !strings(d.sourceFiles) ||
      !Array.isArray(d.rules) || d.rules.length > MAX_SALES_ROWS || d.rules.some((rule) => !object(rule) || !text(rule.campaignId, 120) || !text(rule.name, 120) || rule.mechanism !== null && !text(rule.mechanism, 120) || !nullableNumber(rule.discountValue)) ||
      !isoDate(d.minDate) || !isoDate(d.maxDate) || !object(d.mappings) || [d.mappings.sales, d.mappings.campaigns].some((mapping) => !object(mapping) || !Object.values(mapping).every((v) => typeof v === "string")) ||
      d.rows.some((row) => !object(row) || !isoDate(row.date) || ["lineId", "store", "category"].some((key) => !text(row[key], 120) || !row[key]) ||
        ["orderId", "region", "city", "sku", "memberId", "memberSegment", "campaignId"].some((key) => row[key] !== null && !text(row[key], 120)) ||
        !finite(row.netSales) || !Number.isInteger(row.quantity) || !nullableNumber(row.cost) || !nullableNumber(row.weightGrams))) return false;
    const dates = d.rows.map((row) => row.date).sort();
    if (dates[0] !== d.minDate || dates.at(-1) !== d.maxDate || new Set(d.rows.map((row) => row.lineId)).size !== d.rows.length ||
      new TextEncoder().encode(JSON.stringify(d)).length > MAX_SNAPSHOT_BYTES) return false;
  }
  const groups = r.groups;
  return groups.every((g) => object(g) && text(g.id, 160) && DIMENSIONS.includes(g.dimension as Dimension) && text(g.value, 300) && strings(g.values) &&
    (g.current === null || metrics(g.current)) && (g.baseline === null || metrics(g.baseline)) && nullableNumber(g.salesChange) && nullableNumber(g.salesChangePercent)) &&
    r.insights.every((i) => object(i) && text(i.id, 160) && text(i.evidenceId, 160) && typeof i.explanation === "string" && groups.some((g) => g.id === i.evidenceId));
}

// 这里读取原报告；快照重算和历史资料由 Agent 侧受控工具处理。
export function readAnalysisTool(report: AnalysisReport, name: AnalyticsTool, input: Record<string, unknown> = {}) {
  switch (name) {
    case "inspect_dataset": return { name: report.datasetName, provenance: report.provenance, version: report.datasetVersion, query: report.query, availableDimensions: report.availableDimensions, limitations: report.limitations };
    case "query_metrics": {
      if (input.dimension !== undefined && !report.availableDimensions.includes(input.dimension as Dimension)) throw new Error("该维度没有可用数据");
      return { metrics: report.metrics, baseline: report.baseline, groups: report.groups.filter((g) => !input.dimension || g.dimension === input.dimension) };
    }
    case "discover_segments": return { insights: report.insights, method: "在数据已提供的维度和交叉分组中比较净销售额，按差额绝对值展示；只选择每期至少 5 条明细的洞察，不证明因果" };
    case "read_analysis_evidence": {
      if (input.evidenceId === "overall") return { datasetVersion: report.datasetVersion, query: report.query, metrics: report.metrics, baseline: report.baseline };
      const group = report.groups.find((g) => g.id === input.evidenceId);
      if (!group) throw new Error("分析证据不存在");
      return { datasetVersion: report.datasetVersion, query: report.query, group };
    }
    default: throw new Error("没有这个分析工具");
  }
}

export function validateExplanation(report: AnalysisReport | null, value: unknown, sources: readonly AdvisorSource[] = [], mode: "model" | "response" | "partial" = "model"): AnalyticsExplainResult {
  if (!object(value) || !Array.isArray(value.insightIds) || !Array.isArray(value.nextDimensions)) throw new Error("AI 没有返回有效的证据选择");
  if (value.insightIds.length > 6 || value.insightIds.some((id) => typeof id !== "string" || !report?.insights.some((i) => i.id === id))) throw new Error("AI 引用了不存在的洞察，结果未采用");
  if (value.nextDimensions.length > 3 || value.nextDimensions.some((d) => !report?.availableDimensions.includes(d))) throw new Error("AI 引用了未提供数据的维度，结果未采用");
  const result: AnalyticsExplainResult = { insightIds: [...new Set(value.insightIds as string[])], nextDimensions: [...new Set(value.nextDimensions as Dimension[])], tools: [] };
  if (value.advice !== undefined) Object.assign(result, composeAdvice(value.advice, sources, mode));
  return result;
}

export function validateAnalyticsResponse(report: AnalysisReport | null, value: unknown): AnalyticsExplainResult {
  if (!object(value)) throw new Error("营销回答无效");
  if (value.reply !== undefined) {
    if (!isQuickAnalyticsReply(value.reply) || ["insightIds", "nextDimensions", "tools", "skills", "sources", "advice"].some((key) => !Array.isArray(value[key]) || value[key].length !== 0)) throw new Error("轻量对话回答无效");
    return { insightIds: [], nextDimensions: [], tools: [], skills: [], sources: [], advice: [], reply: value.reply };
  }
  const sources = value.sources === undefined ? [] : value.sources;
  if (!Array.isArray(sources) || sources.length > 12 || sources.some((s) => !isAdvisorSource(s)) || new Set(sources.map((s) => s.id)).size !== sources.length) throw new Error("营销回答的数据来源无效");
  for (const source of sources) {
    if (!report) { if (!["database", "historical"].includes(source.kind)) throw new Error("数据库对话引用了其他数据模式的来源"); continue; }
    if (source.kind !== "historical" && (source.datasetVersion !== report.datasetVersion || source.provenance !== report.provenance)) throw new Error("营销回答引用的数据版本或类型不一致");
    if (source.kind === "report") {
      const expected = reportSource(report, source.reportEvidenceId ?? "");
      const content = (s: AdvisorSource) => [s.id, s.kind, s.title, s.provenance, s.datasetVersion, s.periodLabel, s.scope, s.definition, s.recordId,
        s.rows.map((row) => [row.label, row.fields.map((field) => [field.label, field.value, field.unit])]), s.statements, s.limitations, s.reportEvidenceId];
      if (JSON.stringify(content(source)) !== JSON.stringify(content(expected))) throw new Error("营销回答的报告来源与原计算证据不一致");
    }
  }
  const result = validateExplanation(report, value, sources, "response");
  if (value.partial !== undefined && value.partial !== true) throw new Error("营销回答的核验状态无效");
  if (value.partial === true) result.partial = true;
  result.tools = Array.isArray(value.tools) ? value.tools.filter((t): t is string => typeof t === "string" && (ANALYTICS_TOOLS as readonly string[]).includes(t)) : [];
  result.skills = Array.isArray(value.skills) ? value.skills.filter((s): s is string => s === "analytics:analysis-review" || s === "analytics:ctf-marketing-advisor") : [];
  if (value.trace !== undefined) {
    if (!isToolTrace(value.trace) || value.trace.steps.length > 100) throw new Error("营销过程记录无效");
    result.trace = { status: value.trace.status, durationMs: value.trace.durationMs, steps: value.trace.steps.map(publicAnalyticsTrace), ...(value.trace.timing ? { timing: { totalMs: value.trace.timing.totalMs, analysisWaitingMs: value.trace.timing.analysisWaitingMs, skillsToolsMs: value.trace.timing.skillsToolsMs } } : {}) };
  }
  return result;
}
