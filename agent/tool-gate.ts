import {
  runAgentTool,
  type AgentState,
  type AgentToolName,
  type ToolOutcome,
} from "../app/lib/agent/tools.ts";

export function runCampaignToolWithSkillGate(
  state: AgentState,
  name: AgentToolName,
  args: Record<string, unknown>,
  loadedSkills: ReadonlySet<string>,
): ToolOutcome {
  if (!loadedSkills.has("campaign-sop")) {
    return {
      text: "本回合还没读取活动创建规则。请先加载 campaign-sop，再重新调用这个工具。",
      isError: true,
    };
  }
  return runAgentTool(state, name, args, { loadedSkills });
}
