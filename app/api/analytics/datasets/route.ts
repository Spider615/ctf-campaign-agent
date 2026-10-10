import { readAnalyticsJson } from "../../../lib/server/analytics-access.ts";
import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { createDataset } from "../../../lib/server/analytics-service.ts";

export function GET(request: Request) {
  return analyticsResponse(request, async (owner, store) => ({ datasets: await store.listDatasets(owner) }), { bootstrap: true });
}
export function POST(request: Request) {
  return analyticsResponse(request, async (owner, store) => ({ dataset: await createDataset(owner, await readAnalyticsJson(request), store) }), { status: 201 });
}
