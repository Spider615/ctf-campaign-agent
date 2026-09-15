import { getSession } from "../../../lib/server/session-repository.ts";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const session = await getSession(id);
    return session ? Response.json(session) : Response.json({ error: "找不到活动记录" }, { status: 404 });
  } catch (error) {
    console.error("get session failed", error);
    return Response.json({ error: "活动记录暂时不可用" }, { status: 503 });
  }
}

