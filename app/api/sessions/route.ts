import { createSession, listSessions } from "../../lib/server/session-repository.ts";
import { isCampaignDraft } from "../../lib/server/request-validation.ts";

export async function GET() {
  try {
    return Response.json({ sessions: await listSessions() });
  } catch (error) {
    console.error("list sessions failed", error);
    return Response.json({ error: "活动记录暂时不可用" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!isCampaignDraft(body.draft) || !Array.isArray(body.orders) || typeof body.entryMode !== "string") {
      return Response.json({ error: "活动草稿结构不完整" }, { status: 400 });
    }
    const session = await createSession({
      draft: body.draft,
      orders: body.orders,
      entryMode: body.entryMode,
      firstMessage: typeof body.firstMessage === "string" ? body.firstMessage : undefined,
    });
    return Response.json(session, { status: 201 });
  } catch (error) {
    console.error("create session failed", error);
    return Response.json({ error: "活动记录暂时无法保存，请保留当前页面后重试" }, { status: 503 });
  }
}

