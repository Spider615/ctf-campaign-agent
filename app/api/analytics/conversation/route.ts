import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { readAnalyticsJson } from "../../../lib/server/analytics-access.ts";
import { forwardAttachmentRequest } from "../../../lib/server/runtime.ts";
import { validateConversationRequest } from "../../../lib/attachments/answer.ts";

export function POST(request: Request) {
  return analyticsResponse(request, async (owner) => {
    const body = validateConversationRequest(await readAnalyticsJson(request));
    return forwardAttachmentRequest(request, owner, body);
  });
}
