import { errorResponse, publicTurnError, runtimeDeps } from "../../../../lib/server/runtime.ts";
import { runTurn } from "../../../../lib/server/turns.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const encoder = new TextEncoder();
      let active = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: unknown) => {
            if (!active) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              active = false;
            }
          };
          void runTurn(
            id,
            body,
            runtimeDeps(
              (event) => emit({ type: "trace", event }),
              (event) => emit(event),
            ),
          )
            .then((snapshot) => emit({ type: "snapshot", snapshot }))
            .catch((error) => emit({ type: "error", error: publicTurnError(error) }))
            .finally(() => {
              if (!active) return;
              active = false;
              controller.close();
            });
        },
        cancel() {
          active = false;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return Response.json(await runTurn(id, body, runtimeDeps()));
  } catch (error) {
    return errorResponse(error, "没保存成功，可以重试");
  }
}
