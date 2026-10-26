import { AnalyticsError } from "../../../lib/server/analytics-store.ts";
import { assertSameOrigin, isHttps } from "../../../lib/server/analytics-access.ts";
import { forwardInternalRequest } from "../../../lib/server/runtime.ts";

// 管理端登录：密码转给 Agent 校验，拿到凭据后写成只供本站服务端读取的 cookie。
export async function POST(request: Request) {
  try { assertSameOrigin(request); } catch (error) {
    return Response.json({ error: error instanceof AnalyticsError ? error.message : "请求来源不正确" }, { status: 403 });
  }
  const text = await request.text();
  if (text.length > 1000) return Response.json({ error: "请求太大" }, { status: 413 });
  const upstream = await forwardInternalRequest("/internal/login", { method: "POST", body: text, signal: request.signal });
  if (!upstream.ok) return upstream;
  const { token, maxAge } = await upstream.json() as { token: string; maxAge: number };
  const cookie = `ctf_internal=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(request) ? "; Secure" : ""}`;
  return Response.json({ ok: true }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } });
}
