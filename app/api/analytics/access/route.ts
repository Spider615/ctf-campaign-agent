import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";

// 仅初始化访问标识，不读取客户数据或连接数据库。
export async function GET(request: Request) {
  return analyticsResponse(request, async () => ({ ready: true }), { bootstrap: true });
}
