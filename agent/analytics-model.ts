// SDK 对未知模型会丢弃 thinking 配置；官方兼容别名保持同一 DeepSeek 模型并让配置真实传到上游。
// 两个渠道都经本机回环，按模型名判断：deepseek-* 只会出现在 DeepSeek 渠道。
// 风险：若句子互动网关以后上架同名的 deepseek-* 模型，也会被换成兼容别名，届时改为按渠道判断。
// 映射合同：https://api-docs.deepseek.com/guides/anthropic_api/
export function analyticsSdkModel(model: string): string {
  if (model === "deepseek-flash") return "claude-sonnet-4-6";
  if (model === "deepseek-v4-pro") return "claude-opus-4-6";
  return model;
}
