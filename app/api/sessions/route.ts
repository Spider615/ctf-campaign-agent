import { errorResponse, runtimeDeps } from "../../lib/server/runtime.ts";
import { createSession } from "../../lib/server/turns.ts";

export async function GET() {
  try {
    return Response.json({ sessions: await runtimeDeps().store.list() });
  } catch (error) {
    return errorResponse(error, "活动记录暂时不可用");
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await createSession(body, runtimeDeps()), { status: 201 });
  } catch (error) {
    return errorResponse(error, "活动暂时无法创建，请重试");
  }
}
