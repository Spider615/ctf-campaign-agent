import { parseAgentTraceEvent, type AgentTraceEvent } from "../tool-trace.ts";
import { ALL_ANALYTICS_TRACE_TOOLS, ANALYTICS_SKILL_TRACE_TOOL } from "./tool-names.ts";
import { ATTACHMENT_PREPARATION_TRACE_TOOL, ATTACHMENT_TOOLS } from "../attachments/types.ts";

// 共用原来的过程组件，只传公开动作、状态、数量和真实耗时。
export function publicAnalyticsTrace(value: unknown): AgentTraceEvent {
  const event = parseAgentTraceEvent(value);
  if (![...ALL_ANALYTICS_TRACE_TOOLS, ANALYTICS_SKILL_TRACE_TOOL, ...ATTACHMENT_TOOLS, ATTACHMENT_PREPARATION_TRACE_TOOL].some((tool) => tool === event.tool) || event.id.length > 160 || event.title.length > 120 || (event.summary?.length ?? 0) > 1000) throw new Error("营销过程记录超出合同");
  return { id: event.id, tool: event.tool, title: event.title, status: event.status, initiatedBy: event.initiatedBy, startedAt: event.startedAt,
    ...(event.summary !== undefined ? { summary: event.summary } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) };
}
