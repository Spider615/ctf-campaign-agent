import { readAnalyticsJson } from "../../../../../lib/server/analytics-access.ts";
import { analyticsResponse } from "../../../../../lib/server/analytics-runtime.ts";
import { requireReport } from "../../../../../lib/server/analytics-service.ts";
import { AnalyticsError } from "../../../../../lib/server/analytics-store.ts";
import { explainAnalytics } from "../../../../../lib/server/runtime.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return analyticsResponse(request, async (owner, store) => {
    const body = await readAnalyticsJson(request) as { question?: unknown } | null;
    if (!body || typeof body.question !== "string" || body.question.length > 500) throw new AnalyticsError("请提供 500 字以内的关注问题");
    const report = await requireReport(owner, id, store);
    return { explanation: await explainAnalytics({ report, question: body.question }, request.signal) };
  });
}
