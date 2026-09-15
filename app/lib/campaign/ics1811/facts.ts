// 事实层写入与原话依据守卫（设计文档 6.2、6.3 节）。
// 模型提出的每一项都要附原话片段；片段必须在用户这一轮的话里，数值由代码从片段重新换算。
// RULES 覆盖全部 FactKey，没有「默认当作用户说过」的分支。

import { normalizeText } from "../evidence.ts";
import { CODEBOOK } from "./codebook.ts";
import { detectPattern } from "./offer-spec.ts";
import * as P from "./phrases.ts";
import { findInText, headCodesInText, normalizeName, paymentMethodsInText, resolveCategory, resolveStore, storesInText } from "./resolve.ts";
import type { FactKey, FactVia, Facts, Ics1811Draft, OfferFact, OfferItem, OfferPattern, QuestionId, RestrictionKey, RestrictionMention } from "./types.ts";

export function emptyFacts(): Facts {
  return {
    dates: null, stores: null, offer: null, discountEditable: null, thresholdRepeat: null, gramBasis: null, categories: null,
    menuConversion: null, rates: null, commission: null, settlementLetter: null, slogan: null, brands: null, weekdays: null,
    online: null, productScope: null, paymentRemove: null, paymentAdd: null, headCodes: null, memberLevels: null, priceTypes: null,
    restrictions: null,
  };
}

export function createEmptyDraft(id: string, requestText: string): Ics1811Draft {
  return { schema: "ics1811/v1", id, requestText, facts: emptyFacts(), unresolvedStores: [], unresolvedCategories: [], copy: null, dismissedNotes: [] };
}

export type FactWrite = { key: FactKey; value?: unknown; quote: string };
export type WriteContext = { text: string; today: string; openQuestions?: readonly QuestionId[] };
export type Dropped = { key: FactKey; quote: string; reason: string };
export type WriteResult = { draft: Ics1811Draft; applied: FactKey[]; dropped: Dropped[] };

type Outcome = { ok: true; keys?: FactKey[] } | { ok: false; reason: string };
type RuleContext = WriteContext & { open: readonly QuestionId[]; via: FactVia };
type Rule = (draft: Ics1811Draft, quote: string, value: unknown, context: RuleContext) => Outcome;

const PUNCTUATION = /[，,。．.；;：:！!？?、"“”「」『』'‘’\s]/g;
export const compactQuote = (text: string) => normalizeName(normalizeText(text)).replace(PUNCTUATION, "");

export function setFact<K extends FactKey>(draft: Ics1811Draft, key: K, value: NonNullable<Facts[K]>["value"], quote: string, via: FactVia): void {
  (draft.facts as Record<FactKey, unknown>)[key] = { value, quote, via };
}

const fail = (reason: string): Outcome => ({ ok: false, reason });
const ok = (...keys: FactKey[]): Outcome => ({ ok: true, keys });
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : typeof value === "string" && value.trim() ? [value] : []);

export const emptyItem = (): OfferItem => ({ discount: null, upgradeRatio: null, multiple: null, threshold: null, amount: null, categories: null });

const SINGLE_ITEM_PATTERNS: readonly OfferPattern[] = ["per_gram", "platinum_tradein", "diamond_upgrade", "diamond_gold_gram"];

export function parseOfferItems(pattern: OfferPattern, quote: string): OfferItem[] {
  switch (pattern) {
    case "discount": {
      const clauses = quote.split(/[，,；;。]/);
      const items = clauses.flatMap((clause) => {
        const codes = findInText(CODEBOOK.categories, clause, false).map((entry) => entry.code);
        return P.discountsFrom(clause).map((discount) => ({ ...emptyItem(), discount, categories: codes.length ? codes : null }));
      });
      return items.length > 1 ? items : items.map((item) => ({ ...item, categories: null }));
    }
    case "threshold":
      return P.thresholdsFrom(quote).map(({ threshold, amount }) => ({ ...emptyItem(), threshold, amount }));
    case "per_gram": {
      const amount = P.perGramAmountFrom(quote);
      return amount === null ? [] : [{ ...emptyItem(), amount }];
    }
    case "platinum_tradein": {
      const multiple = P.multipleFrom(quote);
      const discount = P.billingDiscountFrom(quote);
      return multiple === null && discount === null ? [] : [{ ...emptyItem(), multiple, discount }];
    }
    case "diamond_upgrade": {
      const discount = P.billingDiscountFrom(quote);
      return discount === null ? [] : [{ ...emptyItem(), discount }];
    }
    case "gold_tradein":
      return P.goldTiersFrom(quote).map(({ upgradeRatio, discount }) => ({ ...emptyItem(), upgradeRatio, discount }));
    case "diamond_gold_gram": {
      const { discount, amount } = P.diamondGoldFrom(quote);
      return discount === null && amount === null ? [] : [{ ...emptyItem(), discount, amount }];
    }
    case "unsupported":
      return [];
  }
}

// 同一玩法下补充参数：单条玩法按字段合并，多条玩法有新值就整体替换。
export function mergeOffer(existing: OfferFact | null, next: OfferFact): OfferFact {
  if (!existing || existing.pattern !== next.pattern || next.pattern === "unsupported") return next;
  if (!next.items.length) return existing;
  if (SINGLE_ITEM_PATTERNS.includes(next.pattern)) {
    const base = existing.items[0] ?? emptyItem();
    const update = next.items[0];
    const merged = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, update[key as keyof OfferItem] ?? value])) as OfferItem;
    return { ...existing, items: [merged] };
  }
  return { ...existing, items: next.items };
}

const RULES: Record<FactKey, Rule> = {
  dates: (draft, quote, _value, context) => {
    const range = P.dateRangeFrom(quote, context.today);
    if (!range) return fail("原话里没有能换算的起止月日，「国庆」「下周」这类说法要问具体日期");
    setFact(draft, "dates", range, quote, context.via);
    return ok();
  },
  stores: (draft, quote, value, context) => {
    const mentions = strings(value);
    const found = new Set(storesInText(quote).map((entry) => entry.code));
    const unresolved: string[] = [];
    for (const mention of mentions) {
      if (!compactQuote(quote).includes(compactQuote(mention))) continue;
      const result = resolveStore(mention);
      if (result.status === "ok") found.add(result.entry.code);
      else unresolved.push(mention);
    }
    draft.unresolvedStores = [...new Set([...draft.unresolvedStores, ...unresolved])];
    if (!found.size) return fail(unresolved.length ? `门店对不上代码表：${unresolved.join("、")}` : "片段里没有门店");
    setFact(draft, "stores", [...found], quote, context.via);
    draft.unresolvedStores = draft.unresolvedStores.filter((mention) => resolveStore(mention).status !== "ok");
    return ok();
  },
  offer: (draft, quote, _value, context) => {
    const existing = draft.facts.offer?.value ?? null;
    const detected = detectPattern(quote);
    const pattern = detected?.pattern ?? existing?.pattern;
    if (!pattern) return fail("原话里看不出优惠方式和力度");
    const next: OfferFact = { pattern, items: parseOfferItems(pattern, quote), unsupportedType: detected?.unsupportedType ?? existing?.unsupportedType ?? null };
    if (!detected && !next.items.length) return fail("片段里没有能换算的优惠数值");
    setFact(draft, "offer", mergeOffer(existing, next), quote, context.via);
    // 同一句里顺带说清的追问项（是否累加、克重口径、能否改价）一并记下。
    const side: FactKey[] = [];
    const repeat = P.thresholdRepeatFrom(quote) ?? (pattern === "threshold" && P.thresholdsFrom(quote).some((item) => item.every) ? "every" : null);
    if (pattern === "threshold" && repeat) {
      setFact(draft, "thresholdRepeat", repeat, quote, context.via);
      side.push("thresholdRepeat");
    }
    const basis = P.gramBasisFrom(quote);
    if (pattern === "per_gram" && basis) {
      setFact(draft, "gramBasis", basis, quote, context.via);
      side.push("gramBasis");
    }
    const editable = P.discountEditableFrom(quote);
    if (pattern === "discount" && editable !== null) {
      setFact(draft, "discountEditable", editable, quote, context.via);
      side.push("discountEditable");
    }
    return ok(...side);
  },
  discountEditable: (draft, quote, _value, context) => {
    const editable = P.discountEditableFrom(quote) ?? (context.open.includes("Q3b") ? P.yesNo(quote) : null);
    if (editable === null) return fail("没说门店能不能在折扣基础上改价");
    setFact(draft, "discountEditable", editable, quote, context.via);
    return ok();
  },
  thresholdRepeat: (draft, quote, _value, context) => {
    const repeat = P.thresholdRepeatFrom(quote) ?? (context.open.includes("Q3c") ? (/两次|都减/.test(quote) ? "every" : /一次/.test(quote) ? "once" : null) : null);
    if (!repeat) return fail("没说满减是否累加");
    setFact(draft, "thresholdRepeat", repeat, quote, context.via);
    return ok();
  },
  gramBasis: (draft, quote, _value, context) => {
    const basis = P.gramBasisFrom(quote);
    if (!basis) return fail("没说按实际克重还是按整克");
    setFact(draft, "gramBasis", basis, quote, context.via);
    return ok();
  },
  categories: (draft, quote, value, context) => {
    const slots: Record<string, string[]> = value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([slot, mentions]) => [slot, strings(mentions)]))
      : { all: strings(value).length ? strings(value) : findInText(CODEBOOK.categories, quote).map((entry) => entry.label) };
    const resolved: Record<string, string[]> = {};
    const unresolved: string[] = [];
    for (const [slot, mentions] of Object.entries(slots)) {
      const codes = mentions.filter((mention) => compactQuote(quote).includes(compactQuote(mention))).flatMap((mention) => {
        const result = resolveCategory(mention);
        if (result.status === "ok") return [result.entry.code];
        unresolved.push(mention);
        return [];
      });
      if (codes.length) resolved[slot] = [...new Set(codes)];
    }
    draft.unresolvedCategories = [...new Set([...draft.unresolvedCategories, ...unresolved])];
    if (!Object.keys(resolved).length) return fail(unresolved.length ? `货类有歧义或对不上：${unresolved.join("、")}` : "片段里没有货类");
    setFact(draft, "categories", { ...(draft.facts.categories?.value ?? {}), ...resolved }, quote, context.via);
    draft.unresolvedCategories = draft.unresolvedCategories.filter((mention) => resolveCategory(mention).status !== "ok");
    return ok();
  },
  menuConversion: (draft, quote, _value, context) => {
    const convert = P.menuConversionFrom(quote) ?? (context.open.includes("Q4a") ? P.yesNo(quote) : null);
    if (convert === null) return fail("没说要不要转 outlet 餐牌");
    setFact(draft, "menuConversion", convert, quote, context.via);
    return ok();
  },
  rates: (draft, quote, _value, context) => {
    const asked = context.open.includes("Q5a");
    if (!/扣点|回款/.test(quote) && !asked) return fail("片段里没有让扣点或回款率");
    const rates = P.ratesFrom(quote) ?? (asked && P.yesNo(quote) === false ? { concession: 0, collection: 0 } : null);
    if (!rates) return fail("让扣点和回款率要同时给出，没有就说没有；百分数写成「2%」");
    setFact(draft, "rates", rates, quote, context.via);
    return ok();
  },
  commission: (draft, quote, _value, context) => {
    const commission = P.commissionFrom(quote, context.open.includes("Q5b"));
    if (!commission) return fail("没说销售提成按实际售价还是按实际售价 × 折扣算；只说「折上折」「可叠加」不算");
    setFact(draft, "commission", commission, quote, context.via);
    return ok();
  },
  settlementLetter: (draft, quote, _value, context) => {
    const has = P.settlementLetterFrom(quote) ?? (context.open.includes("Q5c") ? P.yesNo(quote) : null);
    if (has === null) return fail("没说有没有结算说明函");
    setFact(draft, "settlementLetter", has, quote, context.via);
    return ok();
  },
  slogan: (draft, quote, _value, context) => {
    const parsed = P.sloganFrom(quote);
    const existing = draft.facts.slogan?.value;
    if (parsed?.wanted === false) {
      setFact(draft, "slogan", { wanted: false }, quote, context.via);
      return ok();
    }
    if (parsed?.wanted && parsed.text) {
      if (!compactQuote(context.text).includes(compactQuote(parsed.text))) return fail("标语必须是用户给出的原文");
      setFact(draft, "slogan", { wanted: true, text: parsed.text, legalConfirmed: parsed.legalConfirmed }, quote, context.via);
      return ok();
    }
    const legal = P.legalConfirmedFrom(quote) ?? (context.open.includes("Q6b") || context.open.includes("Q6a") ? P.yesNo(quote) : null);
    if (existing?.wanted && legal !== null) {
      setFact(draft, "slogan", { ...existing, legalConfirmed: legal }, quote, context.via);
      return ok();
    }
    if (context.open.includes("Q6a") && P.yesNo(quote) === false) {
      setFact(draft, "slogan", { wanted: false }, quote, context.via);
      return ok();
    }
    return fail("标语只能照抄法务确认过的原文，没给原文不写");
  },
  brands: (draft, quote, _value, context) => {
    const brands = findInText(CODEBOOK.brands, quote).map((entry) => entry.code);
    if (!brands.length) return fail("片段里没有品牌");
    setFact(draft, "brands", brands, quote, context.via);
    return ok();
  },
  weekdays: (draft, quote, _value, context) => {
    const days = P.weekdaysFrom(quote);
    if (!days) return fail("片段里没有每周几");
    setFact(draft, "weekdays", days, quote, context.via);
    return ok();
  },
  online: (draft, quote, _value, context) => {
    const online = P.onlineFrom(quote);
    if (online === null) return fail("片段里没有线上或线下");
    setFact(draft, "online", online, quote, context.via);
    return ok();
  },
  productScope: (draft, quote, _value, context) => {
    const scope = findInText(CODEBOOK.productScopes, quote)[0];
    if (!scope) return fail("片段里没有货品范围");
    setFact(draft, "productScope", scope.code, quote, context.via);
    return ok();
  },
  paymentRemove: (draft, quote, _value, context) => {
    const methods = /不支持|去掉|不含|不能用|不可用|排除/.test(quote) ? paymentMethodsInText(quote) : [];
    if (!methods.length) return fail("片段里没有要去掉的付款方式");
    setFact(draft, "paymentRemove", methods, quote, context.via);
    return ok();
  },
  paymentAdd: (draft, quote, _value, context) => {
    const methods = /不支持|去掉|不含|不能用|不可用|排除/.test(quote) ? [] : paymentMethodsInText(quote).filter((name) => !CODEBOOK.paymentMethods.defaults.includes(name));
    if (!methods.length) return fail("片段里没有要增加的付款方式");
    setFact(draft, "paymentAdd", methods, quote, context.via);
    return ok();
  },
  headCodes: (draft, quote, _value, context) => {
    const codes = headCodesInText(quote);
    if (!codes.length) return fail("片段里没有号头代码");
    setFact(draft, "headCodes", codes, quote, context.via);
    return ok();
  },
  memberLevels: (draft, quote, _value, context) => {
    const levels = findInText(CODEBOOK.memberLevels, quote).map((entry) => entry.code);
    if (!levels.length) return fail("片段里没有会员级别");
    setFact(draft, "memberLevels", levels, quote, context.via);
    return ok();
  },
  priceTypes: (draft, quote, _value, context) => {
    const types = findInText(CODEBOOK.priceTypes, quote).map((entry) => entry.code);
    if (!types.length) return fail("片段里没有售价类型");
    setFact(draft, "priceTypes", types, quote, context.via);
    return ok();
  },
  restrictions: (draft, quote, value, context) => {
    const raw = Array.isArray(value) ? value : [value];
    const mentions: RestrictionMention[] = raw.flatMap((item) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const text = typeof record.text === "string" && record.text.trim() ? record.text.trim() : quote;
      if (!compactQuote(quote).includes(compactQuote(text))) return [];
      const field = typeof record.field === "string" && RESTRICTION_KEYS.includes(record.field as RestrictionKey) ? (record.field as RestrictionKey) : null;
      const code = typeof record.value === "string" && /^[0-9A-Z,]+$/.test(record.value) && quote.includes(record.value) ? record.value : null;
      return [{ field: code ? field : null, value: field ? code : null, text }];
    });
    if (!mentions.length) return fail("片段里没有排除条件");
    setFact(draft, "restrictions", [...(draft.facts.restrictions?.value ?? []), ...mentions], quote, context.via);
    return ok();
  },
};

export const RESTRICTION_KEYS: readonly RestrictionKey[] = [
  "allowModel", "denyModel", "allowSeries", "denySeries", "priceCap", "priceFloor", "allowInlay", "denyInlay", "allowModelCategory", "denyGoodsGroup", "orderAmountMin",
];

export function applyFactWrites(input: Ics1811Draft, writes: readonly FactWrite[], context: WriteContext, via: FactVia = "text"): WriteResult {
  const draft = structuredClone(input);
  const applied: FactKey[] = [];
  const dropped: Dropped[] = [];
  const said = compactQuote(context.text);
  for (const write of writes) {
    const quote = typeof write.quote === "string" ? write.quote.trim() : "";
    const rule = RULES[write.key];
    if (!rule) {
      dropped.push({ key: write.key, quote, reason: "不认识的字段" });
      continue;
    }
    if (!quote || !said.includes(compactQuote(quote))) {
      dropped.push({ key: write.key, quote, reason: "原话片段不在用户这一轮说的话里" });
      continue;
    }
    const outcome = rule(draft, quote, write.value, { ...context, open: context.openQuestions ?? [], via });
    if (outcome.ok) applied.push(write.key, ...(outcome.keys ?? []));
    else dropped.push({ key: write.key, quote, reason: outcome.reason });
  }
  return { draft, applied: [...new Set(applied)], dropped };
}
