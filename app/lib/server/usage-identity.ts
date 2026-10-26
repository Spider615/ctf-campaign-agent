// 发给 Agent 的用量身份头：访客、会话编号和管理员凭据。Agent 只把它们用于内部用量记录，
// 访客在 Agent 侧哈希后才落盘；管理员凭据由 Agent 验签，验过才算内部流量。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONVERSATION = /^[A-Za-z0-9-]{1,64}$/;
const ADMIN_TOKEN = /^[0-9]{1,16}\.[A-Za-z0-9_-]{1,128}$/;

export function internalToken(request: Request): string | undefined {
  const value = /(?:^|;\s*)ctf_internal=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
  return value && ADMIN_TOKEN.test(value) ? value : undefined;
}

export function forwardedUsageHeaders(request: Request, identity: { owner?: string; conversation?: string }): Record<string, string> {
  const headers: Record<string, string> = {};
  if (identity.owner && UUID.test(identity.owner)) headers["x-ctf-visitor"] = identity.owner;
  const conversation = identity.conversation ?? request.headers.get("x-conversation-id") ?? "";
  if (CONVERSATION.test(conversation)) headers["x-ctf-conversation"] = conversation;
  const admin = internalToken(request);
  if (admin) headers["x-ctf-admin"] = admin;
  return headers;
}
