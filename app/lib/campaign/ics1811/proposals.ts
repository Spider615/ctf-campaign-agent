// Agent 的提议：人定项不能默认，但 Agent 可以在对话里说出一个具体值，用户点头才记下（设计决策 D6）。
// 提议的值是结构化回答（card.ts 同一套校验），展示文字由代码从结果渲染，
// 用户同意的是这里渲染出来的值，不是模型嘴上的说法。

import { applyCardAnswers } from "./card.ts";
import { categorySlots } from "./derive.ts";
import { summarizeFactChanges } from "./messages.ts";
import { gapsOf } from "./questions.ts";
import type { FactKey, Ics1811Draft, Proposal, QuestionId } from "./types.ts";

// 能提议的问题。优惠方式和力度（Q3、Q3a、Q3e）是活动本身，要用户自己说；
// 标语法务确认过没有（Q6b）不能替用户说；Q6a 只能提议「不加标语」，标语原文只能用户给；Q5c 只能提议「有」。
export const PROPOSABLE: readonly QuestionId[] = ["Q1", "Q2", "Q3b", "Q3c", "Q3d", "Q4", "Q4a", "Q5a", "Q5b", "Q5c", "Q6a"];

export type ProposalCheck = { ok: true; proposal: Proposal } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// 校验一条提议并渲染它的展示文字。
// 缺的项可以提议怎么填；已经填了的项也可以提议改成什么（活动建好后「往后推一周」这类要替用户换算的改动），
// 只要确实改了东西。today 给了就挡掉已经过去的日期：实测模型把 9 月说的「五一」提议成当年 5 月，用户一句「对」就记成了过去的活动。
export function checkProposal(draft: Ics1811Draft, id: QuestionId, answer: unknown, today?: string): ProposalCheck {
  if (!PROPOSABLE.includes(id)) return { ok: false, reason: `${id} 不能提议，要用户自己说` };
  if (!isRecord(answer)) return { ok: false, reason: `${id} 的 answer 格式不对` };
  if (id === "Q6a" && answer.wanted !== false) return { ok: false, reason: "标语只能提议不加，原文只能用户给" };
  // 货类要按这个活动的槽位提议：买钻石享黄金克减分 diamond、gold，其余是 all。
  // 用错槽位会把钻石、黄金两组拍平或者串位，渲染出来的文字还几乎一样，用户点头时看不出来。
  if (id === "Q4") {
    const slots = isRecord(answer.slots) ? Object.keys(answer.slots) : [];
    const allowed = categorySlots(draft);
    if (!slots.length || slots.some((slot) => !allowed.includes(slot))) return { ok: false, reason: `Q4 的 slots 只能用 ${allowed.join("、") || "（这个活动货类固定，不用提议）"}` };
  }
  // 指引要求多家门店的活动上传结算说明函，「没有」只能用户自己说。
  if (id === "Q5c" && answer.has !== true) return { ok: false, reason: "结算说明函只能提议「有」，没有要用户自己说" };
  if (id === "Q1" && today && typeof answer.start === "string" && answer.start < today) {
    return { ok: false, reason: `提议的开始日期 ${answer.start} 早于今天 ${today}：「五一」「国庆」这类说法要取今天之后最近的一次` };
  }
  const result = applyCardAnswers(draft, { [id]: answer });
  if (result.ignored.length) return { ok: false, reason: `${id}：${result.ignored.map((item) => item.reason).join("；")}` };
  const items = summarizeFactChanges(draft, result.draft);
  if (!items.length) return { ok: false, reason: `${id} 的提议和现在的值一样，不用提议` };
  return {
    ok: true,
    proposal: { id, answer, text: items.map((item) => `${item.label}：${item.after}`).join("；"), before: items.map((item) => `${item.label}：${item.before}`).join("；") },
  };
}

// 草稿变了以后，之前的提议可能不再成立：这几项被用户自己改过（原值变了）就作废，
// 仍然成立的按当前草稿重新渲染文字。
export function liveProposals(draft: Ics1811Draft, proposals: readonly Proposal[], today?: string): Proposal[] {
  const gaps = gapsOf(draft).map((gap) => gap.id);
  return proposals.flatMap((item) => {
    const checked = checkProposal(draft, item.id, item.answer, today);
    if (!checked.ok) return [];
    if (item.before === undefined ? !gaps.includes(item.id) : checked.proposal.before !== item.before) return [];
    return [checked.proposal];
  });
}

export type AcceptResult = { draft: Ics1811Draft; accepted: Proposal[]; keys: FactKey[] };

// 用户点头：按提议的结构化值记下，来源记为 proposal，quote 是用户那句话。
export function acceptProposals(input: Ics1811Draft, proposals: readonly Proposal[], quote: string, only?: readonly QuestionId[]): AcceptResult {
  let draft = input;
  const accepted: Proposal[] = [];
  for (const item of liveProposals(input, proposals)) {
    if (only && !only.includes(item.id)) continue;
    const result = applyCardAnswers(draft, { [item.id]: item.answer }, { quote, via: "proposal" });
    if (result.ignored.length) continue;
    draft = result.draft;
    accepted.push(item);
  }
  const keys = (Object.keys(draft.facts) as FactKey[]).filter((key) => JSON.stringify(draft.facts[key]) !== JSON.stringify(input.facts[key]));
  return { draft, accepted, keys };
}

// 二选一的问法不能当提议：「只减一次，还是每满都减？」登记成「只减一次」的提议，用户回「对」（可能在答别的）就记成了一边。
// 实测模型会这样登记。回复里出现「还是 / 哪种」这类选择问法、并且同一题的两个选项都说到了，就丢掉这一题的提议。
// 宁可丢掉（用户再说一遍），不能留着记错。
const OPTION_WORDS: Partial<Record<QuestionId, [RegExp, RegExp]>> = {
  Q3b: [/(?<!不)(?:可以|能|允许)(?:再)?(?:改价|调价|少打|改)|浮动/, /不(?:能|可以|允许)(?:再)?(?:改价|调价|改)|固定/],
  Q3c: [/减一次/, /每满/],
  Q3d: [/实际克重/, /整克/],
  Q4a: [/(?<!不)(?:要)?转(?:为|成)?(?:outlet)?餐牌|(?<!不)要转/, /不转/],
  Q5b: [/实际售价(?![×xX*]|乘)/, /[×xX*]折扣|乘(?:以)?折扣|(?<!不)计算?折上折/],
  Q5c: [/(?<!没)有(?:结算)?说明函/, /(?:没有|不用|不需要)(?:结算)?说明函/],
};
const CHOICE = /还是|哪种|哪个|哪一种|选哪|二选一/;

export function withoutEitherOr(reply: string, proposals: readonly Proposal[]): Proposal[] {
  const text = reply.replace(/\s+/g, "");
  if (!CHOICE.test(text)) return [...proposals];
  return proposals.filter((item) => {
    const words = OPTION_WORDS[item.id];
    return !(words && words[0].test(text) && words[1].test(text));
  });
}
