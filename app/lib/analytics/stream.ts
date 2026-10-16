import { throwIfTurnCancelled, TurnCancelledError } from "../cancellation.ts";
import type { AgentTraceEvent } from "../tool-trace.ts";
import { validateAnalyticsResponse } from "./explain.ts";
import { publicAnalyticsTrace } from "./trace.ts";
import type { AnalysisReport, AnalyticsExplainResult } from "./types.ts";
import { ANALYSIS_ANSWER_SCHEMA, type AnalysisAnswer } from "./analysis-v2-types.ts";
import { analysisAnswerText, validateAnalysisAnswer } from "./analysis-v2-evidence.ts";
import type { ConversationAnswer } from "../attachments/types.ts";
import { conversationAnswerText, isConversationAnswer, validateConversationAnswer } from "../attachments/answer.ts";
import type { VisualizationProgressEvent } from "./visualization-types.ts";
import { parseVisualizationProgress } from "./visualization-progress.ts";

export type AnalyticsAnswerResult = AnalyticsExplainResult | AnalysisAnswer | ConversationAnswer;
export type AnalyticsProgressEvent = { type: "trace"; event: AgentTraceEvent } | { type: "phase"; phase: "analyzing" | "writing"; at: number } | VisualizationProgressEvent;
export type AnalyticsStreamEvent = AnalyticsProgressEvent | { type: "result"; result: AnalyticsAnswerResult } | { type: "error"; error: string };
type AnalyticsWireEvent = AnalyticsStreamEvent | { type: "result_chunk"; index: number; delta: string } | { type: "result_end"; chunks: number; length: number };
const MAX_LINE = 2_000_000;
const RESULT_CHUNK_LENGTH = 128_000;
const MAX_RESULT_LENGTH = 64_000_000;

// 大结果保留全部引用和检查，拆成有序帧；过程事件与旧的小结果仍使用原合同。
export function encodeAnalyticsStreamEvent(event: AnalyticsStreamEvent): string {
  const json = JSON.stringify(event);
  if (event.type !== "result" || json.length <= MAX_LINE) return `${json}\n`;
  if (json.length > MAX_RESULT_LENGTH) throw new Error("营销分析结果过大，请缩小分析范围");
  const lines: string[] = [];
  for (let offset = 0; offset < json.length; offset += RESULT_CHUNK_LENGTH) lines.push(JSON.stringify({ type: "result_chunk", index: lines.length, delta: json.slice(offset, offset + RESULT_CHUNK_LENGTH) }));
  lines.push(JSON.stringify({ type: "result_end", chunks: lines.length, length: json.length }));
  return lines.join("\n") + "\n";
}

// 版本协商只选择回答合同；未知声明沿用旧路径，不改变访问权限。
export const normalizeAnalyticsAnswerSchema = (value: string | null | undefined) => value === ANALYSIS_ANSWER_SCHEMA ? ANALYSIS_ANSWER_SCHEMA : undefined;
export function isAnalysisAnswer(result: AnalyticsAnswerResult): result is AnalysisAnswer {
  return "schema" in result && result.schema === ANALYSIS_ANSWER_SCHEMA;
}
export function validateAnalyticsAnswerResult(value: unknown, report: AnalysisReport | null = null): AnalyticsAnswerResult {
  if (value && typeof value === "object" && "schema" in value) {
    if (isConversationAnswer(value)) { if (report) throw new Error("报告解读不能使用文件回答合同"); return validateConversationAnswer(value); }
    if (value.schema !== ANALYSIS_ANSWER_SCHEMA) throw new Error("营销回答合同版本不支持");
    return validateAnalysisAnswer(value);
  }
  return validateAnalyticsResponse(report, value);
}
export function analyticsAnswerText(result: AnalyticsAnswerResult): string {
  if (isConversationAnswer(result)) return conversationAnswerText(result);
  return isAnalysisAnswer(result) ? analysisAnswerText(result) : result.reply ?? result.advice?.map((item) => `${item.target?.label ?? ""}${item.text}`).join("\n") ?? "";
}

export function decodeAnalyticsStreamLine(line: string, report: AnalysisReport | null = null): AnalyticsWireEvent {
  if (!line.trim() || line.length > MAX_LINE) throw new Error("营销过程消息长度无效");
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("营销过程消息无效");
  const event = value as Record<string, unknown>;
  if (event.type === "visualization") return parseVisualizationProgress(event);
  if (event.type === "trace") return { type: "trace", event: publicAnalyticsTrace(event.event) };
  if (event.type === "phase" && ["analyzing", "writing"].includes(String(event.phase)) && typeof event.at === "number" && Number.isFinite(event.at) && event.at >= 0) return { type: "phase", phase: event.phase as "analyzing" | "writing", at: event.at };
  if (event.type === "result") return { type: "result", result: validateAnalyticsAnswerResult(event.result, report) };
  if (event.type === "result_chunk" && Number.isSafeInteger(event.index) && (event.index as number) >= 0 && (event.index as number) < Math.ceil(MAX_RESULT_LENGTH / RESULT_CHUNK_LENGTH) && typeof event.delta === "string" && event.delta.length > 0 && event.delta.length <= RESULT_CHUNK_LENGTH) return { type: "result_chunk", index: event.index as number, delta: event.delta };
  if (event.type === "result_end" && Number.isSafeInteger(event.chunks) && (event.chunks as number) > 0 && (event.chunks as number) <= Math.ceil(MAX_RESULT_LENGTH / RESULT_CHUNK_LENGTH) && Number.isSafeInteger(event.length) && (event.length as number) > 0 && (event.length as number) <= MAX_RESULT_LENGTH) return { type: "result_end", chunks: event.chunks as number, length: event.length as number };
  if (event.type === "error" && typeof event.error === "string" && event.error.trim() && event.error.length <= 1000) return { type: "error", error: event.error };
  throw new Error("营销过程消息类型无效");
}

// Workers 和浏览器共用分帧与结果校验；未核验的模型正文不能进入产品流。
export function consumeAnalyticsStream(response: Response, onProgress: ((event: AnalyticsProgressEvent) => void) | undefined, signal: AbortSignal | undefined, report: AnalysisReport): Promise<AnalyticsExplainResult | AnalysisAnswer>;
export function consumeAnalyticsStream(response: Response, onProgress?: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal, report?: AnalysisReport | null): Promise<AnalyticsAnswerResult>;
export async function consumeAnalyticsStream(response: Response, onProgress?: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal, report: AnalysisReport | null = null): Promise<AnalyticsAnswerResult> {
  throwIfTurnCancelled(signal);
  if (!response.body) throw new Error("营销服务没有返回数据流");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = ""; let result: AnalyticsAnswerResult | undefined; let terminal = false;
  const chunks: string[] = []; let resultLength = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const consume = (line: string) => {
    throwIfTurnCancelled(signal);
    if (!line.trim()) return;
    if (terminal) throw new Error("营销服务在最终结果后仍返回消息");
    const event = decodeAnalyticsStreamLine(line, report);
    if (event.type === "error") { terminal = true; throw new Error(event.error); }
    if (event.type === "result_chunk") {
      if (event.index !== chunks.length || resultLength + event.delta.length > MAX_RESULT_LENGTH) throw new Error("营销结果分块顺序或总长度无效");
      chunks.push(event.delta); resultLength += event.delta.length; return;
    }
    if (event.type === "result_end") {
      if (event.chunks !== chunks.length || event.length !== resultLength) throw new Error("营销结果分块不完整");
      const assembled: unknown = JSON.parse(chunks.join(""));
      if (!assembled || typeof assembled !== "object" || !("type" in assembled) || assembled.type !== "result" || !("result" in assembled)) throw new Error("营销结果分块内容无效");
      result = validateAnalyticsAnswerResult(assembled.result, report); terminal = true; chunks.length = 0; return;
    }
    if (chunks.length) throw new Error("营销结果分块尚未完整结束");
    if (event.type === "result") { terminal = true; result = event.result; }
    else onProgress?.(event);
  };
  try {
    while (true) {
      const part = await reader.read(); throwIfTurnCancelled(signal);
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
      if (buffer.length > MAX_LINE) throw new Error("营销过程消息过长");
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    if (!result) throw new Error("本次分析未返回完整答案，可以重试");
    return result;
  } catch (error) { if (signal?.aborted) throw new TurnCancelledError(); throw error; }
  finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
