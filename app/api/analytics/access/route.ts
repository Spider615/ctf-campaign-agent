import { analyticsResponse } from "../../../lib/server/analytics-runtime.ts";

// 兼容现有页面的就绪检查；POC 使用共享空间，不创建浏览器身份。
export async function GET(request: Request) {
  return analyticsResponse(request, async () => ({ ready: true }), { bootstrap: true });
}
