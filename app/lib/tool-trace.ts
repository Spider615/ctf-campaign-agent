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

export type ToolTraceTiming = {
  totalMs: number;
  analysisWaitingMs: number;
  skillsToolsMs: number;
};

export type ToolTrace = {
  status: Exclude<ToolTraceStatus, "started">;
  durationMs: number;
  timing?: ToolTraceTiming;
  steps: AgentTraceEvent[];
};

export type RelativeTimingInterval = {
  offsetMs: number;
  durationMs: number;
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

export function formatDuration(durationMs: number): string {
  if (durationMs < 1) return "<1ms";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function intervalUnionDurationMs(intervals: readonly RelativeTimingInterval[]): number {
  const sorted = intervals
    .filter((interval) => isNonNegativeNumber(interval.offsetMs) && isNonNegativeNumber(interval.durationMs) && interval.durationMs > 0)
    .map((interval) => ({ start: interval.offsetMs, end: interval.offsetMs + interval.durationMs }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!sorted.length) return 0;

  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    total += end - start;
    start = interval.start;
    end = interval.end;
  }
  return total + end - start;
}

export function harnessTimingSummary(
  totalMs: number,
  intervals: readonly RelativeTimingInterval[],
): ToolTraceTiming {
  const safeTotalMs = Math.max(0, totalMs);
  const skillsToolsMs = Math.min(safeTotalMs, intervalUnionDurationMs(intervals));
  return {
    totalMs: safeTotalMs,
    analysisWaitingMs: Math.max(0, safeTotalMs - skillsToolsMs),
    skillsToolsMs,
  };
}

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
  if (!isNonNegativeNumber(value.durationMs) || !Array.isArray(value.steps)) return false;
  if (value.timing !== undefined && !isToolTraceTiming(value.timing)) return false;
  // 首个 Skill/工具之前失败时仍要保存整轮耗时；只有这种失败轨迹允许没有步骤。
  if (value.steps.length === 0 && (value.status !== "failed" || !isToolTraceTiming(value.timing))) return false;
  return value.steps.every((step) => isAgentTraceEvent(step) && step.status !== "started");
}

export function isToolTraceTiming(value: unknown): value is ToolTraceTiming {
  return isRecord(value)
    && isNonNegativeNumber(value.totalMs)
    && isNonNegativeNumber(value.analysisWaitingMs)
    && isNonNegativeNumber(value.skillsToolsMs);
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
  if (trace.status === "failed") return `AI 执行失败 · 已完成 ${trace.steps.filter((step) => step.status === "completed").length} 步 · ${timingLabel(trace)}`;
  return `AI 完成 ${trace.steps.length} 个工具步骤 · ${timingLabel(trace)}`;
}

function timingLabel(trace: ToolTrace): string {
  if (!trace.timing) return `步骤跨度 ${formatDuration(trace.durationMs)}`;
  return [
    `总用时 ${formatDuration(trace.timing.totalMs)}`,
    `分析与等待 ${formatDuration(trace.timing.analysisWaitingMs)}`,
    `Skill/工具 ${formatDuration(trace.timing.skillsToolsMs)}`,
  ].join(" · ");
}

export function traceCardSummary(trace: ToolTrace): { tone: "success" | "warning" | "failed"; label: string } {
  const completed = trace.steps.filter((step) => step.status === "completed").length;
  if (trace.status === "failed") return { tone: "failed", label: `执行失败 · 已完成 ${completed} 步 · ${timingLabel(trace)}` };
  const warnings = trace.steps.filter((step) => step.status === "warning").length;
  if (trace.status === "warning") return { tone: "warning", label: `完成 ${trace.steps.length} 步 · ${warnings} 项需注意 · ${timingLabel(trace)}` };
  return { tone: "success", label: `完成 ${trace.steps.length} 个工具步骤 · ${timingLabel(trace)}` };
}
