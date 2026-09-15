import { errorResponse, runtimeDeps } from "../../../../lib/server/runtime.ts";
import { runTurn } from "../../../../lib/server/turns.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    return Response.json(await runTurn(id, body, runtimeDeps()));
  } catch (error) {
    return errorResponse(error, "没保存成功，可以重试");
  }
}
