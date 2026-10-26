import { forwardInternalRequest } from "../../../lib/server/runtime.ts";
import { internalToken } from "../../../lib/server/usage-identity.ts";

// 只读查询：overview、conversations、conversations/<key>，凭据由 Agent 验签。
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const [head, ...rest] = path;
  if (!(head === "overview" && !rest.length || head === "conversations" && rest.length <= 1)) return Response.json({ error: "没有这个接口" }, { status: 404 });
  const search = new URL(request.url).search;
  const target = `/internal/${head}${rest.length ? `/${encodeURIComponent(rest[0])}` : ""}${search}`;
  return forwardInternalRequest(target, { method: "GET", token: internalToken(request), signal: request.signal });
}
