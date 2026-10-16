import { analyticsAccess } from "./analytics-access.ts";
import { AnalyticsError, createAnalyticsStore, type AnalyticsStore } from "./analytics-store.ts";
import { analyticsDbBinding } from "./runtime.ts";

export async function analyticsResponse(request: Request, action: (owner: string, store: AnalyticsStore) => Promise<unknown>, options: { bootstrap?: boolean; status?: number } = {}) {
  try {
    const { owner, cookie } = analyticsAccess(request, options.bootstrap);
    const result = await action(owner, createAnalyticsStore(analyticsDbBinding()));
    if (result instanceof Response) {
      const headers = new Headers(result.headers); headers.set("cache-control", "no-store"); if (cookie) headers.set("set-cookie", cookie);
      return new Response(result.body, { status: result.status, headers });
    }
    return Response.json(result, { status: options.status ?? 200, headers: { "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) } });
  } catch (error) {
    const databaseError = error instanceof Error && /D1|SQLITE|no such table|constraint failed/i.test(error.message);
    const message = databaseError ? "分析数据库暂不可用，请检查数据迁移后重试" : error instanceof Error ? error.message : "分析暂时无法完成";
    return Response.json({ error: message }, { status: error instanceof AnalyticsError ? error.status : databaseError ? 503 : 400, headers: { "cache-control": "no-store" } });
  }
}
