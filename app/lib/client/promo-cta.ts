import type { ChatMessage } from "../campaign/ics1811/messages.ts";
import type { FlowPhase } from "../campaign/ics1811/types.ts";

export const PROMO_GENERATION_PROMPT = "请基于当前活动生成一份对外营销宣传内容";

export function promoCtaMessageId(input: {
  messages: readonly ChatMessage[];
  phase: FlowPhase;
  promo: unknown | null;
}): string | null {
  if (input.phase !== "ready" || input.promo !== null) return null;
  return input.messages.find((message) => message.content.kind === "agent_fill_sheet")?.id ?? null;
}

export function promoWasGenerated(
  snapshot: { latest: { promo: unknown | null } } | null | undefined,
): boolean {
  return snapshot?.latest.promo != null;
}
