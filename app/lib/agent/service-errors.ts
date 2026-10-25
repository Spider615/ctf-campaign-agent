import { mentionsUnderlyingModel } from "./reply-stream.ts";

export const MODEL_QUOTA_MESSAGE = "当前服务额度不足，请及时联系管理员。";

// 仅识别服务账户的额度/余额耗尽，不能把普通限流或上下文长度错误当作充值问题。
export function modelQuotaMessage(message: string): string | undefined {
  const code = /\b(?:quota_exceeded|insufficient_quota|insufficient_credits|insufficient_balance|credit_balance_too_low|billing_hard_limit_reached)\b/i;
  const detail = /\bmonthly budget exhausted\b|\b(?:credit|token) balance\b[^\n]{0,60}\b(?:insufficient|too low|exhausted)\b|\b(?:exceeded|exhausted|insufficient)\b[^\n]{0,40}\b(?:credits|quota)\b|(?:服务|模型|账户|API|调用|月度|token).{0,16}(?:额度|余额).{0,8}(?:不足|耗尽|用尽)/i;
  return code.test(message) || detail.test(message) ? MODEL_QUOTA_MESSAGE : undefined;
}

// 原错误仍可用于私有诊断；对话与公开HTTP响应只返回可展示信息。
export function publicAgentError(message: string): string {
  return modelQuotaMessage(message) ?? (mentionsUnderlyingModel(message) ? "Agent 执行出错" : message);
}
