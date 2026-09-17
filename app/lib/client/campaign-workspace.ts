import type { CampaignWorkspaceStage } from "../campaign/types.ts";

export const DEFAULT_WORKSPACE_TAB = "brief";

export const CAMPAIGN_STAGE_LABEL: Record<CampaignWorkspaceStage, string> = {
  briefing: "整理 Brief",
  planning: "规划执行轨",
  preparing: "准备产物",
  blocked: "存在阻断",
  needs_confirmation: "待上线确认",
};

const SESSION_STATUS_LABEL: Record<string, string> = {
  briefing: "整理 Brief",
  preparing: "准备产物",
  needs_confirmation: "待上线确认",
  ics_ready: "1811 已就绪",
  collecting: "收集信息",
  readback: "收集信息",
  confirmed: "1811 已就绪",
};

export function sessionStatusLabel(status: string): string {
  return SESSION_STATUS_LABEL[status] ?? "旧版本";
}

export function communicationAction(input: {
  briefReady: boolean;
  hasCommunication: boolean;
  activeTab: string;
}): "generate" | "view" | "continue" | "disabled" {
  if (!input.briefReady) return "disabled";
  if (!input.hasCommunication) return "generate";
  return input.activeTab === "communications" ? "continue" : "view";
}
