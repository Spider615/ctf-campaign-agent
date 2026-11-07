import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";
import { parseRangeParams, rangeSearch } from "../../../lib/insight/range.ts";
import { fetchInsightGraph } from "../../../lib/server/runtime.ts";

// 洞察图谱只读 Agent 侧算好的聚合结果，不读写分析存储。范围在这里先挡掉格式错误，再交给 Agent 按数据起止校验。
export function GET(request: Request) {
  return analyticsResponse(request, async () => {
    const params = new URL(request.url).searchParams;
    const range = parseRangeParams(params.get("from"), params.get("to"));
    const search = rangeSearch(range);
    return fetchInsightGraph(search ? `?${search}` : "", request.signal);
  }, { bootstrap: true });
}
