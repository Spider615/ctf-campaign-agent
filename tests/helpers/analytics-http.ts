import type { AnalyticsDatabase } from "../../app/lib/analytics/database.ts";
import { createSnapshotAnalysisProvider } from "../../app/lib/analytics/analysis-v2-snapshot.ts";
import { sampleDataset } from "../../app/lib/analytics/sample.ts";
import { runAnalysis } from "../../app/lib/analytics/engine.ts";

// HTTP 测试使用完整的最小数据库合同，不靠问候绕过数据服务检查。
export function httpAnalyticsDatabase(): AnalyticsDatabase {
  const provider = createSnapshotAnalysisProvider(sampleDataset());
  return {
    inspect: async () => ({ available: true, name: "HTTP 合成历史数据", limitations: [] }),
    query: async () => { throw new Error("新问答不应调用旧查数接口"); },
    openAnalysisSession: (signal) => provider.open(signal),
  };
}

export function httpAnalyticsReportRequest(question = "会员效果差异") {
  const dataset = sampleDataset();
  const report = { ...runAnalysis(dataset, { period: { start: "2026-08-01", end: "2026-09-30" }, comparison: { start: "2025-08-01", end: "2025-09-30" }, filters: {} }), id: "http-report", createdAt: "2026-10-25" };
  return { report, dataset, question };
}
