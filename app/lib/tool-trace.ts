export const CAMPAIGN_TOOL_NAMES = [
  "extract_campaign_facts",
  "accept_campaign_proposals",
  "lookup_ics_reference",
  "analyze_campaign_state",
  "ask_campaign_questions",
  "draft_campaign_copy",
  "draft_promo_copy",
  "generate_ics1811_sheet",
  "undo_campaign_change",
] as const;

export type CampaignToolName = (typeof CAMPAIGN_TOOL_NAMES)[number];

// 早先有「复述 → 确认」时的工具，只为读得出旧会话里存下的执行记录。
const LEGACY_TOOL_NAMES = ["build_campaign_readback", "confirm_campaign_readback"] as const;
// 不是活动工具、但要记进执行记录的步骤：模型通过 SDK 的 Skill 工具加载业务规则技能。
export const SKILL_TRACE_TOOL = "load_campaign_skill";
export type TraceToolName = CampaignToolName | (typeof LEGACY_TOOL_NAMES)[number] | typeof SKILL_TRACE_TOOL;
export type ToolTraceStatus = "started" | "completed" | "warning" | "failed";
export type ToolInitiator = "model" | "orchestrator";

export type AgentTraceEvent = {
  id: string;
  tool: TraceToolName;
  title: string;
  status: ToolTraceStatus;
  initiatedBy: ToolInitiator;
  startedAt: number;
  summary?: string;
  durationMs?: number;
};

export type ToolTrace = {
  status: Exclude<ToolTraceStatus, "started">;
  durationMs: number;
  steps: AgentTraceEvent[];
};

type StartTraceInput = {
  id: string;
  tool: TraceToolName;
  title: string;
  initiatedBy: ToolInitiator;
  at: number;
};

type FinishTraceInput = {
  status: Exclude<ToolTraceStatus, "started">;
  summary: string;
  at: number;
};

const TOOL_NAME_SET = new Set<string>([...CAMPAIGN_TOOL_NAMES, ...LEGACY_TOOL_NAMES, SKILL_TRACE_TOOL]);
const FINISHED_STATUS_SET = new Set<string>(["completed", "warning", "failed"]);
const TRACE_STATUS_SET = new Set<string>(["started", ...FINISHED_STATUS_SET]);
const INITIATOR_SET = new Set<string>(["model", "orchestrator"]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonNegativeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function startTraceEvent(input: StartTraceInput): AgentTraceEvent {
  return {
    id: input.id,
    tool: input.tool,
    title: input.title,
    status: "started",
    initiatedBy: input.initiatedBy,
    startedAt: input.at,
  };
}

export function finishTraceEvent(event: AgentTraceEvent, input: FinishTraceInput): AgentTraceEvent {
  return {
    ...event,
    status: input.status,
    summary: input.summary,
    durationMs: Math.max(0, input.at - event.startedAt),
  };
}

export function mergeTraceEvent(events: readonly AgentTraceEvent[], event: AgentTraceEvent): AgentTraceEvent[] {
  const index = events.findIndex((item) => item.id === event.id);
  if (index < 0) return [...events, event];
  return events.map((item, itemIndex) => (itemIndex === index ? event : item));
}

export function isAgentTraceEvent(value: unknown): value is AgentTraceEvent {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.tool !== "string" || !TOOL_NAME_SET.has(value.tool)) return false;
  if (typeof value.title !== "string" || !value.title.trim()) return false;
  if (typeof value.status !== "string" || !TRACE_STATUS_SET.has(value.status)) return false;
  if (typeof value.initiatedBy !== "string" || !INITIATOR_SET.has(value.initiatedBy)) return false;
  if (!isNonNegativeNumber(value.startedAt)) return false;
  if (value.summary !== undefined && typeof value.summary !== "string") return false;
  if (value.durationMs !== undefined && !isNonNegativeNumber(value.durationMs)) return false;
  if (value.status === "started") return value.durationMs === undefined;
  return typeof value.summary === "string" && isNonNegativeNumber(value.durationMs);
}

export function isToolTrace(value: unknown): value is ToolTrace {
  if (!isRecord(value)) return false;
  if (typeof value.status !== "string" || !FINISHED_STATUS_SET.has(value.status)) return false;
  if (!isNonNegativeNumber(value.durationMs) || !Array.isArray(value.steps) || value.steps.length === 0) return false;
  return value.steps.every((step) => isAgentTraceEvent(step) && step.status !== "started");
}

export function parseAgentTraceEvent(value: unknown): AgentTraceEvent {
  if (!isAgentTraceEvent(value)) throw new Error("工具执行事件不完整");
  return value;
}

export function parseToolTrace(value: unknown): ToolTrace {
  if (!isToolTrace(value)) throw new Error("工具执行记录不完整");
  return value;
}

export function traceSummary(trace: ToolTrace): string {
  const seconds = (trace.durationMs / 1000).toFixed(1);
  return `AI 完成 ${trace.steps.length} 个工具步骤 · ${seconds} 秒`;
}

export function traceCardSummary(trace: ToolTrace): { tone: "success" | "warning" | "failed"; label: string } {
  const completed = trace.steps.filter((step) => step.status === "completed").length;
  if (trace.status === "failed") return { tone: "failed", label: `执行失败 · 已完成 ${completed} 步` };
  const warnings = trace.steps.filter((step) => step.status === "warning").length;
  if (trace.status === "warning") return { tone: "warning", label: `完成 ${trace.steps.length} 步 · ${warnings} 项需注意` };
  return { tone: "success", label: `完成 ${trace.steps.length} 个工具步骤 · ${(trace.durationMs / 1000).toFixed(1)} 秒` };
}
