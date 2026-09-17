import type { ChatMessage } from "../campaign/ics1811/messages.ts";

export const PROMO_GENERATION_PROMPT = "请基于当前活动生成一份对外营销宣传内容";
export const PROMO_CONTINUE_PROMPT = "请继续完善当前传播方案，让创意概念、分渠道内容和视觉方向更完整";

export function promoCtaMessageId(input: {
  messages: readonly ChatMessage[];
  briefReady: boolean;
  communication: unknown | null;
}): string | null {
  if (!input.briefReady || input.communication !== null) return null;
  return input.messages.find((message) => message.content.kind === "agent_fill_sheet")?.id ?? null;
}

export function promoWasGenerated(
  snapshot: { latest: { communication: unknown | null } } | null | undefined,
): boolean {
  return snapshot?.latest.communication != null;
}
