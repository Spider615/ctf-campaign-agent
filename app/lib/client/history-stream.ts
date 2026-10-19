import { VISUALIZATION_SCHEMA } from "../analytics/visualization-types.ts";
import type { DatabaseExplainRequest } from "../analytics/database.ts";
import { consumeAnalyticsStream, validateAnalyticsAnswerResult, type AnalyticsProgressEvent } from "../analytics/stream.ts";
import { PLAN_ANSWER_V4_SCHEMA } from "../analytics/analysis-v2-types.ts";
import { throwIfTurnCancelled } from "../cancellation.ts";

export async function postHistoryStream(request: DatabaseExplainRequest, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal) {
  throwIfTurnCancelled(signal);
  const response = await fetch("/api/analytics/history", { method: "POST", credentials: "same-origin", signal, headers: { "content-type": "application/json", accept: "application/x-ndjson", "X-Analytics-Answer-Schema": PLAN_ANSWER_V4_SCHEMA, "X-Analytics-Visuals": VISUALIZATION_SCHEMA }, body: JSON.stringify(request) });
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
