import { encodeAnalyticsStreamEvent, type AnalyticsAnswerResult, type AnalyticsStreamEvent } from "../analytics/stream.ts";
import { relayAbort } from "../cancellation.ts";

// 把一次问答写成 NDJSON 响应；浏览器断开时中止的是这条转发，不是 Agent 上已登记的运行。
export function analyticsStreamResponse(source: AbortSignal, run: (emit: (event: AnalyticsStreamEvent) => void, signal: AbortSignal) => Promise<AnalyticsAnswerResult>) {
  const controller = new AbortController(); const stopRelay = relayAbort(source, controller); const encoder = new TextEncoder(); let open = true;
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
      try { const result = await run(emit, controller.signal); emit({ type: "result", result }); }
      catch (error) { emit({ type: "error", error: error instanceof Error ? error.message : "本次分析暂未完成，可以重试" }); }
      finally { stopRelay(); clearInterval(heartbeat); controller.signal.removeEventListener("abort", stop); if (open) { open = false; output.close(); } }
    },
    cancel() { stop(); stopRelay(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}
