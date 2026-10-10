import { analyticsResponse } from "../../../../lib/server/analytics-runtime.ts";
import { requireReport } from "../../../../lib/server/analytics-service.ts";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return analyticsResponse(request, async (owner, store) => ({ report: await requireReport(owner, id, store) }));
}
