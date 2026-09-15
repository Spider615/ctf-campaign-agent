import { isClarifyKey, type ClarifyCustom, type ClarifyKey } from "../campaign/clarify.ts";
import type { StoredMessage } from "../campaign/messages.ts";
import type { CampaignDraft, PatchOperation } from "../campaign/types.ts";
import { isCampaignDraft } from "../server/request-validation.ts";

// Workers 与 Agent 服务之间的约定：Workers 发当前草稿和这一轮的触发，
// Agent 服务回改好的草稿和要展示的内容，由 Workers 一次性落库。Agent 服务不存数据。

export type AgentTrigger =
  | { kind: "first_message"; text: string }
  | { kind: "user_message"; text: string }
  | { kind: "card_submitted"; summary: string[]; customs: ClarifyCustom[] }
  | { kind: "generate_clicked" };

export type AgentHistoryItem = { role: "user" | "assistant"; text: string };

export type AgentRequest = {
  today: string;
  draft: CampaignDraft;
  history: AgentHistoryItem[];
  trigger: AgentTrigger;
  // 用户还没提交的补充卡片问了哪些项；没有打开的卡片时为 null。
  openCard: ClarifyKey[] | null;
  // 生成过方案，并且之后活动信息没再变过。
  planIsCurrent: boolean;
  canUndo: boolean;
};

export type AgentCard = Extract<StoredMessage, { kind: "agent_clarify" }>;

export type AgentResult = {
  draft: CampaignDraft;
  ops: PatchOperation[];
  reply: string | null;
  card: AgentCard | null;
  generated: boolean;
  undo: boolean;
  tools: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const TRIGGER_KINDS = new Set(["first_message", "user_message", "card_submitted", "generate_clicked"]);

export function isAgentRequest(value: unknown): value is AgentRequest {
  if (!isRecord(value) || !isRecord(value.trigger)) return false;
  return typeof value.today === "string" &&
    isCampaignDraft(value.draft) &&
    Array.isArray(value.history) &&
    TRIGGER_KINDS.has(String(value.trigger.kind)) &&
    (value.openCard === null || (Array.isArray(value.openCard) && value.openCard.every(isClarifyKey))) &&
    typeof value.planIsCurrent === "boolean" &&
    typeof value.canUndo === "boolean";
}

function invalid(): never {
  throw new Error("Agent 服务返回的内容不完整");
}

export function parseAgentResult(value: unknown): AgentResult {
  if (!isRecord(value) || !isCampaignDraft(value.draft) || !Array.isArray(value.ops)) invalid();
  if (typeof value.generated !== "boolean" || typeof value.undo !== "boolean") invalid();
  const card = value.card;
  if (card !== null && !(isRecord(card) && card.kind === "agent_clarify" && Array.isArray(card.questions) && card.questions.every((question) => isRecord(question) && isClarifyKey(question.key)))) {
    invalid();
  }
  return {
    draft: value.draft,
    ops: value.ops as PatchOperation[],
    reply: typeof value.reply === "string" && value.reply.trim() ? value.reply.trim() : null,
    card: card as AgentCard | null,
    generated: value.generated,
    undo: value.undo,
    tools: Array.isArray(value.tools) ? value.tools.filter((item): item is string => typeof item === "string") : [],
  };
}
