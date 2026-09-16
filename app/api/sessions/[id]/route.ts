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

// 删除是幂等的：会话不在了也返回 204，界面不用区分「删掉了」和「本来就没有」。
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await runtimeDeps().store.remove(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, "删不掉这个活动，请重试");
  }
}
