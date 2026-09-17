import type { Dropped } from "../campaign/ics1811/facts.ts";
import { QUESTION_IDS } from "../campaign/ics1811/questions.ts";
import type { Ics1811Draft, Proposal, QuestionId } from "../campaign/ics1811/types.ts";
import type { CampaignBrief, CampaignDraft, CampaignWorkspaceStage, CommunicationCreative } from "../campaign/types.ts";
import { isCampaignDraft, isIcs1811Draft } from "../server/request-validation.ts";
import { CAMPAIGN_TOOL_NAMES, isToolTrace, type CampaignToolName, type ToolTrace } from "../tool-trace.ts";

// Workers 与 Agent 服务之间的约定：Workers 发当前草稿和这一轮的触发，
// Agent 服务回改好的草稿（只改事实层和名称、内容）、要说的话、这句话在问什么和提议了什么；
// 齐没齐、生不生成填写值由 Workers 重算后决定，并一次性落库。

export type AgentTrigger = { kind: "first_message"; text: string } | { kind: "user_message"; text: string };

export type AgentHistoryItem = { role: "user" | "assistant"; text: string };

// interpreting 第一次理解需求；collecting 还在补信息；ready 活动已经建好，改动会同步到填写值。
export type AgentPhase = "interpreting" | "collecting" | "ready";

export type AgentRequest = {
  today: string;
  // 新协议带父 Campaign；旧请求可暂时省略，由 Agent 从 1811 子草稿稳定包装。
  campaign?: CampaignDraft;
  draft: Ics1811Draft | null;
  history: AgentHistoryItem[];
  trigger: AgentTrigger;
  // phase 只为旧调用方兼容；新调用方把父层和可选子流程阶段分开传。
  phase?: AgentPhase;
  campaignStage?: CampaignWorkspaceStage;
  ics1811Phase?: AgentPhase | null;
  // Agent 上一句问过、现在仍缺的问题；「可以」「没有」这类短回答按这些问题记。
  openQuestions: QuestionId[];
  // Agent 上一句给的、现在仍适用的提议；用户点头时按它记。
  proposals: Proposal[];
  // 用户整句只是点头时，编排器在这一轮开始前已经按提议记下的内容（渲染好的文字）。
  accepted?: string[];
  canUndo: boolean;
};

export type AgentResult = {
  draft: Ics1811Draft | null;
  // 父层工具的受控结果；旧 AgentResult 可以省略，Workers 会保留原值。
  brief?: CampaignBrief;
  communication?: CommunicationCreative | null;
  briefApplied?: string[];
  applied: string[];
  dropped: Dropped[];
  reply: string | null;
  copyDrafted: boolean;
  undo: boolean;
  // 这一轮回复在问的问题；模型没登记时为 null，由 Workers 兜底。
  asking: QuestionId[] | null;
  proposals: Proposal[];
  tools: CampaignToolName[];
  trace: ToolTrace | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const PHASES = new Set(["interpreting", "collecting", "ready"]);
const CAMPAIGN_STAGES = new Set(["briefing", "planning", "preparing", "blocked", "needs_confirmation"]);
const TRIGGERS = new Set(["first_message", "user_message"]);
const TOOL_NAMES = new Set<string>(CAMPAIGN_TOOL_NAMES);
const QUESTIONS = new Set<string>(QUESTION_IDS);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const toolNames = (value: unknown): CampaignToolName[] => strings(value).filter((item): item is CampaignToolName => TOOL_NAMES.has(item));
const questionIds = (value: unknown): QuestionId[] => strings(value).filter((item): item is QuestionId => QUESTIONS.has(item));
const isProposal = (value: unknown): value is Proposal =>
  isRecord(value) && typeof value.id === "string" && QUESTIONS.has(value.id) && isRecord(value.answer) && typeof value.text === "string";

export function isAgentRequest(value: unknown): value is AgentRequest {
  if (!isRecord(value) || !isRecord(value.trigger)) return false;
  const draftValid = value.draft === null || isIcs1811Draft(value.draft);
  const campaignValid = value.campaign === undefined || isCampaignDraft(value.campaign);
  const oldPhaseValid = PHASES.has(String(value.phase));
  const newPhaseValid = CAMPAIGN_STAGES.has(String(value.campaignStage)) &&
    (value.ics1811Phase === null || PHASES.has(String(value.ics1811Phase)));
  return typeof value.today === "string" &&
    draftValid &&
    campaignValid &&
    (isCampaignDraft(value.campaign) || isIcs1811Draft(value.draft)) &&
    Array.isArray(value.history) &&
    TRIGGERS.has(String(value.trigger.kind)) &&
    typeof value.trigger.text === "string" &&
    (oldPhaseValid || newPhaseValid) &&
    Array.isArray(value.openQuestions) &&
    Array.isArray(value.proposals) &&
    value.proposals.every(isProposal) &&
    (value.accepted === undefined || (Array.isArray(value.accepted) && value.accepted.every((item) => typeof item === "string"))) &&
    typeof value.canUndo === "boolean";
}

function invalid(): never {
  throw new Error("Agent 服务返回的内容不完整");
}

export function parseAgentResult(value: unknown): AgentResult {
  if (!isRecord(value) || !(value.draft === null || isIcs1811Draft(value.draft))) invalid();
  const hasParentFields = value.brief !== undefined || value.communication !== undefined || value.briefApplied !== undefined;
  if (value.draft === null && !hasParentFields) invalid();
  if (hasParentFields) {
    const candidate = {
      schema: "campaign/v1",
      id: "agent-result",
      requestText: "agent-result",
      brief: value.brief,
      ics1811: value.draft,
      communication: value.communication ?? null,
    };
    if (!isCampaignDraft(candidate)) invalid();
  }
  if (typeof value.copyDrafted !== "boolean" || typeof value.undo !== "boolean") invalid();
  if (value.trace !== undefined && value.trace !== null && !isToolTrace(value.trace)) invalid();
  const dropped = Array.isArray(value.dropped)
    ? value.dropped.filter(isRecord).map((item) => ({ key: String(item.key) as Dropped["key"], quote: String(item.quote ?? ""), reason: String(item.reason ?? "") }))
    : [];
  return {
    draft: value.draft,
    ...(hasParentFields ? {
      brief: value.brief as CampaignBrief,
      communication: (value.communication ?? null) as CommunicationCreative | null,
      briefApplied: strings(value.briefApplied),
    } : {}),
    applied: strings(value.applied),
    dropped,
    reply: typeof value.reply === "string" && value.reply.trim() ? value.reply.trim() : null,
    copyDrafted: value.copyDrafted,
    undo: value.undo,
    asking: Array.isArray(value.asking) ? questionIds(value.asking) : null,
    proposals: Array.isArray(value.proposals) ? value.proposals.filter(isProposal) : [],
    tools: toolNames(value.tools),
    trace: value.trace && isToolTrace(value.trace) ? value.trace : null,
  };
}
