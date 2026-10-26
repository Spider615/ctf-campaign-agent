import { assertSameOrigin } from "../../../lib/server/analytics-access.ts";
import { forwardInternalRequest } from "../../../lib/server/runtime.ts";
import { internalToken } from "../../../lib/server/usage-identity.ts";

// 只读查询：overview、conversations、conversations/<key>、channel；凭据由 Agent 验签。
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const [head, ...rest] = path;
  if (!(["overview", "channel"].includes(head) && !rest.length || head === "conversations" && rest.length <= 1)) return Response.json({ error: "没有这个接口" }, { status: 404 });
  const search = new URL(request.url).search;
  const target = `/internal/${head}${rest.length ? `/${encodeURIComponent(rest[0])}` : ""}${search}`;
  return forwardInternalRequest(target, { method: "GET", token: internalToken(request), signal: request.signal });
}

// 唯一的写操作：切换模型渠道。只接受同源页面发来的请求。
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.length !== 1 || path[0] !== "channel") return Response.json({ error: "没有这个接口" }, { status: 404 });
  try { assertSameOrigin(request); } catch { return Response.json({ error: "请求来源不正确" }, { status: 403 }); }
  const body = await request.text();
  if (body.length > 200) return Response.json({ error: "请求太大" }, { status: 413 });
  return forwardInternalRequest("/internal/channel", { method: "POST", token: internalToken(request), body, signal: request.signal });
}
