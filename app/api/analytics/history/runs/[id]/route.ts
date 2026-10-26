import { analyticsResponse } from "../../../../../lib/server/analytics-runtime.ts";
import { AnalyticsError } from "../../../../../lib/server/analytics-store.ts";
import { analyticsStreamResponse } from "../../../../../lib/server/analytics-stream-response.ts";
import { cancelHistoryRun, resumeHistoryRun } from "../../../../../lib/server/runtime.ts";
import { ANALYTICS_RUN_ID } from "../../../../../lib/analytics/run-id.ts";

const runOf = async (context: { params: Promise<{ id: string }> }, owner: string) => {
  const { id } = await context.params;
  if (!ANALYTICS_RUN_ID.test(id)) throw new AnalyticsError("回答标识无效");
  return { id, owner };
};

// 刷新后重新连上还在跑（或刚结束）的回答：先补放已发生的过程，再接着收。
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return analyticsResponse(request, async (owner) => {
    const run = await runOf(context, owner);
    return analyticsStreamResponse(request.signal, (emit, signal) => resumeHistoryRun(run, emit, signal));
  });
}

// 用户点停止：断开连接不再中止分析，只有这里才停。
export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return analyticsResponse(request, async (owner) => {
    await cancelHistoryRun(await runOf(context, owner));
    return new Response(null, { status: 204 });
  });
}
