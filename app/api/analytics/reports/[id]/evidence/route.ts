import { analyticsResponse } from "../../../../../lib/server/analytics-runtime.ts";
import { reportEvidence } from "../../../../../lib/server/analytics-service.ts";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const evidenceId = new URL(request.url).searchParams.get("evidenceId") ?? "overall";
  return analyticsResponse(request, async (owner, store) => ({ evidence: await reportEvidence(owner, id, evidenceId, store) }));
}
