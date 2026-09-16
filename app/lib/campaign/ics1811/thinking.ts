// 等模型返回时显示的那句说明。原来是「正在思考…」这类占位词，什么也没说。
// 这里只讲系统接下来拿用户这句话做什么；出现的问题一律取自 questions.ts 的题目录，不现编，
// 否则界面自己说一套、代码做另一套。

import { QUESTION_TITLE } from "./questions.ts";
import type { FlowPhase, QuestionId } from "./types.ts";

export type ThinkingInput = {
  // 只有这三种回合会调模型，其余（卡片、面板、撤销、恢复）由代码直接处理，不等待。
  turnKind: "interpret" | "text" | "confirm";
  phase: FlowPhase;
  openQuestions: QuestionId[];
  missingIds: QuestionId[];
};

// 这行字和对话正文并排显示，超过一行就喧宾夺主了。
const MAX_LABEL = 36;
const MISSING_PREFIX = "正在看这句能不能补上：";

function clamp(text: string, budget: number): string {
  const chars = [...text];
  return chars.length <= budget ? text : `${chars.slice(0, budget - 1).join("")}…`;
}

export function thinkingLabel({ turnKind, phase, openQuestions, missingIds }: ThinkingInput): string {
  if (turnKind === "interpret") return "正在读你这句话，找日期、门店、优惠和货类";
  if (turnKind === "confirm") return "正在按 1811 页面顺序生成逐项填写值";
  if (phase === "asking" && openQuestions.length) return `正在把你这句话对到还没答的 ${openQuestions.length} 个问题上`;
  // 只缺一项时点名它；缺多项就只报数，Q3b 那种一整句的题面拼进来会比对话还长。
  if (phase === "blocked" && missingIds.length === 1) {
    return `${MISSING_PREFIX}${clamp(QUESTION_TITLE[missingIds[0]], MAX_LABEL - [...MISSING_PREFIX].length)}`;
  }
  if (phase === "blocked" && missingIds.length > 1) return `正在看这句能补上哪几项（还缺 ${missingIds.length} 项）`;
  return "正在按你说的改，改完会重新复述";
}
