import { errorResponse, runtimeDeps } from "../../../lib/server/runtime.ts";
import { buildSnapshot } from "../../../lib/server/turns.ts";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const deps = runtimeDeps();
    const bundle = await deps.store.load(id);
    return bundle ? Response.json(buildSnapshot(bundle, deps.today)) : Response.json({ error: "找不到这个活动" }, { status: 404 });
  } catch (error) {
    return errorResponse(error, "活动记录暂时不可用");
  }
}
