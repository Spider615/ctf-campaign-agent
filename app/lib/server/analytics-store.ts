import { datasetSummary } from "../analytics/import.ts";
import type { AnalysisReport, AnalyticsDataset, DatasetSummary } from "../analytics/types.ts";

export type ReportSummary = Pick<AnalysisReport, "id" | "createdAt" | "datasetId" | "datasetVersion" | "datasetName" | "provenance" | "query">;
export type AnalyticsStore = {
  listDatasets(owner: string): Promise<DatasetSummary[]>;
  loadDataset(owner: string, id: string): Promise<AnalyticsDataset | null>;
  saveDataset(owner: string, dataset: AnalyticsDataset): Promise<void>;
  listReports(owner: string): Promise<ReportSummary[]>;
  loadReport(owner: string, id: string): Promise<AnalysisReport | null>;
  saveReport(owner: string, report: AnalysisReport): Promise<void>;
  listConversations(owner: string, scope: string): Promise<unknown[]>;
  saveConversation(owner: string, scope: string, id: string, thread: unknown, updatedAt: string): Promise<void>;
  deleteConversation(owner: string, id: string): Promise<void>;
};

export class AnalyticsError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function createAnalyticsStore(db: D1Database): AnalyticsStore {
  return {
    async listDatasets(owner) {
      const rows = await db.prepare("SELECT summary_json FROM analytics_dataset WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30").bind(owner).all<{ summary_json: string }>();
      return rows.results.map((r) => JSON.parse(r.summary_json) as DatasetSummary);
    },
    async loadDataset(owner, id) {
      const row = await db.prepare("SELECT snapshot_json FROM analytics_dataset WHERE id = ? AND owner_id = ?").bind(id, owner).first<{ snapshot_json: string }>();
      return row ? JSON.parse(row.snapshot_json) as AnalyticsDataset : null;
    },
    async saveDataset(owner, dataset) {
      await db.prepare("INSERT INTO analytics_dataset (id, owner_id, version, summary_json, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(dataset.id, owner, dataset.version, JSON.stringify(datasetSummary(dataset)), JSON.stringify(dataset), dataset.createdAt).run();
    },
    async listReports(owner) {
      const rows = await db.prepare("SELECT summary_json FROM analytics_report WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30").bind(owner).all<{ summary_json: string }>();
      return rows.results.map((r) => JSON.parse(r.summary_json) as ReportSummary);
    },
    async loadReport(owner, id) {
      const row = await db.prepare("SELECT report_json FROM analytics_report WHERE id = ? AND owner_id = ?").bind(id, owner).first<{ report_json: string }>();
      return row ? JSON.parse(row.report_json) as AnalysisReport : null;
    },
    async saveReport(owner, report) {
      const dataset = await db.prepare("SELECT version FROM analytics_dataset WHERE id = ? AND owner_id = ?").bind(report.datasetId, owner).first<{ version: string }>();
      if (!dataset || dataset.version !== report.datasetVersion) throw new AnalyticsError("数据集不存在或版本不一致", 404);
      const { id, createdAt, datasetId, datasetVersion, datasetName, provenance, query } = report;
      await db.prepare("INSERT INTO analytics_report (id, owner_id, dataset_id, summary_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, owner, datasetId, JSON.stringify({ id, createdAt, datasetId, datasetVersion, datasetName, provenance, query }), JSON.stringify(report), createdAt).run();
    },
    // 取最近更新的 100 条，再按建立先后（rowid，覆盖写不改 rowid）排，和浏览器里的列表顺序一致。
    async listConversations(owner, scope) {
      const rows = await db.prepare("SELECT thread_json FROM (SELECT rowid AS r, thread_json FROM conversation_thread WHERE owner_id = ? AND scope = ? ORDER BY updated_at DESC LIMIT 100) ORDER BY r").bind(owner, scope).all<{ thread_json: string }>();
      return rows.results.map((r) => JSON.parse(r.thread_json) as unknown);
    },
    // 整条覆盖写；同一标识已属于别的范围时不改它。
    async saveConversation(owner, scope, id, thread, updatedAt) {
      await db.prepare("INSERT INTO conversation_thread (id, owner_id, scope, thread_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET thread_json = excluded.thread_json, updated_at = excluded.updated_at WHERE conversation_thread.scope = excluded.scope")
        .bind(id, owner, scope, JSON.stringify(thread), updatedAt).run();
    },
    async deleteConversation(owner, id) {
      await db.prepare("DELETE FROM conversation_thread WHERE owner_id = ? AND id = ?").bind(owner, id).run();
    },
  };
}
