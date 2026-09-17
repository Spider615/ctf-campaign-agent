import { isTurnCancelled, relayAbort } from "../../../../lib/cancellation.ts";
import { errorResponse, publicTurnError, runtimeDeps } from "../../../../lib/server/runtime.ts";
import { runTurn } from "../../../../lib/server/turns.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const encoder = new TextEncoder();
      let active = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const turnController = new AbortController();
      const stopRelaying = relayAbort(request.signal, turnController);
      const abortTurn = () => {
        active = false;
        clearInterval(heartbeat);
        if (!turnController.signal.aborted) turnController.abort();
      };
      turnController.signal.addEventListener("abort", abortTurn, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (line: string) => {
            if (!active) return;
            try {
              controller.enqueue(encoder.encode(line));
            } catch {
              abortTurn();
            }
          };
          const emit = (event: unknown) => write(`${JSON.stringify(event)}\n`);
          // 静默等待模型时也让代理持续写响应，及时检测浏览器断连。
          // 空行不是业务事件；仅保活，不限制回合总时长。
          const keepAlive = () => {
            if ((controller.desiredSize ?? 0) > 0) write("\n");
          };
          keepAlive();
          heartbeat = setInterval(keepAlive, 250);
          void runTurn(
            id,
            body,
            runtimeDeps(
              (event) => emit({ type: "trace", event }),
              (event) => emit(event),
              turnController.signal,
            ),
          )
            .then((snapshot) => emit({ type: "snapshot", snapshot }))
            .catch((error) => {
              if (isTurnCancelled(error) || turnController.signal.aborted) return;
              emit({ type: "error", ...publicTurnError(error) });
            })
            .finally(() => {
              stopRelaying();
              clearInterval(heartbeat);
              turnController.signal.removeEventListener("abort", abortTurn);
              if (!active) return;
              active = false;
              controller.close();
            });
        },
        cancel() {
          abortTurn();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return Response.json(await runTurn(id, body, runtimeDeps(undefined, undefined, request.signal)));
  } catch (error) {
    return errorResponse(error, "没保存成功，可以重试");
  }
}
