import { AnalyticsError } from "./analytics-store.ts";
import { RETIRED_ANALYSIS_ANSWER_SCHEMA } from "../analytics/analysis-v2-types.ts";

// 旧页面仍发 v2 头时直接提示刷新，不静默降级为旧版回答。
export function rejectStaleAnswerSchema(request: Request) {
  if (request.headers.get("X-Analytics-Answer-Schema") === RETIRED_ANALYSIS_ANSWER_SCHEMA) throw new AnalyticsError("页面版本已更新，请刷新页面后重试", 400);
}

// 部署在反向代理后面（butler 的 traefik）时，HTTPS 在代理上终止，应用看到的地址是 http://，
// 浏览器发的 Origin 却是 https://。所以同源只比主机名和端口，协议以代理转发的为准。
function publicUrl(request: Request): URL {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  return url;
}
const sameHost = (origin: string, url: URL) => {
  // 端口只比写明的：代理没转发协议时，https://x（默认 443）和 http://x（默认 80）仍是同一个站点。
  try { const o = new URL(origin); return o.hostname === url.hostname && o.port === url.port; } catch { return false; }
};

export function analyticsAccess(request: Request, bootstrap = false) {
  const url = publicUrl(request);
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && !sameHost(origin, url)) throw new AnalyticsError("数据写入必须来自同源页面", 403);
  }
  const owner = /(?:^|;\s*)ctf_analytics_owner=([0-9a-f-]{36})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (owner && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner)) return { owner, cookie: null };
  if (!bootstrap) throw new AnalyticsError("请先打开或刷新营销分析工作台，初始化访问标识", 401);
  const generated = crypto.randomUUID();
  return { owner: generated, cookie: `ctf_analytics_owner=${generated}; Path=/api/analytics; HttpOnly; SameSite=Lax; Max-Age=2592000${url.protocol === "https:" ? "; Secure" : ""}` };
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
