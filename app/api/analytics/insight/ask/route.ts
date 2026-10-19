import { analyticsResponse } from "../../../../lib/server/analytics-runtime.ts";
import { askInsightGraph } from "../../../../lib/server/runtime.ts";

// 图谱问答：只依据 Agent 侧已算好的图谱回答，不读写分析存储。
export function POST(request: Request) {
  return analyticsResponse(request, async () => {
    const body = await request.text();
    if (body.length > 20000) throw new Error("请求太大");
    return askInsightGraph(new URL(request.url).searchParams, body, request.signal);
  });
}
