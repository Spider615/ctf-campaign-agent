import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { parseConversationScope } from "../../../lib/server/conversation-threads.ts";

// 打开页面时读这个访问标识下某个范围的对话记录；没有标识时顺带初始化。
export async function GET(request: Request) {
  return analyticsResponse(request, async (owner, store) => {
    const scope = parseConversationScope(new URL(request.url).searchParams.get("scope"));
    return { threads: await store.listConversations(owner, scope) };
  }, { bootstrap: true });
}
