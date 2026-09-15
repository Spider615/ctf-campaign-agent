import type { Dropped } from "../campaign/ics1811/facts.ts";
import type { Ics1811Draft, QuestionId } from "../campaign/ics1811/types.ts";
import { isIcs1811Draft } from "../server/request-validation.ts";

// Workers 与 Agent 服务之间的约定：Workers 发当前草稿和这一轮的触发，
// Agent 服务回改好的草稿（只改事实层和名称、内容）和要说的一两句话，由 Workers 决定出卡、复述还是输出，并一次性落库。

export type AgentTrigger = { kind: "first_message"; text: string } | { kind: "user_message"; text: string };

export type AgentHistoryItem = { role: "user" | "assistant"; text: string };

export type AgentPhase = "interpreting" | "asking" | "readback" | "output";

export type AgentRequest = {
  today: string;
  draft: Ics1811Draft;
  history: AgentHistoryItem[];
  trigger: AgentTrigger;
  phase: AgentPhase;
  roundsUsed: number;
  // 还开着的追问卡片问了哪些题；没有打开的卡片时为空。
  openQuestions: QuestionId[];
  // 最新复述对应的版本号；还没复述过时为 null。
  readbackSeq: number | null;
  canConfirm: boolean;
  canUndo: boolean;
};

export type AgentResult = {
  draft: Ics1811Draft;
  applied: string[];
  dropped: Dropped[];
  reply: string | null;
  copyDrafted: boolean;
  confirmRequested: boolean;
  undo: boolean;
  tools: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const PHASES = new Set(["interpreting", "asking", "readback", "output"]);
const TRIGGERS = new Set(["first_message", "user_message"]);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function isAgentRequest(value: unknown): value is AgentRequest {
  if (!isRecord(value) || !isRecord(value.trigger)) return false;
  return typeof value.today === "string" &&
    isIcs1811Draft(value.draft) &&
    Array.isArray(value.history) &&
    TRIGGERS.has(String(value.trigger.kind)) &&
    typeof value.trigger.text === "string" &&
    PHASES.has(String(value.phase)) &&
    typeof value.roundsUsed === "number" &&
    Array.isArray(value.openQuestions) &&
    (value.readbackSeq === null || typeof value.readbackSeq === "number") &&
    typeof value.canConfirm === "boolean" &&
    typeof value.canUndo === "boolean";
}

function invalid(): never {
  throw new Error("Agent 服务返回的内容不完整");
}

export function parseAgentResult(value: unknown): AgentResult {
  if (!isRecord(value) || !isIcs1811Draft(value.draft)) invalid();
  if (typeof value.copyDrafted !== "boolean" || typeof value.confirmRequested !== "boolean" || typeof value.undo !== "boolean") invalid();
  const dropped = Array.isArray(value.dropped)
    ? value.dropped.filter(isRecord).map((item) => ({ key: String(item.key) as Dropped["key"], quote: String(item.quote ?? ""), reason: String(item.reason ?? "") }))
    : [];
  return {
    draft: value.draft,
    applied: strings(value.applied),
    dropped,
    reply: typeof value.reply === "string" && value.reply.trim() ? value.reply.trim() : null,
    copyDrafted: value.copyDrafted,
    confirmRequested: value.confirmRequested,
    undo: value.undo,
    tools: strings(value.tools),
  };
}
