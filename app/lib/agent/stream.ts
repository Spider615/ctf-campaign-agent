import { parseAgentResult, type AgentResult } from "./protocol.ts";
import { isToolTraceTiming, parseAgentTraceEvent, type AgentTraceEvent, type ToolTraceTiming } from "../tool-trace.ts";

export type AgentPublicPhase = "analyzing" | "writing";

export type AgentProgressEvent =
  | { type: "trace"; event: AgentTraceEvent }
  | { type: "phase"; phase: AgentPublicPhase; at: number }
  | { type: "text_delta"; delta: string }
  | { type: "text_reset" };

export type AgentStreamEvent =
  | AgentProgressEvent
  | { type: "result"; result: AgentResult }
  | { type: "error"; error: string; timing?: ToolTraceTiming };

export type AgentStreamLifecycle = "open" | "result" | "error";

const MAX_STREAM_LINE = 256_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function encodeAgentStreamEvent(event: AgentStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

// result / error 都是终态。终态之后继续发文本、轨迹或另一个终态，说明协议损坏，
// 不能把已经成功的结果改判失败，也不能把结束后的文字继续展示给用户。
export function advanceAgentStreamLifecycle(
  state: AgentStreamLifecycle,
  event: AgentStreamEvent,
): AgentStreamLifecycle {
  if (state !== "open") throw new Error("Agent 服务在最终结果之后仍返回事件");
  if (event.type === "result") return "result";
  if (event.type === "error") return "error";
  return "open";
}

export function decodeAgentStreamLine(line: string): AgentStreamEvent {
  if (!line.trim()) throw new Error("Agent 流事件为空");
  if (line.length > MAX_STREAM_LINE) throw new Error("Agent 流事件过长");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Agent 流事件不是有效的 JSON");
  }
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Agent 流事件不完整");
  if (value.type === "trace") return { type: "trace", event: parseAgentTraceEvent(value.event) };
  if (value.type === "phase" && (value.phase === "analyzing" || value.phase === "writing") && typeof value.at === "number" && Number.isFinite(value.at) && value.at >= 0) {
    return { type: "phase", phase: value.phase, at: value.at };
  }
  if (value.type === "text_delta" && typeof value.delta === "string" && value.delta.length > 0 && value.delta.length <= 32_000) {
    return { type: "text_delta", delta: value.delta };
  }
  if (value.type === "text_reset") return { type: "text_reset" };
  if (value.type === "result") return { type: "result", result: parseAgentResult(value.result) };
  if (value.type === "error" && typeof value.error === "string" && value.error.trim() && (value.timing === undefined || isToolTraceTiming(value.timing))) {
    return { type: "error", error: value.error.trim(), ...(value.timing ? { timing: value.timing } : {}) };
  }
  throw new Error("未知的 Agent 流事件");
}
