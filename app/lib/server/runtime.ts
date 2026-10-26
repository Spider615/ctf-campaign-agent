import { env } from "cloudflare:workers";
import { visualizationCapability } from "../analytics/visualization.ts";

import { getDbBinding } from "../../../db/index.ts";
import { parseAgentResult, type AgentRequest, type AgentResult } from "../agent/protocol.ts";
import { advanceAgentStreamLifecycle, decodeAgentStreamLine, type AgentStreamLifecycle } from "../agent/stream.ts";
import { isTurnCancelled, TurnCancelledError } from "../cancellation.ts";
import type { AgentTraceEvent, ToolTraceTiming } from "../tool-trace.ts";
import { createD1Store } from "./session-store.ts";
import type { AnalyticsExplainRequest } from "../analytics/types.ts";
import type { DatabaseExplainRequest, DatabaseSummary } from "../analytics/database.ts";
import { withKeepAlive } from "./keep-alive.ts";
import { consumeAnalyticsStream, normalizeAnalyticsAnswerSchema, validateAnalyticsAnswerResult, type AnalyticsProgressEvent } from "../analytics/stream.ts";
import { TurnError, type AgentTransientEvent, type TurnDeps } from "./turns.ts";
import type { ConversationRequest } from "../attachments/types.ts";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8788";

// 仍由这个模块维护唯一 Workers 环境入口，分析领域与存储不读取环境。
export function analyticsDbBinding() { return getDbBinding(); }

const agentHeaders = () => ({
  "content-type": "application/json",
  ...(env.AGENT_SERVICE_TOKEN ? { authorization: `Bearer ${env.AGENT_SERVICE_TOKEN}` } : {}),
});

// 文件字节单独流式转发，身份只来自已验证的浏览器 cookie。
export async function forwardAttachmentRequest(request: Request, owner: string, body?: ConversationRequest) {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const url = new URL(request.url); const suffix = body ? "/answer/stream" : url.pathname.slice("/api/analytics/attachments".length);
  if (!body && !/^\/(?:[0-9a-f-]{36}(?:\/(?:content|preview|retry|image\/i\d+))?)?$/.test(suffix || "/")) throw new Error("附件接口路径无效");
  const headers = new Headers(agentHeaders()); headers.set("x-attachments-owner", owner);
  headers.set("content-type", body ? "application/json" : request.headers.get("content-type") ?? "application/octet-stream");
  if (body) headers.set("X-Conversation-Answer-Schema", "conversation-answer/v1");
  const visuals = visualizationCapability(request.headers.get("X-Analytics-Visuals")); if (body && visuals) headers.set("X-Analytics-Visuals", visuals);
  const query = body ? `?conversationId=${encodeURIComponent(body.conversationId)}` : url.search;
  const response = await fetch(`${base}/attachments${suffix}${query}`, { method: body ? "POST" : request.method, headers, body: body ? JSON.stringify(body) : ["GET", "HEAD"].includes(request.method) ? undefined : request.body, signal: request.signal });
  const outgoing = new Headers(response.headers); outgoing.set("cache-control", "no-store"); outgoing.set("x-content-type-options", "nosniff");
  return new Response(body && response.ok && response.body ? withKeepAlive(response.body) : response.body, { status: response.status, headers: outgoing });
}


async function agentFetch(url: string, request: AgentRequest | AnalyticsExplainRequest | DatabaseExplainRequest, accept?: string, signal?: AbortSignal, answerSchema?: string, visualizationSchema?: string, run?: { id: string; owner: string }): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { ...agentHeaders(), ...(accept ? { accept } : {}), ...(run ? { "x-analytics-run-id": run.id, "x-analytics-owner": run.owner } : {}), ...(normalizeAnalyticsAnswerSchema(answerSchema) ? { "X-Analytics-Answer-Schema": normalizeAnalyticsAnswerSchema(answerSchema)! } : {}), ...(visualizationCapability(visualizationSchema) ? { "X-Analytics-Visuals": visualizationCapability(visualizationSchema)! } : {}) },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isTurnCancelled(error)) throw new TurnCancelledError();
    throw new Error("连不上 Agent 服务，请先运行 npm run dev:agent");
  }
}

export async function explainAnalytics(request: AnalyticsExplainRequest, signal?: AbortSignal, answerSchema?: string, visualizationSchema?: string) {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await agentFetch(`${base}/analytics/explain`, request, undefined, signal, answerSchema, visualizationSchema);
  if (!response.ok) throw await agentHttpError(response);
  return validateAnalyticsAnswerResult(await response.json(), request.report);
}

export async function inspectHistoryDatabase(signal?: AbortSignal): Promise<DatabaseSummary> {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await fetch(`${base}/analytics/database`, { headers: agentHeaders(), signal });
  if (!response.ok) throw await agentHttpError(response);
  return await response.json() as DatabaseSummary;
}
// 洞察图谱只有一张：Agent 启动时预热、查询结果落盘，命中缓存时立即返回。
export async function fetchInsightGraph(signal?: AbortSignal): Promise<Response> {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  // 和其他 Agent 请求一样只跟随浏览器取消，不另设墙钟超时；Agent 侧每条查询有 3 分钟上限。
  const response = await fetch(`${base}/insight/graph`, { headers: agentHeaders(), signal });
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8" } });
}

// 图谱问答：请求体原样转给 Agent（Agent 侧校验）。
export async function askInsightGraph(body: string, signal?: AbortSignal): Promise<Response> {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await fetch(`${base}/insight/ask`, { method: "POST", headers: agentHeaders(), body, signal });
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8" } });
}

export async function explainHistoryDatabase(request: DatabaseExplainRequest, signal?: AbortSignal, answerSchema?: string, visualizationSchema?: string) {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await agentFetch(`${base}/analytics/database/explain`, request, undefined, signal, answerSchema, visualizationSchema);
  if (!response.ok) throw await agentHttpError(response);
  return validateAnalyticsAnswerResult(await response.json());
}

// 带运行标识时 Agent 按运行登记：这条连接断了分析照常跑完，之后用同一标识重新连上。
export async function explainHistoryDatabaseStream(request: DatabaseExplainRequest, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal, answerSchema?: string, visualizationSchema?: string, run?: { id: string; owner: string }) {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await agentFetch(`${base}/analytics/database/explain/stream`, request, "application/x-ndjson", signal, answerSchema, visualizationSchema, run);
  if (!response.ok) throw await agentHttpError(response);
  return consumeAnalyticsStream(response, onProgress, signal);
}

export async function resumeHistoryRun(run: { id: string; owner: string }, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal) {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  let response: Response;
  try { response = await fetch(`${base}/analytics/runs/${encodeURIComponent(run.id)}/stream`, { headers: { ...agentHeaders(), accept: "application/x-ndjson", "x-analytics-owner": run.owner }, signal }); }
  catch (error) { if (signal?.aborted || isTurnCancelled(error)) throw new TurnCancelledError(); throw new Error("连不上 Agent 服务，请先运行 npm run dev:agent"); }
  if (!response.ok) throw await agentHttpError(response);
  return consumeAnalyticsStream(response, onProgress, signal);
}

export async function cancelHistoryRun(run: { id: string; owner: string }) {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  // 找不到说明已经结束或服务重启过，停止本来就无事可做。
  await fetch(`${base}/analytics/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", headers: { ...agentHeaders(), "x-analytics-owner": run.owner } }).catch(() => undefined);
}

async function agentHttpError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof body?.error === "string" ? body.error : `Agent 服务出错（${response.status}）`);
}

async function runAgentJson(base: string, request: AgentRequest, signal?: AbortSignal): Promise<AgentResult> {
  const response = await agentFetch(`${base}/turn`, request, undefined, signal);
  if (!response.ok) throw await agentHttpError(response);
  return parseAgentResult(await response.json().catch(() => null));
}

// Agent 服务（agent/server.ts）跑 Claude Agent SDK；Workers 转发真实工具事件，最终仍只接受受校验的 AgentResult。
async function runAgentRemote(
  request: AgentRequest,
  onTrace?: (event: AgentTraceEvent) => void,
  onProgress?: (event: AgentTransientEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await agentFetch(`${base}/turn/stream`, request, "application/x-ndjson", signal);
  if (response.status === 404) return runAgentJson(base, request, signal);
  if (!response.ok) throw await agentHttpError(response);
  if (!response.body) throw new Error("Agent 服务没有返回数据流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AgentResult | null = null;
  let lifecycle: AgentStreamLifecycle = "open";
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = decodeAgentStreamLine(line);
    lifecycle = advanceAgentStreamLifecycle(lifecycle, event);
    if (event.type === "trace") onTrace?.(event.event);
    if (event.type === "phase" || event.type === "text_delta" || event.type === "text_reset") onProgress?.(event);
    if (event.type === "result") {
      result = event.result;
    }
    if (event.type === "error") throw new AgentRemoteError(event.error, event.timing);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!result) throw new Error("Agent 服务没有返回最终结果");
  return result;
}

class AgentRemoteError extends Error {
  timing?: ToolTraceTiming;

  constructor(message: string, timing?: ToolTraceTiming) {
    super(message);
    this.name = "AgentRemoteError";
    this.timing = timing;
  }
}

export function todayInShanghai(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function runtimeDeps(
  emitTrace?: (event: AgentTraceEvent) => void,
  emitProgress?: (event: AgentTransientEvent) => void,
  signal?: AbortSignal,
): TurnDeps {
  return {
    store: createD1Store(getDbBinding()),
    runAgent: (request, onTrace, onProgress) =>
      runAgentRemote(request, onTrace, onProgress, signal),
    today: todayInShanghai(),
    signal,
    emitTrace,
    emitProgress,
  };
}

export function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof TurnError) return Response.json({ error: error.message }, { status: error.status });
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 503 });
}

export function publicTurnError(error: unknown): { status: number; error: string } {
  if (error instanceof TurnError) return { status: error.status, error: error.message };
  return { status: 503, error: "没保存成功，可以重试" };
}
