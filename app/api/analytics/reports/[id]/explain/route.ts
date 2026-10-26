import { visualizationCapability } from "../../../../../lib/analytics/visualization.ts";
import { readAnalyticsJson, rejectStaleAnswerSchema } from "../../../../../lib/server/analytics-access.ts";
import { analyticsResponse } from "../../../../../lib/server/analytics-runtime.ts";
import { requireReport, requireDataset } from "../../../../../lib/server/analytics-service.ts";
import { AnalyticsError } from "../../../../../lib/server/analytics-store.ts";
import { explainAnalytics } from "../../../../../lib/server/runtime.ts";
import { encodeAnalyticsStreamEvent, normalizeAnalyticsAnswerSchema, type AnalyticsStreamEvent } from "../../../../../lib/analytics/stream.ts";
import { relayAbort } from "../../../../../lib/cancellation.ts";
import { forwardedUsageHeaders } from "../../../../../lib/server/usage-identity.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return analyticsResponse(request, async (owner, store) => {
    rejectStaleAnswerSchema(request);
    const body = await readAnalyticsJson(request) as { question?: unknown } | null;
    if (!body || typeof body.question !== "string" || body.question.length > 500) throw new AnalyticsError("请提供 500 字以内的关注问题");
    const question = body.question;
    const report = await requireReport(owner, id, store);
    const dataset = await requireDataset(owner, report.datasetId, store);
    if (dataset.version !== report.datasetVersion) throw new AnalyticsError("报告与数据版本不一致，不能采用其他版本", 409);
    const answerSchema = normalizeAnalyticsAnswerSchema(request.headers.get("X-Analytics-Answer-Schema"));
    const visualizationSchema = visualizationCapability(request.headers.get("X-Analytics-Visuals"));
    // 同一份报告上的追问归到同一个会话。
    const usageHeaders = forwardedUsageHeaders(request, { owner, conversation: `report-${id}` });
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const controller = new AbortController(); const stopRelay = relayAbort(request.signal, controller); const encoder = new TextEncoder(); let open = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stop = () => { open = false; clearInterval(heartbeat); if (!controller.signal.aborted) controller.abort(); };
      controller.signal.addEventListener("abort", stop, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        async start(output) {
          const write = (line: string) => { if (open && !controller.signal.aborted) { try { output.enqueue(encoder.encode(line)); } catch { stop(); } } };
          const emit = (event: AnalyticsStreamEvent) => write(encodeAnalyticsStreamEvent(event));
          // Node 返回核验后的整份回答；空行只用于静默期间及时检测浏览器断连。
          const keepAlive = () => { if ((output.desiredSize ?? 0) > 0) write("\n"); };
          keepAlive(); heartbeat = setInterval(keepAlive, 250);
          try { const result = await explainAnalytics({ report, dataset, question }, controller.signal, answerSchema, visualizationSchema, usageHeaders); emit({ type: "result", result }); }
          catch (error) { emit({ type: "error", error: error instanceof Error ? error.message : "报告分析暂未完成，可以重试" }); }
          finally { stopRelay(); clearInterval(heartbeat); controller.signal.removeEventListener("abort", stop); if (open) { open = false; output.close(); } }
        },
        cancel() { stop(); stopRelay(); },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }
    return { explanation: await explainAnalytics({ report, dataset, question }, request.signal, answerSchema, visualizationSchema, usageHeaders) };
  });
}
