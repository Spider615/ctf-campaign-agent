import { validateAnalysisQuery } from "./engine.ts";
import { DIMENSIONS, type AnalysisReport, type AnalyticsExplainRequest, type AnalyticsExplainResult, type Dimension } from "./types.ts";

export const ANALYTICS_TOOLS = ["inspect_dataset", "query_metrics", "discover_segments", "read_analysis_evidence"] as const;
export function selectedInsights(report: AnalysisReport, explanation: AnalyticsExplainResult | null) {
  return explanation === null ? report.insights : report.insights.filter((i) => explanation.insightIds.includes(i.id));
}
export type AnalyticsTool = typeof ANALYTICS_TOOLS[number];
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function isAnalyticsExplainRequest(value: unknown): value is AnalyticsExplainRequest {
  if (!object(value) || typeof value.question !== "string" || value.question.length > 500 || !object(value.report)) return false;
  const r = value.report;
  if (r.schema !== "analysis/v1" || typeof r.id !== "string" || typeof r.datasetVersion !== "string" ||
    !object(r.metrics) || !Array.isArray(r.groups) || r.groups.length > 180 || !Array.isArray(r.insights) || r.insights.length > 6 ||
    !Array.isArray(r.availableDimensions) || r.availableDimensions.some((d) => !DIMENSIONS.includes(d)) || !Array.isArray(r.limitations)) return false;
  try { validateAnalysisQuery(r.query); } catch { return false; }
  return r.groups.every((g) => object(g) && typeof g.id === "string" && typeof g.dimension === "string" && DIMENSIONS.includes(g.dimension as Dimension) && (g.current === null || object(g.current))) &&
    r.insights.every((i) => object(i) && typeof i.id === "string" && typeof i.evidenceId === "string" && typeof i.explanation === "string");
}

// 工具只读取保存的计算结果，模型不能改写数据、筛选或报告。
export function readAnalysisTool(report: AnalysisReport, name: AnalyticsTool, input: Record<string, unknown> = {}) {
  switch (name) {
    case "inspect_dataset": return { name: report.datasetName, provenance: report.provenance, version: report.datasetVersion, query: report.query, availableDimensions: report.availableDimensions, limitations: report.limitations };
    case "query_metrics": {
      if (input.dimension !== undefined && !report.availableDimensions.includes(input.dimension as Dimension)) throw new Error("该维度没有可用数据");
      return { metrics: report.metrics, baseline: report.baseline, groups: report.groups.filter((g) => !input.dimension || g.dimension === input.dimension) };
    }
    case "discover_segments": return { insights: report.insights, method: "在数据已提供的维度和交叉分组中比较净销售额，按差额绝对值展示；只选择每期至少 5 条明细的洞察，不证明因果" };
    case "read_analysis_evidence": {
      const group = report.groups.find((g) => g.id === input.evidenceId);
      if (!group) throw new Error("分析证据不存在");
      return { datasetVersion: report.datasetVersion, query: report.query, group };
    }
    default: throw new Error("没有这个分析工具");
  }
}

export function validateExplanation(report: AnalysisReport, value: unknown): AnalyticsExplainResult {
  if (!object(value) || !Array.isArray(value.insightIds) || !Array.isArray(value.nextDimensions)) throw new Error("AI 没有返回有效的证据选择");
  if (value.insightIds.length > 6 || value.insightIds.some((id) => typeof id !== "string" || !report.insights.some((i) => i.id === id))) throw new Error("AI 引用了不存在的洞察，结果未采用");
  if (value.nextDimensions.length > 3 || value.nextDimensions.some((d) => !report.availableDimensions.includes(d))) throw new Error("AI 引用了未提供数据的维度，结果未采用");
  return { insightIds: [...new Set(value.insightIds as string[])], nextDimensions: [...new Set(value.nextDimensions as Dimension[])], tools: [] };
}
