// SDK 对未知模型会丢弃 thinking 配置；官方兼容别名保持同一 DeepSeek 模型并让配置真实传到上游。
// 映射合同：https://api-docs.deepseek.com/guides/anthropic_api/
export function analyticsSdkModel(model: string, baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return model; }
  if (url.origin !== "https://api.deepseek.com" || !/^\/anthropic\/?$/.test(url.pathname)) return model;
  if (model === "deepseek-flash") return "claude-sonnet-4-6";
  if (model === "deepseek-v4-pro") return "claude-opus-4-6";
  return model;
}
