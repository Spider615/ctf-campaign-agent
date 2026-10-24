import { readAnalyticsJson } from "../../../../lib/server/analytics-access.ts";
import { analyticsResponse } from "../../../../lib/server/analytics-runtime.ts";
import { parseConversationId, parseConversationWrite } from "../../../../lib/server/conversation-threads.ts";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: raw } = await context.params;
  return analyticsResponse(request, async (owner, store) => {
    const id = parseConversationId(raw);
    const { scope, thread, updatedAt } = parseConversationWrite(id, await readAnalyticsJson(request));
    await store.saveConversation(owner, scope, id, thread, updatedAt);
    return new Response(null, { status: 204 });
  });
}

// 幂等：删不存在的对话也返回 204。
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: raw } = await context.params;
  return analyticsResponse(request, async (owner, store) => {
    await store.deleteConversation(owner, parseConversationId(raw));
    return new Response(null, { status: 204 });
  });
}
