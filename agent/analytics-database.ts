import mysql from "mysql2/promise";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_DIMENSIONS, buildSalesHistoryQuery, type AnalyticsDatabase, type DatabaseSummary } from "../app/lib/analytics/database.ts";
import { isAdvisorSource, sourceStatement } from "../app/lib/analytics/advisor.ts";
import type { AdvisorField, AdvisorSource } from "../app/lib/analytics/types.ts";
import { throwIfTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import { createMysqlAnalysisProvider } from "./analytics-operation-database.ts";

export const HISTORY_COLUMNS = ["_import_id", "交易日期wid", "实体分店店号", "销售单号", "实际销售金额", "销售件数", "销售金重", "零售毛利", "销售牌仔价", "币种描述", "优惠小类", "大区描述", "分区描述", "业务小类描述", "材料种类描述", "是否会员销售（1：是，0：否）", "分店性质", "城市级别", "商场集团"];
type Config = { host: string; port: number; user: string; password: string; database: string; table: string; evidenceDir: string };
export type HistoryConnection = { query(sql: string): Promise<[unknown, unknown]>; execute(sql: string, params?: string[]): Promise<[unknown, unknown]>; destroy(): void };
class HistoryReadError extends Error {}
const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))) throw new HistoryReadError("历史指标格式不正确");
  const n = Number(value); if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new HistoryReadError("历史指标超出计算范围"); return n;
};
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal | undefined, stop: () => void): Promise<T> {
  if (signal?.aborted) { stop(); void operation.catch(() => undefined); throw new TurnCancelledError(); } if (!signal) return operation;
  let abort = () => {};
  try { return await new Promise<T>((resolve, reject) => { abort = () => { stop(); reject(new TurnCancelledError()); }; signal.addEventListener("abort", abort, { once: true }); operation.then(resolve, reject); if (signal.aborted) abort(); }); }
  finally { signal.removeEventListener("abort", abort); }
}
const records = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value) || value.some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new HistoryReadError("数据库结果格式不正确"); return value;
};

// 重建视图包含大型货品、员工等关联。核对定义与唯一键后只保留本查询需要的投影，不修改视图。
export async function pruneRecoveredSource(connection: HistoryConnection, table: string, requiredColumns: readonly string[] = HISTORY_COLUMNS): Promise<string> {
  const ordinary = `\`${table}\``; if (table !== "sales_detail_202508") return ordinary;
  if (!requiredColumns.length || requiredColumns.some((column) => !HISTORY_COLUMNS.includes(column) && column !== "sku号")) return ordinary;
  let outer: unknown; let inner: unknown;
  try { [outer] = await connection.query("SHOW CREATE VIEW `sales_detail_202508`"); [inner] = await connection.query("SHOW CREATE VIEW `sales_detail_202508_rejoined`"); }
  catch (error) { if (error && typeof error === "object" && "code" in error && ["ER_WRONG_OBJECT", "ER_NO_SUCH_TABLE", "ER_TABLEACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR"].includes(String(error.code))) return ordinary; throw error; }
  const publicSql = String(records(outer)[0]?.["Create View"] ?? ""); const detailSql = String(records(inner)[0]?.["Create View"] ?? "");
  const normalizedFrom = (body: string) => (body.match(/`[^`]*`|[^`]+/g) ?? []).map((part) => part.startsWith("`") ? part : part.replace(/[\s()]/g, "").toLowerCase()).join("");
  const from = (sql: string) => normalizedFrom(sql.slice(sql.toLowerCase().lastIndexOf(" from ") + 6));
  const joins = [
    ["dim_branch_scd_recovered", "_branch_snapshot_id"], ["dim_branch_scd_recovered", "_source_branch_snapshot_id"], ["dim_stock_nature_d_recovered", "_stock_snapshot_id"], ["dim_mould_master_d_recovered", "_mould_snapshot_id"], ["dim_item_master_d_recovered", "_item_snapshot_id"], ["dim_calendar_observed", "_calendar_snapshot_id"], ["dim_staff_observed", "_staff_snapshot_id"], ["dim_sku_observed", "_sku_snapshot_id"], ["dim_same_store_observed", "_same_store_snapshot_id"], ["discount_observed", "_discount_snapshot_id"], ["campaign_observed", "_campaign_snapshot_id"],
  ];
  const join = ([name, alias]: string[]) => `LEFT JOIN \`${name}\` \`${alias}\` ON \`${alias}\`.\`_recovered_id\` = \`f\`.\`${alias}\``;
  const originalFrom = `\`dws_sales_daily_detail_mi_recovered\` \`f\` ${joins.map(join).join(" ")}`;
  if (from(publicSql) !== "`sales_detail_202508_rejoined`" || from(detailSql) !== normalizedFrom(originalFrom)) return ordinary;
  const projectionOf = (sql: string) => {
    const body = /\bAS\s+select\s+([\s\S]+)\s+from\s+/i.exec(sql)?.[1]; if (!body) return null;
    const origins = new Map<string, { alias: string; column: string }>(); let remaining = body;
    while (remaining.trim()) {
      const item = /^\s*`([^`]+)`\.`([^`]+)`\s+AS\s+`([^`]+)`\s*(,|$)/i.exec(remaining);
      if (!item || origins.has(item[3])) return null;
      origins.set(item[3], { alias: item[1], column: item[2] }); remaining = remaining.slice(item[0].length);
    }
    return origins;
  };
  const outerOrigins = projectionOf(publicSql); const origins = projectionOf(detailSql);
  if (!outerOrigins || !origins || HISTORY_COLUMNS.some((column) => outerOrigins.get(column)?.alias !== "sales_detail_202508_rejoined" || outerOrigins.get(column)?.column !== column)) return ordinary;
  const allowed = new Set(["f", "_branch_snapshot_id", "_stock_snapshot_id", "_discount_snapshot_id"]);
  if (HISTORY_COLUMNS.some((column) => !allowed.has(origins.get(column)?.alias ?? "") || origins.get(column)?.column !== column)) return ordinary;
  if (requiredColumns.includes("sku号") && (outerOrigins.get("sku号")?.column !== "sku号" || outerOrigins.get("sku号")?.alias !== "sales_detail_202508_rejoined" || origins.get("sku号")?.alias !== "_mould_snapshot_id" || origins.get("sku号")?.column !== "sku号")) return ordinary;
  for (const name of new Set(joins.map(([name]) => name))) {
    const [result] = await connection.query(`SHOW INDEX FROM \`${name}\` WHERE Key_name = 'PRIMARY'`); const primary = records(result);
    if (primary.length !== 1 || primary[0].Column_name !== "_recovered_id" || Number(primary[0].Non_unique) !== 0) return ordinary;
  }
  // 所有移除的关联均已验证为唯一键 LEFT JOIN，不改变行数；只保留本次真正需要的字段来源。
  const neededAliases = new Set(requiredColumns.map((column) => origins.get(column)!.alias));
  const projection = [...new Set(requiredColumns)].map((column) => `\`${origins.get(column)!.alias}\`.\`${column}\` AS \`${column}\``).join(", ");
  return `(SELECT ${projection} FROM \`dws_sales_daily_detail_mi_recovered\` \`f\` ${joins.filter(([, alias]) => neededAliases.has(alias)).map(join).join(" ")}) AS history_source`;
}

export function createMysqlAnalyticsDatabase(config: Config, dependencies: { connect: () => Promise<HistoryConnection> } = { connect: () => mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, charset: "utf8mb4", connectTimeout: 5000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true }) }): AnalyticsDatabase {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.table) || !config.database || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("本地历史数据库配置不正确");
  let cached: DatabaseSummary | null = null; let cachedAt = 0; let relation = `\`${config.table}\``; let currency = "原币";
  const run = async <T>(job: (connection: HistoryConnection) => Promise<T>, signal?: AbortSignal) => {
    throwIfTurnCancelled(signal);
    const connecting = dependencies.connect(); let connection: HistoryConnection | undefined;
    try {
      connection = await cancellable(connecting, signal, () => { void connecting.then((c) => c.destroy(), () => undefined); });
      const current = connection;
      return await cancellable((async () => { await current.query("SET SESSION TRANSACTION READ ONLY"); throwIfTurnCancelled(signal); await current.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY"); throwIfTurnCancelled(signal); return job(current); })(), signal, () => current.destroy());
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof HistoryReadError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ER_QUERY_TIMEOUT") throw new HistoryReadError("历史查询超时，请缩小周期或增加具体条件后核对");
      throw new Error("历史数据库读取失败，请检查连接与字段映射后重试");
    } finally { connection?.destroy(); }
  };
  const inspect = async (signal?: AbortSignal): Promise<DatabaseSummary> => {
    throwIfTurnCancelled(signal);
    if (cached && Date.now() - cachedAt < 60000) return cached;
    const summary = await run(async (connection) => {
      const [columns] = await connection.query(`SHOW COLUMNS FROM \`${config.table}\``);
      if (HISTORY_COLUMNS.some((name) => !records(columns).some((c) => c.Field === name))) throw new HistoryReadError("历史数据库缺少分析所需字段，请核对销售明细视图");
      relation = await pruneRecoveredSource(connection, config.table, ["_import_id", "交易日期wid", "币种描述"]);
      const [result] = await connection.execute(`SELECT /*+ MAX_EXECUTION_TIME(20000) */ COUNT(*) AS rows_count, COUNT(DISTINCT \`_import_id\`) AS unique_rows, MIN(\`交易日期wid\`) AS min_day, MAX(\`交易日期wid\`) AS max_day, COUNT(DISTINCT NULLIF(\`币种描述\`, '')) AS currencies, MIN(\`币种描述\`) AS currency, SUM(NULLIF(\`币种描述\`, '') IS NULL) AS missing_currency FROM ${relation}`);
      const row = records(result)[0];
      if (!row || !numeric(row.rows_count) || numeric(row.rows_count) !== numeric(row.unique_rows) || !/^\d{8}$/.test(String(row.min_day)) || !/^\d{8}$/.test(String(row.max_day))) throw new HistoryReadError("历史视图行数或日期异常，不能作为营销证据");
      if (numeric(row.currencies) !== 1 || numeric(row.missing_currency) !== 0 || typeof row.currency !== "string" || !row.currency || row.currency.length > 40) throw new HistoryReadError("历史数据币种混合或缺失，不能直接汇总金额，请先按币种整理数据");
      currency = row.currency;
      const date = (day: unknown) => String(day).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      return { available: true, name: "周大福历史经营数据", rowCount: numeric(row.rows_count)!, minDate: date(row.min_day), maxDate: date(row.max_day), dimensions: HISTORY_DIMENSIONS,
        limitations: ["探索口径，尚未与Power BI对数；销售、退货、回收抵扣分别分析", "金额来自源字段，币种与财务口径仍需核对；零售毛利不用于自动反推税率或毛利率", "有是否会员销售标识，没有独立会员身份与新老会员定义", "开单优惠名称不是完整活动规则；相关性不能证明因果或最佳力度"] };
    }, signal);
    cached = summary; cachedAt = Date.now(); return summary;
  };
  return { inspect, async openAnalysisSession(signal) { return createMysqlAnalysisProvider(config, { ...dependencies, pruneSource: pruneRecoveredSource }).open(signal); }, async query(input, signal) {
    const plan = buildSalesHistoryQuery(config.table, input); const summary = await inspect(signal);
    if (plan.query.period.start < summary.minDate! || plan.query.period.end > summary.maxDate!) throw new Error("查询周期超出当前历史数据覆盖范围，请依据已提供周期分析");
    return run(async (connection) => {
      // 查询时复核视图定义，避免后台修改定义后继续使用旧投影。
      const columns = HISTORY_COLUMNS.filter((column) => plan.sql.includes(`\`${column}\``) || column === "币种描述");
      const currentRelation = relation === `\`${config.table}\`` ? relation : await pruneRecoveredSource(connection, config.table, columns);
      const sql = plan.sql.replaceAll(`\`${config.table}\``, currentRelation).replace(" GROUP BY", " AND `币种描述` = ? GROUP BY");
      const params = [...plan.values, currency];
      const [result] = await connection.execute(sql, params); const data = records(result); if (!data.length) throw new HistoryReadError("该历史范围没有相关记录，不能解释为零销售");
      const capturedAt = new Date().toISOString(); const recordId = `Q-${randomUUID()}`;
      const capture = { schema: "ctf-mysql-evidence/v1", recordId, capturedAt, table: config.table, query: plan.query, sql, params, currency, rows: data };
      const version = createHash("sha256").update(JSON.stringify(capture)).digest("hex");
      const scope = Object.entries(plan.query.filters).filter(([, v]) => v?.length).map(([key, v]) => `${({ stores: "门店", regions: "大区", districts: "分区", categories: "货类", materials: "材料", offers: "开单优惠名称", memberFlags: "是否会员销售", storeTypes: "分店性质" } as Record<string, string>)[key]}：${v!.join("、")}`).join("；") || "当前数据库所提供历史，未附加筛选";
      const sources = data.map((row, index): AdvisorSource => {
        const fields: AdvisorField[] = [["rows_count", "成交明细", "条"], ["amount", plan.query.population === "net" ? "净成交金额" : plan.query.population === "recovery" ? "回收抵扣候选金额" : "成交金额", currency], ["quantity", "成交件数", "件"], ["grams", "成交金重", "克"], ["profit", "源字段零售毛利", currency], ["orders", "订单数", "单"], ["stores", "门店数", "家"], ["tag_amount", "销售牌仔价合计", currency], ["amount_per_gram", "每克实收代理值", `${currency}/克`], ["gap_per_gram", "每克牌价实收差额", `${currency}/克`], ["amount_per_order", "订单成交部分均额", `${currency}/单`]].map(([key, label, unit]) => ({ label, value: numeric(row[key]), unit }));
        const label = String(row.label ?? "未提供");
        const source: AdvisorSource = { id: `mysql:${recordId}:${index}`, kind: "database", title: `${HISTORY_DIMENSIONS[plan.query.by]}：${label}`, provenance: "imported", datasetVersion: version, capturedAt,
          periodLabel: `${plan.query.period.start}至${plan.query.period.end}`, scope: `${scope}；源币种：${currency}，未换汇`, definition: plan.definition, recordId, rows: [{ label, fields }], statements: [sourceStatement(label, fields)], limitations: [...summary.limitations, `本查询共${numeric(row.group_count) ?? data.length}组，按金额绝对值展示前20组；没有显示的组不能解释为无数据`] };
        if (!isAdvisorSource(source)) throw new HistoryReadError("历史来源超出证据合同，请缩小查询范围"); return source;
      });
      try { await mkdir(config.evidenceDir, { recursive: true }); await writeFile(join(config.evidenceDir, `${recordId}.json`), JSON.stringify({ ...capture, version, sources }, null, 2), { flag: "wx", mode: 0o600 }); }
      catch { throw new HistoryReadError("历史查询证据未能保存，本次结果不用于回答"); }
      return sources;
    }, signal);
  } };
}
