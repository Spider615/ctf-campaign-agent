import { datasetSummary } from "../analytics/import.ts";
import type { AnalysisReport, AnalyticsDataset, DatasetSummary } from "../analytics/types.ts";
import { POC_WORKSPACE_OWNER } from "../poc-workspace.ts";

export type ReportSummary = Pick<AnalysisReport, "id" | "createdAt" | "datasetId" | "datasetVersion" | "datasetName" | "provenance" | "query">;
export type AnalyticsStore = {
  listDatasets(owner: string): Promise<DatasetSummary[]>;
  loadDataset(owner: string, id: string): Promise<AnalyticsDataset | null>;
  saveDataset(owner: string, dataset: AnalyticsDataset): Promise<void>;
  listReports(owner: string): Promise<ReportSummary[]>;
  loadReport(owner: string, id: string): Promise<AnalysisReport | null>;
  saveReport(owner: string, report: AnalysisReport): Promise<void>;
  listConversations(owner: string, scope: string): Promise<unknown[]>;
  listDeletedConversations(owner: string, scope: string): Promise<string[]>;
  saveConversation(owner: string, scope: string, id: string, thread: unknown, updatedAt: string): Promise<void>;
  deleteConversation(owner: string, id: string): Promise<void>;
};

export class AnalyticsError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function createAnalyticsStore(db: D1Database): AnalyticsStore {
  // 共享空间兼容旧浏览器名下的记录，原始快照、报告和归属字段无需迁移。
  const shared = (owner: string) => Number(owner === POC_WORKSPACE_OWNER);
  return {
    async listDatasets(owner) {
      const rows = await db.prepare("SELECT summary_json FROM analytics_dataset WHERE (owner_id = ? OR ? = 1) ORDER BY created_at DESC, rowid DESC LIMIT 30").bind(owner, shared(owner)).all<{ summary_json: string }>();
      return rows.results.map((r) => JSON.parse(r.summary_json) as DatasetSummary);
    },
    async loadDataset(owner, id) {
      const row = await db.prepare("SELECT snapshot_json FROM analytics_dataset WHERE id = ? AND (owner_id = ? OR ? = 1)").bind(id, owner, shared(owner)).first<{ snapshot_json: string }>();
      return row ? JSON.parse(row.snapshot_json) as AnalyticsDataset : null;
    },
    async saveDataset(owner, dataset) {
      await db.prepare("INSERT INTO analytics_dataset (id, owner_id, version, summary_json, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(dataset.id, owner, dataset.version, JSON.stringify(datasetSummary(dataset)), JSON.stringify(dataset), dataset.createdAt).run();
    },
    async listReports(owner) {
      const rows = await db.prepare("SELECT summary_json FROM analytics_report WHERE (owner_id = ? OR ? = 1) ORDER BY created_at DESC, rowid DESC LIMIT 30").bind(owner, shared(owner)).all<{ summary_json: string }>();
      return rows.results.map((r) => JSON.parse(r.summary_json) as ReportSummary);
    },
    async loadReport(owner, id) {
      const row = await db.prepare("SELECT report_json FROM analytics_report WHERE id = ? AND (owner_id = ? OR ? = 1)").bind(id, owner, shared(owner)).first<{ report_json: string }>();
      return row ? JSON.parse(row.report_json) as AnalysisReport : null;
    },
    async saveReport(owner, report) {
      const dataset = await db.prepare("SELECT version FROM analytics_dataset WHERE id = ? AND (owner_id = ? OR ? = 1)").bind(report.datasetId, owner, shared(owner)).first<{ version: string }>();
      if (!dataset || dataset.version !== report.datasetVersion) throw new AnalyticsError("数据集不存在或版本不一致", 404);
      const { id, createdAt, datasetId, datasetVersion, datasetName, provenance, query } = report;
      await db.prepare("INSERT INTO analytics_report (id, owner_id, dataset_id, summary_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, owner, datasetId, JSON.stringify({ id, createdAt, datasetId, datasetVersion, datasetName, provenance, query }), JSON.stringify(report), createdAt).run();
    },
    // 同编号的旧浏览器副本取最近更新的一份，保留最早建立顺序；再取最近更新的 100 条。
    async listConversations(owner, scope) {
      const rows = await db.prepare(`SELECT thread_json FROM (
        SELECT r, thread_json FROM (
          SELECT MIN(rowid) OVER (PARTITION BY id) AS r, thread_json, updated_at,
            ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC, rowid DESC) AS revision
          FROM conversation_thread WHERE (owner_id = ? OR ? = 1) AND scope = ?
            AND json_extract(thread_json, '$.deleted') IS NOT 1
        ) WHERE revision = 1 ORDER BY updated_at DESC, r DESC LIMIT 100
      ) ORDER BY r`).bind(owner, shared(owner), scope).all<{ thread_json: string }>();
      return rows.results.map((r) => JSON.parse(r.thread_json) as unknown);
    },
    async listDeletedConversations(owner, scope) {
      const rows = await db.prepare("SELECT DISTINCT id FROM conversation_thread WHERE (owner_id = ? OR ? = 1) AND (scope = ? OR scope = '*') AND json_extract(thread_json, '$.deleted') = 1")
        .bind(owner, shared(owner), scope).all<{ id: string }>();
      return rows.results.map((row) => row.id);
    },
    // 继续保存时沿用原行，不为旧浏览器记录再建副本；已有编号不能写到其他范围。
    async saveConversation(owner, scope, id, thread, updatedAt) {
      await db.prepare(`INSERT INTO conversation_thread (id, owner_id, scope, thread_json, updated_at)
        VALUES (?, COALESCE((SELECT owner_id FROM conversation_thread WHERE id = ? AND (owner_id = ? OR ? = 1)
          ORDER BY (scope = ?) DESC, updated_at DESC, rowid DESC LIMIT 1), ?), ?, ?, ?)
        ON CONFLICT (owner_id, id) DO UPDATE SET thread_json = excluded.thread_json, updated_at = excluded.updated_at
        WHERE conversation_thread.scope = excluded.scope AND json_extract(conversation_thread.thread_json, '$.deleted') IS NOT 1`)
        .bind(id, id, owner, shared(owner), scope, owner, scope, JSON.stringify(thread), updatedAt).run();
    },
    async deleteConversation(owner, id) {
      // 仅保留删除标记，清除正文；即使首次保存还在途中，旧缓存也不能把该编号重新写回来。
      // 尚无记录时用 * 表示任意对话范围，避免删除早于首次写入的竞态。
      const marker = JSON.stringify({ deleted: true }); const updatedAt = new Date().toISOString();
      await db.prepare(`INSERT INTO conversation_thread (id, owner_id, scope, thread_json, updated_at)
        SELECT id, owner_id, scope, ?, ? FROM conversation_thread WHERE (owner_id = ? OR ? = 1) AND id = ?
        UNION ALL SELECT ?, ?, '*', ?, ? WHERE 1
        ON CONFLICT (owner_id, id) DO UPDATE SET thread_json = excluded.thread_json, updated_at = excluded.updated_at`)
        .bind(marker, updatedAt, owner, shared(owner), id, id, owner, marker, updatedAt).run();
    },
  };
}
