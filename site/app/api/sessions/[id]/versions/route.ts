import { appendVersion } from "../../../../lib/server/session-repository.ts";
import { isCampaignDraft } from "../../../../lib/server/request-validation.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    if (!isCampaignDraft(body.draft) || !Array.isArray(body.orders) || typeof body.source !== "string" || typeof body.reason !== "string") {
      return Response.json({ error: "版本内容不完整" }, { status: 400 });
    }
    if (!new Set(["ai", "human", "rollback"]).has(body.source)) {
      return Response.json({ error: "版本来源不正确" }, { status: 400 });
    }
    const session = await appendVersion({
      sessionId: id,
      draft: body.draft,
      orders: body.orders,
      source: body.source as "ai" | "human" | "rollback",
      reason: body.reason,
      ops: Array.isArray(body.ops) ? body.ops : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
    });
    return Response.json(session, { status: 201 });
  } catch (error) {
    console.error("append version failed", error);
    return Response.json({ error: "新版本保存失败，当前修改仍保留在页面中" }, { status: 503 });
  }
}

