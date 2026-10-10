import { readEvidence, runAnalysis, validateAnalysisQuery } from "../analytics/engine.ts";
import { datasetSummary, importDataset } from "../analytics/import.ts";
import { sampleImport } from "../analytics/sample.ts";
import { MAX_SNAPSHOT_BYTES, type AnalyticsDataset, type ImportDatasetInput } from "../analytics/types.ts";
import { AnalyticsError, type AnalyticsStore } from "./analytics-store.ts";

const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export async function createDataset(owner: string, body: unknown, store: AnalyticsStore) {
  if (!record(body)) throw new AnalyticsError("请提供导入内容");
  const dataset = importDataset(body.sample === true ? sampleImport() : body as unknown as ImportDatasetInput);
  const fingerprint = JSON.stringify({ rows: dataset.rows, rules: dataset.rules, mappings: dataset.mappings, currency: dataset.currency, provenance: dataset.provenance });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
  dataset.id = crypto.randomUUID(); dataset.createdAt = new Date().toISOString();
  dataset.version = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  if (new TextEncoder().encode(JSON.stringify(dataset)).length > MAX_SNAPSHOT_BYTES) throw new AnalyticsError("保存后的数据快照超过 1.5 MiB，请缩小范围");
  await store.saveDataset(owner, dataset);
  return datasetSummary(dataset);
}
export async function requireDataset(owner: string, id: string, store: AnalyticsStore): Promise<AnalyticsDataset> {
  const dataset = await store.loadDataset(owner, id);
  if (!dataset) throw new AnalyticsError("数据集不存在，请在当前浏览器重新导入或选择", 404);
  return dataset;
}
export async function createReport(owner: string, body: unknown, store: AnalyticsStore) {
  if (!record(body) || typeof body.datasetId !== "string") throw new AnalyticsError("请先选择数据集");
  const query = validateAnalysisQuery(body.query);
  const dataset = await requireDataset(owner, body.datasetId, store);
  const report = runAnalysis(dataset, query);
  if (body.question !== undefined) {
    if (typeof body.question !== "string" || body.question.length > 500) throw new AnalyticsError("关注问题应为 500 字以内的文本");
    report.question = body.question;
  }
  report.id = crypto.randomUUID(); report.createdAt = new Date().toISOString();
  await store.saveReport(owner, report);
  return report;
}
export async function requireReport(owner: string, id: string, store: AnalyticsStore) {
  const report = await store.loadReport(owner, id);
  if (!report) throw new AnalyticsError("分析报告不存在或不属于当前浏览器", 404);
  return report;
}
export async function reportEvidence(owner: string, id: string, evidenceId: string, store: AnalyticsStore) {
  const report = await requireReport(owner, id, store);
  const dataset = await requireDataset(owner, report.datasetId, store);
  return readEvidence(dataset, report, evidenceId);
}
