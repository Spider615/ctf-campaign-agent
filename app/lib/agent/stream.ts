import { parseAgentResult, type AgentResult } from "./protocol.ts";
import { parseAgentTraceEvent, type AgentTraceEvent } from "../tool-trace.ts";

export type AgentStreamEvent =
  | { type: "trace"; event: AgentTraceEvent }
  | { type: "result"; result: AgentResult }
  | { type: "error"; error: string };

const MAX_STREAM_LINE = 256_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function encodeAgentStreamEvent(event: AgentStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
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
  if (value.type === "result") return { type: "result", result: parseAgentResult(value.result) };
  if (value.type === "error" && typeof value.error === "string" && value.error.trim()) return { type: "error", error: value.error.trim() };
  throw new Error("未知的 Agent 流事件");
}
