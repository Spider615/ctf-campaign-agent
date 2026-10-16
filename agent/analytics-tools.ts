import { datasetSummary } from "../app/lib/analytics/import.ts";
import { runAnalysis, validateAnalysisQuery } from "../app/lib/analytics/engine.ts";
import { reportSource } from "../app/lib/analytics/advisor.ts";
import { readAnalysisTool, validateExplanation, type AnalyticsTool } from "../app/lib/analytics/explain.ts";
import type { AnalysisReport, AnalyticsExplainRequest, AdvisorSource, Dimension } from "../app/lib/analytics/types.ts";
import { inspectHistoricalKnowledge, readHistoricalCase } from "./analytics-history.ts";
import type { AnalyticsDatabase, DatabaseExplainRequest } from "../app/lib/analytics/database.ts";

export function createAnalyticsTools(request: AnalyticsExplainRequest | DatabaseExplainRequest, historyDirectory?: string, database?: AnalyticsDatabase, signal?: AbortSignal) {
  const report = "report" in request ? request.report : null;
  const sources = new Map<string, AdvisorSource>(); const readIds = new Set<string>(); let calculations = 0;
  const remember = (source: AdvisorSource, read: boolean) => { sources.set(source.id, source); if (read) readIds.add(source.id); return source; };
  const register = (report: AnalysisReport, prefix: string, kind: AdvisorSource["kind"], dimension?: Dimension) => {
    const refs = [remember(reportSource(report, "overall", prefix, kind), false)];
    for (const group of report.groups.filter((g) => dimension && g.dimension === dimension)) refs.push(remember(reportSource(report, group.id, prefix, kind), false));
    return refs.map(({ id, title }) => ({ id, title }));
  };
  if (report) register(report, "report", "report");
  return {
    read(name: AnalyticsTool, args: Record<string, unknown> = {}): unknown {
      if (name === "query_sales_history") {
        if (report || !database) throw new Error("当前对话没有启用真实历史数据库");
        if (calculations >= 120) throw new Error("本回合已完成多次历史比较，请先聚焦已有证据");
        calculations++;
        return database.query(args.query, signal).then((refs) => { refs.forEach((source) => remember(source, true)); return { sources: refs }; });
      }
      if (!report && name === "inspect_dataset") { if (!database) throw new Error("历史数据库未启用"); return database.inspect(signal); }
      if (!report && name === "discover_segments") return { insights: [], analysisAngles: ["在同货类内核对优惠与区域差异", "按订单成交部分核对克重、金额分布及选择偏差", "拆分销售、退货与回收抵扣", "比较同店不同窗口，检查购买是否挪动"], method: "这些只是分析候选，必须实际查询后才能写成数据观察" };
      if (name === "inspect_historical_knowledge") return inspectHistoricalKnowledge(historyDirectory);
      if (name === "read_historical_case") {
        const refs = readHistoricalCase(historyDirectory, String(args.caseId)); refs.forEach((source) => remember(source, true)); return { sources: refs };
      }
      if (name === "analyze_snapshot") {
        const dataset = "dataset" in request ? request.dataset : undefined;
        if (!dataset) throw new Error("当前请求没有授权数据快照，不能重新计算");
        if (calculations >= 5) throw new Error("本回合已完成多次比较，请先根据已有证据给出建议");
        const query = validateAnalysisQuery(args.query);
        for (const p of [query.period, ...(query.comparison ? [query.comparison] : [])]) if (p.start < dataset.minDate || p.end > dataset.maxDate) throw new Error("分析周期超出当前授权数据快照");
        for (const [key, original] of Object.entries(report!.query.filters)) {
          if (!original?.length) continue;
          const requested = query.filters[key as keyof typeof query.filters];
          if (requested && (!requested.length || requested.some((v) => !original.includes(v)))) throw new Error("不能解除或扩大用户已指定的筛选范围");
          query.filters[key as keyof typeof query.filters] = original.filter((v) => !requested || requested.includes(v));
        }
        const computed = runAnalysis(dataset, query); const prefix = `snapshot:${++calculations}`;
        const dimension = args.dimension as Dimension | undefined;
        if (dimension && !computed.availableDimensions.includes(dimension)) throw new Error("所选维度没有可用数据");
        return { metrics: computed.metrics, baseline: computed.baseline, query: computed.query, limitations: computed.limitations,
          groups: computed.groups.filter((g) => dimension && g.dimension === dimension), evidence: register(computed, prefix, "snapshot", dimension) };
      }
      if (name === "read_analysis_evidence") {
        const id = String(args.evidenceId);
        const source = sources.get(id) ?? (report && (id === "overall" || report.groups.some((g) => g.id === id)) ? remember(reportSource(report, id), false) : undefined);
        if (!source) throw new Error("没有这条已计算的数据证据");
        readIds.add(source.id); return source;
      }
      if (!report) throw new Error("数据库对话请用query_sales_history读取真实结果");
      const result = readAnalysisTool(report, name, args);
      if (name === "inspect_dataset") return { ...result, snapshot: "dataset" in request && request.dataset ? datasetSummary(request.dataset) : null };
      if (name === "query_metrics") return { ...result, evidence: register(report, "report", "report", args.dimension as Dimension | undefined) };
      if (name === "discover_segments") {
        for (const insight of report.insights) remember(reportSource(report, insight.evidenceId), false);
        return { ...result, evidence: report.insights.map((i) => ({ insightId: i.id, sourceId: `report:${i.evidenceId}` })) };
      }
      return result;
    },
    finish(value: unknown) {
      const readSources = [...sources.values()].filter((s) => readIds.has(s.id));
      return validateExplanation(report, value, readSources, readSources.length ? "partial" : "model");
    },
  };
}
