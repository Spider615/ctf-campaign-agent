// 活动是一步步搭起来的，但对话把这个过程摊平了。这里把 flow 折算成四步进度，
// 让界面能显示「现在走到哪一步、还差什么」。纯函数，不产生任何新事实。

import { MAX_ROUNDS } from "./questions.ts";
import type { FlowPhase } from "./types.ts";

export type StepKey = "brief" | "analyze" | "collect" | "review" | "output";
export type StepState = "done" | "current" | "todo";
export type CampaignStep = { key: StepKey; label: string; state: StepState; detail?: string };

export type StepInput = { phase: FlowPhase; roundsUsed: number; missingCount: number };

const LABEL: Record<StepKey, string> = {
  brief: "说清需求",
  analyze: "AI 分析",
  collect: "补齐信息",
  review: "核对复述",
  output: "生成填写值",
};

const ORDER: StepKey[] = ["brief", "analyze", "collect", "review", "output"];

// 每个阶段停在第几步；不在 1811 范围时停在第一步，不假装后面的步骤已经开始。
const CURRENT: Record<FlowPhase, StepKey | "all_done"> = {
  interpreting: "analyze",
  out_of_scope: "brief",
  asking: "collect",
  blocked: "collect",
  readback: "review",
  confirmed: "all_done",
};

function detailOf(key: StepKey, { phase, roundsUsed, missingCount }: StepInput): string | undefined {
  if (key !== "collect") return undefined;
  // 两轮用完还缺项时，说清还差几项；还在追问就说清在第几轮。
  if (phase === "blocked") return missingCount ? `还差 ${missingCount} 项` : undefined;
  if (phase === "asking") return `第 ${Math.max(roundsUsed, 1)} 轮 · 最多 ${MAX_ROUNDS} 轮`;
  return undefined;
}

export function campaignSteps(input: StepInput): CampaignStep[] {
  const current = CURRENT[input.phase];
  const currentIndex = current === "all_done" ? ORDER.length : ORDER.indexOf(current);
  return ORDER.map((key, index) => {
    const state: StepState = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
    const detail = state === "current" ? detailOf(key, input) : undefined;
    return detail ? { key, label: LABEL[key], state, detail } : { key, label: LABEL[key], state };
  });
}
