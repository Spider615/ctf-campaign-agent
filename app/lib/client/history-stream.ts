import { VISUALIZATION_SCHEMA } from "../analytics/visualization-types.ts";
import type { DatabaseExplainRequest } from "../analytics/database.ts";
import { consumeAnalyticsStream, validateAnalyticsAnswerResult, type AnalyticsProgressEvent } from "../analytics/stream.ts";
import { PLAN_ANSWER_V4_SCHEMA } from "../analytics/analysis-v2-types.ts";
import { throwIfTurnCancelled } from "../cancellation.ts";

// runId 让这次回答在服务端独立跑完：刷新页面只断开这条连接，之后用 resumeHistoryStream 接着收。
export async function postHistoryStream(request: DatabaseExplainRequest, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal, runId?: string) {
  throwIfTurnCancelled(signal);
  const response = await fetch("/api/analytics/history", { method: "POST", credentials: "same-origin", signal, headers: { "content-type": "application/json", accept: "application/x-ndjson", "X-Analytics-Answer-Schema": PLAN_ANSWER_V4_SCHEMA, "X-Analytics-Visuals": VISUALIZATION_SCHEMA, ...(runId ? { "X-Analytics-Run-Id": runId } : {}) }, body: JSON.stringify(request) });
  return readHistoryResponse(response, onProgress, signal);
}

// 重新连上还在跑的回答：服务端先补放已发生的过程事件，再接着推送。
export async function resumeHistoryStream(runId: string, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal) {
  throwIfTurnCancelled(signal);
  const response = await fetch(`/api/analytics/history/runs/${encodeURIComponent(runId)}`, { credentials: "same-origin", signal, headers: { accept: "application/x-ndjson" } });
  return readHistoryResponse(response, onProgress, signal);
}

// 停止只能显式发出：断开连接不会中止服务端的回答。
export function cancelHistoryRun(runId: string) {
  return fetch(`/api/analytics/history/runs/${encodeURIComponent(runId)}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).then(() => undefined, () => undefined);
}

async function readHistoryResponse(response: Response, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal) {
  throwIfTurnCancelled(signal);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "本次分析暂未完成，可以重试");
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const body = await response.json() as { explanation?: unknown }; throwIfTurnCancelled(signal); return validateAnalyticsAnswerResult(body.explanation);
  }
  return consumeAnalyticsStream(response, onProgress, signal);
}
