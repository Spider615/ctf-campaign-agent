// 等模型返回时显示的那句说明。原来是「正在思考…」这类占位词，什么也没说。
// 这里只讲系统接下来拿用户这句话做什么；出现的问题一律取自 questions.ts 的题目录，不现编，
// 否则界面自己说一套、代码做另一套。

import { QUESTION_TITLE } from "./questions.ts";
import type { FlowPhase, QuestionId } from "./types.ts";

export type ThinkingInput = {
  // 只有这两种回合会调模型，其余（面板、撤销、恢复）由代码直接处理，不等待。
  turnKind: "interpret" | "text";
  phase: FlowPhase;
  // Agent 上一句在问、现在仍缺的问题。
  asking: QuestionId[];
  hasProposals: boolean;
};

// 这行字和对话正文并排显示，超过一行就喧宾夺主了。
const MAX_LABEL = 36;
const ASKING_PREFIX = "正在把你这句话对到：";

function clamp(text: string, budget: number): string {
  const chars = [...text];
  return chars.length <= budget ? text : `${chars.slice(0, budget - 1).join("")}…`;
}

export function thinkingLabel({ turnKind, phase, asking, hasProposals }: ThinkingInput): string {
  if (turnKind === "interpret") return "正在读你这句话，把能记的先记下来";
  if (phase === "ready") return "正在按你说的改，填写值会跟着更新";
  if (hasProposals) return "正在看你同不同意刚才的提议";
  // 只问了一项时点名它；问了多项就只报数，整句题面拼进来会比对话还长。
  if (asking.length === 1) return `${ASKING_PREFIX}${clamp(QUESTION_TITLE[asking[0]], MAX_LABEL - [...ASKING_PREFIX].length)}`;
  if (asking.length > 1) return `正在把你这句话对到刚才问的 ${asking.length} 件事上`;
  return "正在记下来，看看还差什么";
}
