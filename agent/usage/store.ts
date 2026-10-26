// 内部用量库：每个问答轮次一行、每次真实上游模型请求一行，存在仓库外的本机 SQLite。
// 渠道部署时二选一，但切换前后的记录并存，所以每行都带渠道；任何汇总都按渠道分开，不出跨渠道合计。
// 上游没给的 Token 子项存 NULL（SUM 全为 NULL 时仍是 NULL），页面据此显示「未提供」而不是 0。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CostEstimator } from "./pricing.ts";

export type UsageChannel = "deepseek" | "juzi";
export type UsageEntry = "analysis" | "attachments" | "campaign" | "insight";
export type TurnStatus = "running" | "answered" | "partial" | "failed" | "cancelled" | "interrupted";
export type RequestStatus = "running" | "done" | "error" | "incomplete" | "interrupted";
export type TraceStep = { title: string; status: string; summary?: string; startedAt: number; durationMs?: number };
export type TurnStart = { id: string; entry: UsageEntry; channel: UsageChannel; visitor: string | null; conversationId: string | null; internal: boolean; question: string; startedAt: number };
export type TurnFinish = { status: Exclude<TurnStatus, "running" | "interrupted">; reply: string | null; error: string | null; trace: TraceStep[]; finishedAt: number };
export type ModelRequestStart = { id: string; turnId: string; source: string; channel: UsageChannel; sdkModel: string; sentModel: string; vendor: string | null; vendorBasis: string; startedAt: number };
export type ModelRequestFinish = { status: Exclude<RequestStatus, "running" | "interrupted">; httpStatus: number | null; responseId: string | null; upstreamModel: string | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; finishedAt: number; vendor?: string };
export type UsageFilter = { from: string; to: string; entry?: UsageEntry; channel?: UsageChannel; model?: string; status?: TurnStatus; keyword?: string };
type Tokens = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
export type UsageOverview = {
  // costYuan：能定价的请求的估算费用合计；unpricedRequests：算不出价的请求数。
  days: Array<{ day: string; channel: UsageChannel; turns: number; requests: number; incompleteRequests: number; costYuan: number | null; unpricedRequests: number } & Tokens>;
  statuses: Record<TurnStatus, number>;
  models: Array<{ channel: UsageChannel; model: string; requests: number; inputTokens: number | null; outputTokens: number | null }>;
  durations: { turnsMs: { p50: number | null; p90: number | null } };
};
export type UsageConversationRow = { key: string; entry: UsageEntry; visitor: string | null; title: string; lastQuestion: string; turns: number; channels: UsageChannel[]; inputTokens: number | null; outputTokens: number | null; costYuan: number | null; unpricedRequests: number; durationMs: number; lastAt: number; internal: boolean };
export type UsageRequestRecord = ModelRequestStart & Partial<Omit<ModelRequestFinish, "status" | "vendor">> & { status: RequestStatus; costYuan: number | null };
export type UsageTurnRecord = TurnStart & Partial<Omit<TurnFinish, "status">> & { status: TurnStatus; sdkStarts: number; requests: UsageRequestRecord[]; costYuan: number | null; unpricedRequests: number };
export type UsageConversationDetail = { key: string; entry: UsageEntry; visitor: string | null; turns: UsageTurnRecord[] };
export type UsageStore = {
  startTurn(turn: TurnStart): void; finishTurn(id: string, result: TurnFinish): void; countSdkStart(turnId: string): void;
  startRequest(request: ModelRequestStart): void; finishRequest(id: string, result: ModelRequestFinish): void;
  overview(filter: UsageFilter): UsageOverview; conversations(filter: UsageFilter & { offset?: number }): UsageConversationRow[]; conversation(key: string): UsageConversationDetail | null;
  close(): void;
};

const TURN_STATUSES: TurnStatus[] = ["running", "answered", "partial", "failed", "cancelled", "interrupted"];
const PAGE = 50;
type Row = Record<string, unknown>;
type Param = string | number | null;

// 日期边界一律按北京时间。
export const beijingDay = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const conversationKey = (turn: Pick<TurnStart, "entry" | "conversationId" | "id">) => turn.conversationId ? `${turn.entry}:${turn.conversationId}` : `${turn.entry}:turn:${turn.id}`;
const num = (value: unknown) => value === null || value === undefined ? null : Number(value);
const optional = (value: unknown) => value === null || value === undefined ? undefined : value;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_turn (
  id TEXT PRIMARY KEY, conv_key TEXT NOT NULL, entry TEXT NOT NULL, channel TEXT NOT NULL, visitor TEXT, conversation_id TEXT,
  internal INTEGER NOT NULL, question TEXT NOT NULL, started_at INTEGER NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL,
  reply TEXT, error TEXT, trace_json TEXT, finished_at INTEGER, sdk_starts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_turn_day ON usage_turn(day);
CREATE INDEX IF NOT EXISTS usage_turn_conv ON usage_turn(conv_key);
CREATE TABLE IF NOT EXISTS usage_request (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL, sdk_model TEXT NOT NULL, sent_model TEXT NOT NULL,
  vendor TEXT, vendor_basis TEXT NOT NULL, started_at INTEGER NOT NULL, status TEXT NOT NULL, http_status INTEGER, response_id TEXT,
  upstream_model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS usage_request_turn ON usage_request(turn_id);`;

// 费用按查询时的价格表现算，不落库：改了单价，旧记录也按新价格重算。
export function createUsageStore(path: string, estimate: CostEstimator = () => null): UsageStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // 上次进程没收尾的记录：不凭时间推算完成，标为中断，已记下的 Token 保留。
  db.exec("UPDATE usage_turn SET status = 'interrupted' WHERE status = 'running'; UPDATE usage_request SET status = 'interrupted' WHERE status = 'running';");

  const all = (sql: string, params: Param[] = []) => db.prepare(sql).all(...params) as Row[];

  function where(filter: UsageFilter, alias = "t") {
    const clauses = [`${alias}.day BETWEEN ? AND ?`]; const params: Param[] = [filter.from, filter.to];
    if (filter.entry) { clauses.push(`${alias}.entry = ?`); params.push(filter.entry); }
    if (filter.channel) { clauses.push(`${alias}.channel = ?`); params.push(filter.channel); }
    if (filter.status) { clauses.push(`${alias}.status = ?`); params.push(filter.status); }
    if (filter.keyword) { clauses.push(`instr(${alias}.question, ?) > 0`); params.push(filter.keyword); }
    if (filter.model) { clauses.push(`EXISTS (SELECT 1 FROM usage_request m WHERE m.turn_id = ${alias}.id AND (m.sent_model = ? OR m.upstream_model = ?))`); params.push(filter.model, filter.model); }
    return { sql: clauses.join(" AND "), params };
  }

  function percentile(sorted: number[], p: number) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  }

  const costOf = (row: Row) => estimate({ channel: row.channel as UsageChannel, model: String(row.upstream_model ?? row.sent_model), startedAt: Number(row.started_at),
    inputTokens: num(row.input_tokens), outputTokens: num(row.output_tokens), cacheReadTokens: num(row.cache_read_tokens), cacheWriteTokens: num(row.cache_write_tokens) });
  // 合计能定价的部分；一次也定不了价时为 null。
  const total = (costs: Array<number | null>) => {
    const priced = costs.filter((cost): cost is number => cost !== null);
    return { costYuan: priced.length ? Math.round(priced.reduce((sum, cost) => sum + cost, 0) * 1e6) / 1e6 : null, unpricedRequests: costs.length - priced.length };
  };
  const costsByTurn = (turnIds: string[]) => {
    const map = new Map<string, Array<number | null>>();
    if (!turnIds.length) return map;
    for (const row of all(`SELECT * FROM usage_request WHERE turn_id IN (${turnIds.map(() => "?").join(", ")})`, turnIds)) {
      const list = map.get(String(row.turn_id)) ?? []; list.push(costOf(row)); map.set(String(row.turn_id), list);
    }
    return map;
  };

  function requestRecord(row: Row): UsageRequestRecord {
    return {
      costYuan: costOf(row),
      id: String(row.id), turnId: String(row.turn_id), source: String(row.source), channel: row.channel as UsageChannel, sdkModel: String(row.sdk_model), sentModel: String(row.sent_model),
      vendor: (row.vendor as string | null) ?? null, vendorBasis: String(row.vendor_basis), startedAt: Number(row.started_at), status: row.status as RequestStatus,
      httpStatus: num(row.http_status), responseId: (row.response_id as string | null) ?? null, upstreamModel: (row.upstream_model as string | null) ?? null,
      inputTokens: num(row.input_tokens), outputTokens: num(row.output_tokens), cacheReadTokens: num(row.cache_read_tokens), cacheWriteTokens: num(row.cache_write_tokens),
      finishedAt: optional(row.finished_at) === undefined ? undefined : Number(row.finished_at),
    };
  }

  return {
    startTurn(turn) {
      db.prepare("INSERT INTO usage_turn (id, conv_key, entry, channel, visitor, conversation_id, internal, question, started_at, day, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')")
        .run(turn.id, conversationKey(turn), turn.entry, turn.channel, turn.visitor, turn.conversationId, turn.internal ? 1 : 0, turn.question, turn.startedAt, beijingDay(turn.startedAt));
    },
    finishTurn(id, result) {
      db.prepare("UPDATE usage_turn SET status = ?, reply = ?, error = ?, trace_json = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .run(result.status, result.reply, result.error, JSON.stringify(result.trace), result.finishedAt, id);
    },
    countSdkStart(turnId) { db.prepare("UPDATE usage_turn SET sdk_starts = sdk_starts + 1 WHERE id = ?").run(turnId); },
    startRequest(request) {
      db.prepare("INSERT INTO usage_request (id, turn_id, source, channel, sdk_model, sent_model, vendor, vendor_basis, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')")
        .run(request.id, request.turnId, request.source, request.channel, request.sdkModel, request.sentModel, request.vendor, request.vendorBasis, request.startedAt);
    },
    finishRequest(id, result) {
      // 厂商只在开始时未确认、收尾时才拿到时补上，不覆盖已记的值。
      db.prepare("UPDATE usage_request SET status = ?, http_status = ?, response_id = ?, upstream_model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, finished_at = ?, vendor = COALESCE(vendor, ?) WHERE id = ? AND status = 'running'")
        .run(result.status, result.httpStatus, result.responseId, result.upstreamModel, result.inputTokens, result.outputTokens, result.cacheReadTokens, result.cacheWriteTokens, result.finishedAt, result.vendor ?? null, id);
    },
    overview(filter) {
      const { sql, params } = where(filter);
      const days = all(`SELECT t.day, t.channel, COUNT(DISTINCT t.id) AS turns, COUNT(r.id) AS requests,
          SUM(r.input_tokens) AS input, SUM(r.output_tokens) AS output, SUM(r.cache_read_tokens) AS cache_read, SUM(r.cache_write_tokens) AS cache_write,
          SUM(CASE WHEN r.status IN ('incomplete', 'interrupted') THEN 1 ELSE 0 END) AS incomplete
        FROM usage_turn t LEFT JOIN usage_request r ON r.turn_id = t.id WHERE ${sql} GROUP BY t.day, t.channel ORDER BY t.day, t.channel`, params)
        .map((row) => ({ day: String(row.day), channel: row.channel as UsageChannel, turns: Number(row.turns), requests: Number(row.requests), incompleteRequests: Number(row.incomplete ?? 0),
          inputTokens: num(row.input), outputTokens: num(row.output), cacheReadTokens: num(row.cache_read), cacheWriteTokens: num(row.cache_write), costYuan: null as number | null, unpricedRequests: 0 }));
      const dayCosts = new Map<string, Array<number | null>>();
      for (const row of all(`SELECT t.day, r.* FROM usage_turn t JOIN usage_request r ON r.turn_id = t.id WHERE ${sql}`, params)) {
        const key = `${row.day}|${row.channel}`; const list = dayCosts.get(key) ?? []; list.push(costOf(row)); dayCosts.set(key, list);
      }
      for (const day of days) Object.assign(day, total(dayCosts.get(`${day.day}|${day.channel}`) ?? []));
      const statuses = Object.fromEntries(TURN_STATUSES.map((status) => [status, 0])) as Record<TurnStatus, number>;
      for (const row of all(`SELECT t.status, COUNT(*) AS n FROM usage_turn t WHERE ${sql} GROUP BY t.status`, params)) statuses[row.status as TurnStatus] = Number(row.n);
      const models = all(`SELECT t.channel, COALESCE(r.upstream_model, r.sent_model) AS model, COUNT(*) AS requests, SUM(r.input_tokens) AS input, SUM(r.output_tokens) AS output
        FROM usage_turn t JOIN usage_request r ON r.turn_id = t.id WHERE ${sql} GROUP BY t.channel, model ORDER BY t.channel, requests DESC`, params)
        .map((row) => ({ channel: row.channel as UsageChannel, model: String(row.model), requests: Number(row.requests), inputTokens: num(row.input), outputTokens: num(row.output) }));
      const spans = all(`SELECT t.finished_at - t.started_at AS ms FROM usage_turn t WHERE ${sql} AND t.finished_at IS NOT NULL ORDER BY ms`, params).map((row) => Number(row.ms));
      return { days, statuses, models, durations: { turnsMs: { p50: percentile(spans, 0.5), p90: percentile(spans, 0.9) } } };
    },
    conversations(filter) {
      const { sql, params } = where(filter);
      // 先按筛选找到命中的会话，再汇总这些会话的全部轮次，免得关键词只命中一轮时轮数和 Token 被截掉。
      const keys = all(`SELECT t.conv_key, MAX(t.started_at) AS last_at FROM usage_turn t WHERE ${sql} GROUP BY t.conv_key ORDER BY last_at DESC LIMIT ? OFFSET ?`, [...params, PAGE, Math.max(0, filter.offset ?? 0)])
        .map((row) => String(row.conv_key));
      if (!keys.length) return [];
      const rows = all(`SELECT t.*, (SELECT SUM(input_tokens) FROM usage_request r WHERE r.turn_id = t.id) AS input, (SELECT SUM(output_tokens) FROM usage_request r WHERE r.turn_id = t.id) AS output
        FROM usage_turn t WHERE t.conv_key IN (${keys.map(() => "?").join(", ")}) ORDER BY t.started_at`, keys);
      const costs = costsByTurn(rows.map((row) => String(row.id)));
      return keys.map((key) => {
        const turns = rows.filter((row) => row.conv_key === key);
        const cost = total(turns.flatMap((row) => costs.get(String(row.id)) ?? []));
        const sum = (field: string) => turns.reduce<number | null>((total, row) => row[field] === null ? total : (total ?? 0) + Number(row[field]), null);
        return {
          key, entry: turns[0].entry as UsageEntry, visitor: (turns[0].visitor as string | null) ?? null, title: String(turns[0].question).slice(0, 30), lastQuestion: String(turns.at(-1)!.question),
          turns: turns.length, channels: [...new Set(turns.map((row) => row.channel as UsageChannel))], inputTokens: sum("input"), outputTokens: sum("output"), ...cost,
          durationMs: turns.reduce((total, row) => total + (row.finished_at === null ? 0 : Number(row.finished_at) - Number(row.started_at)), 0),
          lastAt: Math.max(...turns.map((row) => Number(row.started_at))), internal: turns.some((row) => Number(row.internal) === 1),
        };
      });
    },
    conversation(key) {
      const turns = all("SELECT * FROM usage_turn WHERE conv_key = ? ORDER BY started_at", [key]);
      if (!turns.length) return null;
      const requests = all(`SELECT * FROM usage_request WHERE turn_id IN (${turns.map(() => "?").join(", ")}) ORDER BY started_at`, turns.map((row) => String(row.id))).map(requestRecord);
      return {
        key, entry: turns[0].entry as UsageEntry, visitor: (turns[0].visitor as string | null) ?? null,
        turns: turns.map((row) => ({
          id: String(row.id), entry: row.entry as UsageEntry, channel: row.channel as UsageChannel, visitor: (row.visitor as string | null) ?? null, conversationId: (row.conversation_id as string | null) ?? null,
          internal: Number(row.internal) === 1, question: String(row.question), startedAt: Number(row.started_at), status: row.status as TurnStatus, sdkStarts: Number(row.sdk_starts),
          reply: (row.reply as string | null) ?? null, error: (row.error as string | null) ?? null, trace: row.trace_json ? JSON.parse(String(row.trace_json)) as TraceStep[] : undefined,
          finishedAt: row.finished_at === null ? undefined : Number(row.finished_at), requests: requests.filter((request) => request.turnId === row.id),
          ...total(requests.filter((request) => request.turnId === row.id).map((request) => request.costYuan)),
        })),
      };
    },
    close() { db.close(); },
  };
}
