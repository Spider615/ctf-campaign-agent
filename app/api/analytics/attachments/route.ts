import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { forwardAttachmentRequest } from "../../../lib/server/runtime.ts";

const handle = (request: Request) => analyticsResponse(request, (owner) => forwardAttachmentRequest(request, owner));
export const GET = handle;
export const POST = handle;
