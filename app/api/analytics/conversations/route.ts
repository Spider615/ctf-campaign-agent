import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { parseConversationScope } from "../../../lib/server/conversation-threads.ts";

// 打开页面时读取共享空间中指定范围的对话，兼容旧浏览器保存的记录。
export async function GET(request: Request) {
  return analyticsResponse(request, async (owner, store) => {
    const scope = parseConversationScope(new URL(request.url).searchParams.get("scope"));
    const [threads, deletedIds] = await Promise.all([store.listConversations(owner, scope), store.listDeletedConversations(owner, scope)]);
    return { threads, deletedIds };
  }, { bootstrap: true });
}
