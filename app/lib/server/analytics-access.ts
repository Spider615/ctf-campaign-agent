import { AnalyticsError } from "./analytics-store.ts";

export function analyticsAccess(request: Request, bootstrap = false) {
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new AnalyticsError("数据写入必须来自同源页面", 403);
  }
  const owner = /(?:^|;\s*)ctf_analytics_owner=([0-9a-f-]{36})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (owner && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner)) return { owner, cookie: null };
  if (!bootstrap) throw new AnalyticsError("请先打开或刷新营销分析工作台，初始化访问标识", 401);
  const generated = crypto.randomUUID();
  return { owner: generated, cookie: `ctf_analytics_owner=${generated}; Path=/api/analytics; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}` };
}

export async function readAnalyticsJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new AnalyticsError("请求应使用 JSON 格式", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AnalyticsError("请求内容为空");
  const decoder = new TextDecoder(); let text = ""; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new AnalyticsError("请求过大，请缩小导入范围", 413); }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new AnalyticsError("请求不是有效 JSON"); }
  } finally { reader.releaseLock(); }
}
