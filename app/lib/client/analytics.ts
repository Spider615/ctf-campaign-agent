import { VISUALIZATION_SCHEMA } from "../analytics/visualization-types.ts";
import { PLAN_ANSWER_V4_SCHEMA } from "../analytics/analysis-v2-types.ts";
import { consumeAnalyticsStream, validateAnalyticsAnswerResult } from "../analytics/stream.ts";
import type { AnalysisReport } from "../analytics/types.ts";
import { throwIfTurnCancelled } from "../cancellation.ts";

export const ANALYTICS_CHANGED = "ctf:analytics-changed";
async function fetchAnalyticsRequest(path: string, body?: unknown, signal?: AbortSignal, extraHeaders?: HeadersInit): Promise<Response> {
  throwIfTurnCancelled(signal);
  const headers = new Headers(extraHeaders); if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal,
    ...(body === undefined && extraHeaders === undefined ? {} : { headers }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function analyticsRequest<T>(path: string, body?: unknown, signal?: AbortSignal, extraHeaders?: HeadersInit): Promise<T> {
  const response = await fetchAnalyticsRequest(path, body, signal, extraHeaders);
  const result = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  throwIfTurnCancelled(signal);
  if (!response.ok || !result) throw new Error(typeof result?.error === "string" ? result.error : "分析请求暂时无法完成，请重试");
  return result;
}
export async function explainAnalyticsReport(report: AnalysisReport, question: string, signal?: AbortSignal) {
  const response = await fetchAnalyticsRequest(`/api/analytics/reports/${encodeURIComponent(report.id)}/explain`, { question }, signal, { "X-Analytics-Answer-Schema": PLAN_ANSWER_V4_SCHEMA, "X-Analytics-Visuals": VISUALIZATION_SCHEMA, accept: "application/x-ndjson" });
  throwIfTurnCancelled(signal);
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: unknown } | null; throwIfTurnCancelled(signal);
    throw new Error(typeof result?.error === "string" ? result.error : "报告分析暂未完成，可以重试");
  }
  if (response.headers.get("content-type")?.includes("application/x-ndjson")) return consumeAnalyticsStream(response, undefined, signal, report);
  const result = await response.json() as { explanation?: unknown }; throwIfTurnCancelled(signal);
  return validateAnalyticsAnswerResult(result.explanation, report);
}
export function notifyAnalyticsChanged() { window.dispatchEvent(new Event(ANALYTICS_CHANGED)); }
export function downloadCsv(name: string, rows: Array<Array<string | number | null>>) {
  const content = rows.map((row) => row.map((value) => {
    const raw = value === null ? "" : String(value);
    // 文本不能作为表格公式执行，数字仍保持数值口径。
    const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
