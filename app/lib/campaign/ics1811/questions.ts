// 问题目录与轮次（设计文档第 4 节）。问题只来自 §9(二)，代码写死，模型不能加题。
// 每张卡片把出卡时的全部缺项一次问完：第 1 轮自然包含首句已触发的追问，第 2 轮自然只剩第 1 轮没答的项和由回答新触发的追问。

import { categorySlots, slotCategories } from "./derive.ts";
import { missingOfferParams } from "./offer-spec.ts";
import { resolveCategory, storeCandidates } from "./resolve.ts";
import type { Check, FillModel, Gap, Ics1811Draft, Plan, QuestionId } from "./types.ts";

export const MAX_ROUNDS = 2;

export const QUESTION_TITLE: Record<QuestionId, string> = {
  Q1: "活动从哪天到哪天？",
  Q2: "哪些门店参加？",
  Q3: "怎么优惠、给多少？",
  Q3a: "优惠力度还差几项",
  Q3b: "门店能不能在这个折扣基础上改价、少打一点？（能改用浮动折扣模式，不能改用固定折扣模式）",
  Q3c: "满减是减一次，还是每满都减？",
  Q3d: "每克减的金额是按实际克重算，还是按单件重量的整数克算？",
  Q3e: "哪个货类对应哪个折扣？",
  Q4: "哪些货类参加？",
  Q4a: "销售时要不要转为 outlet 餐牌？",
  Q5a: "有没有让扣点或回款率？没有就都填 0。",
  Q5b: "销售提成按实际售价算，还是按实际售价 × 折扣算？",
  Q5c: "多家门店的活动有没有结算说明函？",
  Q6a: "要不要活动标语？法务确认过没有？",
  Q6b: "这句标语法务确认过没有？（标语会印在保证单上，只能填法务确认过的原文）",
};

// 对话里提示用户怎么直接打字回答；每句都能被 phrases.ts 换算，照抄也能记下。
export const QUESTION_EXAMPLE: Record<QuestionId, string> = {
  Q1: "10月1日到10月7日",
  Q2: "7590门店",
  Q3: "打9折",
  Q3a: "",
  Q3b: "门店可以改价",
  Q3c: "每满都减",
  Q3d: "按实际克重",
  Q3e: "钻石类9折，一般足金类95折",
  Q4: "一般足金类",
  Q4a: "要转outlet餐牌",
  Q5a: "没有让扣点和回款率",
  Q5b: "提成按实际售价算",
  Q5c: "有结算说明函",
  Q6a: "不要标语",
  Q6b: "法务确认过了",
};

export function gapsOf(draft: Ics1811Draft): Gap[] {
  const f = draft.facts;
  const gaps: Gap[] = [];
  const push = (id: QuestionId, extra: Partial<Gap> = {}) => gaps.push({ id, title: QUESTION_TITLE[id], ...extra });

  if (!f.dates) push("Q1");
  if (!f.stores) {
    const candidates = [...new Set(draft.unresolvedStores.flatMap((mention) => storeCandidates(mention).map((entry) => entry.display)))];
    push("Q2", candidates.length ? { candidates } : {});
  }

  const offer = f.offer?.value;
  if (!offer) {
    push("Q3");
  } else if (offer.pattern !== "unsupported") {
    const first = offer.items[0];
    const lacks = missingOfferParams(offer.pattern, offer.items);
    if (lacks.length) push("Q3a", { title: `还差：${lacks.join("、")}？` });
    if (offer.pattern === "discount" && !f.discountEditable) {
      push("Q3b", f.priceTypes ? { hint: `浮动折扣模式限定不了售价类型，要限定「${f.priceTypes.value.join("、")}」只能用固定折扣模式` } : {});
    }
    if (offer.pattern === "threshold" && !f.thresholdRepeat) {
      push("Q3c", first?.threshold != null && first.amount != null ? { title: `买满 ${first.threshold * 2} 元时，是减一次 ${first.amount}，还是减两次共 ${first.amount * 2}？` } : {});
    }
    if (offer.pattern === "per_gram" && !f.gramBasis) {
      push("Q3d", first?.amount != null ? { title: `每克减 ${first.amount} 元是按实际克重算，还是按单件重量的整数克算？` } : {});
    }
    if ((offer.pattern === "discount" || offer.pattern === "per_gram") && offer.items.length > 1 && offer.items.some((item) => !item.categories?.length)) push("Q3e");
  }

  const slots = categorySlots(draft).filter((slot) => !slotCategories(draft, slot));
  if (slots.length) {
    const candidates = [...new Set(draft.unresolvedCategories.flatMap((mention) => {
      const result = resolveCategory(mention);
      return result.status === "ambiguous" ? result.candidates.map((entry) => entry.label) : [];
    }))];
    push("Q4", {
      slots,
      ...(slots.includes("diamond") ? { title: "钻石和黄金分别是哪些货类参加？" } : {}),
      ...(candidates.length ? { candidates } : {}),
    });
  }
  if (f.productScope?.value === "1" && !f.menuConversion) push("Q4a");

  if (!f.rates) push("Q5a");
  if (!f.commission) push("Q5b");
  if ((f.stores?.value.length ?? 0) >= 2 && !f.settlementLetter) push("Q5c");
  if (!f.slogan) push("Q6a");
  else if (f.slogan.value.wanted && f.slogan.value.legalConfirmed === null) push("Q6b");
  return gaps;
}

// roundsUsed：消息记录里已经出过的追问卡片轮数；askedBefore：上一张卡片问过的题。
export function planNext(draft: Ics1811Draft, fill: FillModel, checks: readonly Check[], roundsUsed: number, askedBefore: readonly QuestionId[] = []): Plan {
  if (fill.outOfScope) return { action: "out_of_scope", reason: fill.outOfScope };
  const gaps = gapsOf(draft).map((gap) => (askedBefore.includes(gap.id) ? { ...gap, repeated: true } : gap));
  if (gaps.length && roundsUsed < MAX_ROUNDS) return { action: "ask", round: roundsUsed === 0 ? 1 : 2, questions: gaps };
  const blockers = checks.filter((check) => check.severity === "blocker");
  return { action: "readback", canConfirm: gaps.length === 0 && blockers.length === 0, missing: gaps, blockers };
}
