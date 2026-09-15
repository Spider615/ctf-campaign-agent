// 追问卡片的结构化回答 → 事实层。卡片上点选的值直接记为用户来源，不做原话核对。

import { categoryByCode, storeByCode } from "./codebook.ts";
import { emptyItem, mergeOffer, setFact } from "./facts.ts";
import type { Ics1811Draft, OfferItem, OfferPattern, QuestionId } from "./types.ts";

export type CardResult = { draft: Ics1811Draft; applied: QuestionId[]; ignored: Array<{ id: string; reason: string }> };

type Answer = Record<string, unknown>;
type Handler = (draft: Ics1811Draft, answer: Answer, quote: string) => string | null;

const ORDER: QuestionId[] = ["Q1", "Q2", "Q3", "Q3a", "Q3b", "Q3c", "Q3d", "Q3e", "Q4", "Q4a", "Q5a", "Q5b", "Q5c", "Q6a", "Q6b"];
const PATTERNS: readonly OfferPattern[] = ["discount", "threshold", "per_gram", "platinum_tradein", "diamond_upgrade", "gold_tradein", "diamond_gold_gram"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Answer => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const codes = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : []);

function toItem(raw: unknown): OfferItem | null {
  if (!isRecord(raw)) return null;
  const item: OfferItem = {
    ...emptyItem(),
    discount: numberOrNull(raw.discount),
    upgradeRatio: numberOrNull(raw.upgradeRatio),
    multiple: numberOrNull(raw.multiple),
    threshold: numberOrNull(raw.threshold),
    amount: numberOrNull(raw.amount),
  };
  const values = [item.discount, item.upgradeRatio, item.multiple, item.threshold, item.amount].filter((value): value is number => value !== null);
  if (values.some((value) => value < 0) || (item.discount !== null && item.discount > 1)) return null;
  return item;
}

const offerHandler = (requirePattern: boolean): Handler => (draft, answer, quote) => {
  const existing = draft.facts.offer?.value ?? null;
  const pattern = PATTERNS.find((item) => item === answer.pattern) ?? (requirePattern ? undefined : existing?.pattern);
  if (!pattern) return "请选择优惠方式";
  const items = Array.isArray(answer.items) ? answer.items.map(toItem) : [];
  if (items.some((item) => item === null)) return "折扣要填 0 到 1 之间的小数，金额和比例不能为负";
  setFact(draft, "offer", mergeOffer(existing, { pattern, items: items as OfferItem[], unsupportedType: null }), quote, "card");
  return null;
};

const HANDLERS: Record<QuestionId, Handler> = {
  Q1: (draft, answer, quote) => {
    const { start, end } = answer;
    if (typeof start !== "string" || typeof end !== "string" || !DATE.test(start) || !DATE.test(end)) return "日期要填 YYYY-MM-DD";
    if (start > end) return "开始日期不能晚于结束日期";
    setFact(draft, "dates", { start, end }, quote, "card");
    return null;
  },
  Q2: (draft, answer, quote) => {
    const stores = codes(answer.stores);
    if (!stores.length || stores.some((code) => !storeByCode(code))) return "请从门店列表里选择";
    setFact(draft, "stores", stores, quote, "card");
    draft.unresolvedStores = [];
    return null;
  },
  Q3: offerHandler(true),
  Q3a: offerHandler(false),
  Q3b: (draft, answer, quote) => {
    if (typeof answer.editable !== "boolean") return "请选择门店能不能改价";
    setFact(draft, "discountEditable", answer.editable, quote, "card");
    return null;
  },
  Q3c: (draft, answer, quote) => {
    if (answer.repeat !== "once" && answer.repeat !== "every") return "请选择减一次还是每满都减";
    setFact(draft, "thresholdRepeat", answer.repeat, quote, "card");
    return null;
  },
  Q3d: (draft, answer, quote) => {
    if (answer.basis !== "actual" && answer.basis !== "whole") return "请选择按实际克重还是按整克";
    setFact(draft, "gramBasis", answer.basis, quote, "card");
    return null;
  },
  Q3e: (draft, answer, quote) => {
    const offer = draft.facts.offer;
    if (!offer || !Array.isArray(answer.items)) return "请为每条优惠选择货类";
    const items = offer.value.items.map((item) => ({ ...item }));
    for (const pair of answer.items) {
      const index = isRecord(pair) ? numberOrNull(pair.index) : null;
      const picked = isRecord(pair) ? codes(pair.categories) : [];
      if (index === null || !items[index] || !picked.length || picked.some((code) => !categoryByCode(code))) return "请为每条优惠选择货类";
      items[index].categories = picked;
    }
    setFact(draft, "offer", { ...offer.value, items }, quote, "card");
    return null;
  },
  Q4: (draft, answer, quote) => {
    if (!isRecord(answer.slots)) return "请选择参与的货类";
    const slots: Record<string, string[]> = Object.fromEntries(
      Object.entries(answer.slots).map(([slot, value]): [string, string[]] => [slot, codes(value)]).filter(([, value]) => value.length > 0),
    );
    if (!Object.keys(slots).length || Object.values(slots).flat().some((code) => !categoryByCode(code))) return "请从货类列表里选择";
    setFact(draft, "categories", { ...(draft.facts.categories?.value ?? {}), ...slots }, quote, "card");
    draft.unresolvedCategories = [];
    return null;
  },
  Q4a: (draft, answer, quote) => {
    if (typeof answer.convert !== "boolean") return "请选择要不要转 outlet 餐牌";
    setFact(draft, "menuConversion", answer.convert, quote, "card");
    return null;
  },
  Q5a: (draft, answer, quote) => {
    if (answer.none === true) {
      setFact(draft, "rates", { concession: 0, collection: 0 }, quote, "card");
      return null;
    }
    const concession = numberOrNull(answer.concession);
    const collection = numberOrNull(answer.collection);
    if (concession === null || collection === null || concession < 0 || concession > 1 || collection < 0 || collection > 1) return "让扣点和回款率要填 0 到 1 之间的小数，2% 填 0.02";
    setFact(draft, "rates", { concession, collection }, quote, "card");
    return null;
  },
  Q5b: (draft, answer, quote) => {
    if (answer.commission !== "actual_price" && answer.commission !== "price_times_discount") return "请选择提成口径";
    setFact(draft, "commission", answer.commission, quote, "card");
    return null;
  },
  Q5c: (draft, answer, quote) => {
    if (typeof answer.has !== "boolean") return "请选择有没有结算说明函";
    setFact(draft, "settlementLetter", answer.has, quote, "card");
    return null;
  },
  Q6a: (draft, answer, quote) => {
    if (answer.wanted === false) {
      setFact(draft, "slogan", { wanted: false }, quote, "card");
      return null;
    }
    const text = typeof answer.text === "string" ? answer.text.trim() : "";
    if (answer.wanted !== true || !text || text.length > 60 || typeof answer.legalConfirmed !== "boolean") return "要标语时请填写原文，并选择法务是否确认过";
    setFact(draft, "slogan", { wanted: true, text, legalConfirmed: answer.legalConfirmed }, quote, "card");
    return null;
  },
  Q6b: (draft, answer, quote) => {
    const slogan = draft.facts.slogan?.value;
    if (!slogan?.wanted || typeof answer.legalConfirmed !== "boolean") return "请选择标语法务是否确认过";
    setFact(draft, "slogan", { ...slogan, legalConfirmed: answer.legalConfirmed }, quote, "card");
    return null;
  },
};

export function applyCardAnswers(input: Ics1811Draft, answers: unknown): CardResult {
  const draft = structuredClone(input);
  const applied: QuestionId[] = [];
  const ignored: CardResult["ignored"] = [];
  if (!isRecord(answers)) return { draft, applied, ignored };
  for (const key of Object.keys(answers)) {
    if (!ORDER.includes(key as QuestionId)) ignored.push({ id: key, reason: "不是卡片上的问题" });
  }
  for (const id of ORDER) {
    if (!(id in answers)) continue;
    const raw = answers[id];
    const error = isRecord(raw) ? HANDLERS[id](draft, raw, `卡片：${id}`) : "回答内容不完整";
    if (error) ignored.push({ id, reason: error });
    else applied.push(id);
  }
  return { draft, applied, ignored };
}
