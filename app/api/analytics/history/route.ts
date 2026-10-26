import { visualizationCapability } from "../../../lib/analytics/visualization.ts";
import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { readAnalyticsJson, rejectStaleAnswerSchema } from "../../../lib/server/analytics-access.ts";
import { inspectHistoryDatabase, explainHistoryDatabase, explainHistoryDatabaseStream } from "../../../lib/server/runtime.ts";
import { isDatabaseExplainRequest } from "../../../lib/analytics/database.ts";
import { AnalyticsError } from "../../../lib/server/analytics-store.ts";
import { normalizeAnalyticsAnswerSchema } from "../../../lib/analytics/stream.ts";
import { analyticsStreamResponse } from "../../../lib/server/analytics-stream-response.ts";
import { ANALYTICS_RUN_ID } from "../../../lib/analytics/run-id.ts";

export async function GET(request: Request) {
  return analyticsResponse(request, async () => ({ database: await inspectHistoryDatabase(request.signal) }), { bootstrap: true });
}
export async function POST(request: Request) {
  return analyticsResponse(request, async (owner) => {
    rejectStaleAnswerSchema(request);
    const body = await readAnalyticsJson(request);
    if (!isDatabaseExplainRequest(body)) throw new AnalyticsError("请提供营销问题和有效的对话上下文");
    const answerSchema = normalizeAnalyticsAnswerSchema(request.headers.get("X-Analytics-Answer-Schema"));
    const visualizationSchema = visualizationCapability(request.headers.get("X-Analytics-Visuals"));
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const runId = request.headers.get("X-Analytics-Run-Id");
      if (runId !== null && !ANALYTICS_RUN_ID.test(runId)) throw new AnalyticsError("回答标识无效");
      const run = runId === null ? undefined : { id: runId, owner };
      return analyticsStreamResponse(request.signal, (emit, signal) => explainHistoryDatabaseStream(body, emit, signal, answerSchema, visualizationSchema, run));
    }
    return { explanation: await explainHistoryDatabase(body, request.signal, answerSchema, visualizationSchema) };
  });
}
