import { assertSameOrigin, isHttps } from "../../../lib/server/analytics-access.ts";

export function POST(request: Request) {
  try { assertSameOrigin(request); } catch { return Response.json({ error: "请求来源不正确" }, { status: 403 }); }
  const cookie = `ctf_internal=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(request) ? "; Secure" : ""}`;
  return Response.json({ ok: true }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } });
}
