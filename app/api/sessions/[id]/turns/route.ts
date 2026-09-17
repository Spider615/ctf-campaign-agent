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
      const turnController = new AbortController();
      const stopRelaying = relayAbort(request.signal, turnController);
      const abortTurn = () => {
        active = false;
        if (!turnController.signal.aborted) turnController.abort();
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: unknown) => {
            if (!active) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              abortTurn();
            }
          };
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
              emit({ type: "error", error: publicTurnError(error) });
            })
            .finally(() => {
              stopRelaying();
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
