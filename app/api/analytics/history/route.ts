import { visualizationCapability } from "../../../lib/analytics/visualization.ts";
import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { readAnalyticsJson } from "../../../lib/server/analytics-access.ts";
import { inspectHistoryDatabase, explainHistoryDatabase, explainHistoryDatabaseStream } from "../../../lib/server/runtime.ts";
import { isDatabaseExplainRequest } from "../../../lib/analytics/database.ts";
import { AnalyticsError } from "../../../lib/server/analytics-store.ts";
import { encodeAnalyticsStreamEvent, normalizeAnalyticsAnswerSchema, type AnalyticsStreamEvent } from "../../../lib/analytics/stream.ts";
import { relayAbort } from "../../../lib/cancellation.ts";

export async function GET(request: Request) {
  return analyticsResponse(request, async () => ({ database: await inspectHistoryDatabase(request.signal) }), { bootstrap: true });
}
export async function POST(request: Request) {
  return analyticsResponse(request, async () => {
    const body = await readAnalyticsJson(request);
    if (!isDatabaseExplainRequest(body)) throw new AnalyticsError("请提供营销问题和有效的对话上下文");
    const answerSchema = normalizeAnalyticsAnswerSchema(request.headers.get("X-Analytics-Answer-Schema"));
    const visualizationSchema = visualizationCapability(request.headers.get("X-Analytics-Visuals"));
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const controller = new AbortController(); const stopRelay = relayAbort(request.signal, controller); const encoder = new TextEncoder(); let open = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stop = () => { open = false; clearInterval(heartbeat); if (!controller.signal.aborted) controller.abort(); };
      controller.signal.addEventListener("abort", stop, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        async start(output) {
          const write = (line: string) => { if (open && !controller.signal.aborted) { try { output.enqueue(encoder.encode(line)); } catch { stop(); } } };
          const emit = (event: AnalyticsStreamEvent) => write(encodeAnalyticsStreamEvent(event));
          // 静默等待时让代理及时发现断连；空行仅保活，不属于业务过程或回合时限。
          const keepAlive = () => { if ((output.desiredSize ?? 0) > 0) write("\n"); };
          keepAlive(); heartbeat = setInterval(keepAlive, 250);
          try { const result = await explainHistoryDatabaseStream(body, emit, controller.signal, answerSchema, visualizationSchema); emit({ type: "result", result }); }
          catch (error) { emit({ type: "error", error: error instanceof Error ? error.message : "本次分析暂未完成，可以重试" }); }
          finally { stopRelay(); clearInterval(heartbeat); controller.signal.removeEventListener("abort", stop); if (open) { open = false; output.close(); } }
        },
        cancel() { stop(); stopRelay(); },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }
    return { explanation: await explainHistoryDatabase(body, request.signal, answerSchema, visualizationSchema) };
  });
}
