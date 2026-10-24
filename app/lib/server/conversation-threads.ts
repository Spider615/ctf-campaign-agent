import { AnalyticsError } from "./analytics-store.ts";

// 对话记录的范围：analysis 是智能问答的对话列表，campaign-files:<活动 id> 是某个活动里的文件问答。
const SCOPE = /^(?:analysis|campaign-files:[0-9A-Za-z_-]{1,80})$/;
const ID = /^[0-9A-Za-z_-]{1,80}$/;

export function parseConversationScope(value: unknown): string {
  if (typeof value !== "string" || !SCOPE.test(value)) throw new AnalyticsError("对话范围无效");
  return value;
}

export function parseConversationId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new AnalyticsError("对话标识无效");
  return value;
}

// 服务端只核对外层结构；消息里的回答在浏览器恢复时会重新核验，不凭存储内容绕过引用检查。
export function parseConversationWrite(id: string, body: unknown): { scope: string; thread: Record<string, unknown>; updatedAt: string } {
  const value = body as { scope?: unknown; thread?: Record<string, unknown> } | null;
  if (!value || typeof value !== "object") throw new AnalyticsError("请提供对话内容");
  const scope = parseConversationScope(value.scope);
  const thread = value.thread;
  if (!thread || typeof thread !== "object" || thread.id !== id) throw new AnalyticsError("对话内容与标识不一致");
  if (typeof thread.title !== "string" || thread.title.length > 200) throw new AnalyticsError("对话标题无效");
  if (!Array.isArray(thread.messages) || thread.messages.length > 40) throw new AnalyticsError("对话消息无效");
  if (typeof thread.updatedAt !== "string" || Number.isNaN(Date.parse(thread.updatedAt))) throw new AnalyticsError("对话时间无效");
  return { scope, thread, updatedAt: thread.updatedAt };
}
