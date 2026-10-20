import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { fetchInsightGraph } from "../../../lib/server/runtime.ts";

// 洞察图谱只读 Agent 侧算好的聚合结果，不读写分析存储。
export function GET(request: Request) {
  return analyticsResponse(request, async () => fetchInsightGraph(request.signal), { bootstrap: true });
}
