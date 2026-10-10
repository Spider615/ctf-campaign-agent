import { readAnalyticsJson } from "../../../lib/server/analytics-access.ts";
import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { createReport } from "../../../lib/server/analytics-service.ts";

export function GET(request: Request) {
  return analyticsResponse(request, async (owner, store) => ({ reports: await store.listReports(owner) }));
}
export function POST(request: Request) {
  return analyticsResponse(request, async (owner, store) => ({ report: await createReport(owner, await readAnalyticsJson(request), store) }), { status: 201 });
}
