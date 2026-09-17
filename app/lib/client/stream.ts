import type { Snapshot } from "../server/turns.ts";
import type { AgentPublicPhase } from "../agent/stream.ts";
import { parseAgentTraceEvent, type AgentTraceEvent } from "../tool-trace.ts";
import { ApiError } from "./api.ts";

type TurnStreamEvent =
  | { type: "trace"; event: AgentTraceEvent }
  | { type: "phase"; phase: AgentPublicPhase; at: number }
  | { type: "text_delta"; delta: string }
  | { type: "text_reset" }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "error"; error: string };

export type TurnStreamHandlers = {
  onTrace?: (event: AgentTraceEvent) => void;
  onPhase?: (phase: AgentPublicPhase, at: number) => void;
  onTextDelta?: (delta: string) => void;
  onTextReset?: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || !isRecord(value.session) || typeof value.session.id !== "string") {
    throw new Error("服务没有返回完整的活动结果");
  }
  return value as Snapshot;
}

function parseTurnStreamLine(line: string): TurnStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("服务返回了无法识别的流数据");
  }
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("服务返回了不完整的流数据");
  if (value.type === "trace") return { type: "trace", event: parseAgentTraceEvent(value.event) };
  if (value.type === "phase" && (value.phase === "analyzing" || value.phase === "writing") && typeof value.at === "number" && Number.isFinite(value.at) && value.at >= 0) {
    return { type: "phase", phase: value.phase, at: value.at };
  }
  if (value.type === "text_delta" && typeof value.delta === "string" && value.delta.length > 0 && value.delta.length <= 32_000) {
    return { type: "text_delta", delta: value.delta };
  }
  if (value.type === "text_reset") return { type: "text_reset" };
  if (value.type === "snapshot") return { type: "snapshot", snapshot: parseSnapshot(value.snapshot) };
  if (value.type === "error" && typeof value.error === "string" && value.error.trim()) return { type: "error", error: value.error.trim() };
  throw new Error("服务返回了未知的流事件");
}

async function httpError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return new ApiError(response.status, typeof body.error === "string" && body.error ? body.error : "请求失败，请重试");
}

export async function consumeTurnStream(response: Response, handlers: TurnStreamHandlers): Promise<Snapshot> {
  if (!response.ok) throw await httpError(response);
  if (!response.body) throw new Error("服务没有返回数据流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let snapshot: Snapshot | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    if (snapshot) throw new Error("最终结果之后还有多余的流事件");
    const event = parseTurnStreamLine(line);
    if (event.type === "trace") handlers.onTrace?.(event.event);
    if (event.type === "phase") handlers.onPhase?.(event.phase, event.at);
    if (event.type === "text_delta") handlers.onTextDelta?.(event.delta);
    if (event.type === "text_reset") handlers.onTextReset?.();
    if (event.type === "snapshot") snapshot = event.snapshot;
    if (event.type === "error") throw new ApiError(503, event.error);
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
  if (!snapshot) throw new Error("服务没有返回最终结果，可以重试");
  return snapshot;
}
