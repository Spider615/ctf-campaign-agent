import { datasetSummary } from "../../../../lib/analytics/import.ts";
import { analyticsResponse } from "../../../../lib/server/analytics-runtime.ts";
import { requireDataset } from "../../../../lib/server/analytics-service.ts";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return analyticsResponse(request, async (owner, store) => ({ dataset: datasetSummary(await requireDataset(owner, id, store)) }));
}
