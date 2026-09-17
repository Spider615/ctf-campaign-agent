import {
  runAgentTool,
  type AgentState,
  type AgentToolName,
  type ToolOutcome,
} from "../app/lib/agent/tools.ts";

const ICS1811_TOOLS = new Set<AgentToolName>([
  "extract_campaign_facts",
  "accept_campaign_proposals",
  "lookup_ics_reference",
  "analyze_campaign_state",
  "ask_campaign_questions",
  "draft_campaign_copy",
  "generate_ics1811_sheet",
]);

export function runCampaignToolWithSkillGate(
  state: AgentState,
  name: AgentToolName,
  args: Record<string, unknown>,
  loadedSkills: ReadonlySet<string>,
): ToolOutcome {
  if (!loadedSkills.has("campaign-orchestrator")) {
    return {
      text: "本回合还没读取营销活动编排规则。请先加载 campaign-orchestrator，再重新调用这个工具。",
      isError: true,
    };
  }
  if (ICS1811_TOOLS.has(name) && !loadedSkills.has("campaign-sop")) {
    return {
      text: "本回合还没读取 1811 子流程规则。请先加载 campaign-sop，再重新调用这个工具。",
      isError: true,
    };
  }
  return runAgentTool(state, name, args, { loadedSkills });
}
