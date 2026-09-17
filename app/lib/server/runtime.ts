import { env } from "cloudflare:workers";

import { getDbBinding } from "../../../db/index.ts";
import { parseAgentResult, type AgentRequest, type AgentResult } from "../agent/protocol.ts";
import { advanceAgentStreamLifecycle, decodeAgentStreamLine, type AgentStreamLifecycle } from "../agent/stream.ts";
import { isTurnCancelled, TurnCancelledError } from "../cancellation.ts";
import type { AgentTraceEvent, ToolTraceTiming } from "../tool-trace.ts";
import { createD1Store } from "./session-store.ts";
import { TurnError, type AgentTransientEvent, type TurnDeps } from "./turns.ts";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8788";

const agentHeaders = () => ({
  "content-type": "application/json",
  ...(env.AGENT_SERVICE_TOKEN ? { authorization: `Bearer ${env.AGENT_SERVICE_TOKEN}` } : {}),
});

async function agentFetch(url: string, request: AgentRequest, accept?: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { ...agentHeaders(), ...(accept ? { accept } : {}) },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isTurnCancelled(error)) throw new TurnCancelledError();
    throw new Error("连不上 Agent 服务，请先运行 npm run dev:agent");
  }
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
