// 「这一轮新填了哪几项」。活动是一步步搭起来的，但界面只显示最终态，
// 看不出某一格是刚填上的还是一直都在。改动本来就记在 agent_change 里，这里只是把它翻译回事实 key。

import { FACT_LABEL, type ChatMessage } from "./messages.ts";
import type { ActivityInfo, FactKey } from "./types.ts";

// FACT_LABEL 是 key → 中文标签，这里要反过来查。名称、内容这类走 copy 的标签不在表里，会被丢掉。
const KEY_BY_LABEL = new Map<string, FactKey>(
  (Object.keys(FACT_LABEL) as FactKey[]).map((key) => [FACT_LABEL[key], key]),
);

export function recentlyFilled(messages: readonly ChatMessage[], latestSeq: number): FactKey[] {
  const keys: FactKey[] = [];
  for (const message of messages) {
    const content = message.content;
    // 只认最新版本那一轮的改动；历史版本的不累加，否则越到后面标得越多，等于没标。
    if (content.kind !== "agent_change" || content.versionSeq !== latestSeq) continue;
    for (const item of content.items) {
      const key = KEY_BY_LABEL.get(item.label);
      // 对不上事实 key 的标签直接丢掉，不猜。
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

// 一个事实会喂到活动信息的哪几栏。照 derive.ts 里真实存在的关系写，不臆造：
// 日期填开始和结束两栏；门店先换算出区域再填分行；品牌决定审批流；名称和内容由 templateCopy 拼，
// 所以货类、优惠、克重口径、满减累加、货品范围变了它们也会变。
// 只出现在明细里的事实（让扣点、号头、会员级别等）映射为空——这一版高亮只覆盖活动信息，不假装标到了明细。
const FIELDS_BY_FACT: Record<FactKey, ReadonlyArray<keyof ActivityInfo>> = {
  dates: ["startDate", "endDate"],
  stores: ["region", "branches"],
  offer: ["name", "content"],
  categories: ["name", "content"],
  gramBasis: ["name", "content"],
  thresholdRepeat: ["name", "content"],
  discountEditable: ["content"],
  productScope: ["productScope", "name", "content"],
  menuConversion: ["menuConversion"],
  commission: ["commission"],
  slogan: ["slogan"],
  brands: ["brand", "approvalFlow"],
  weekdays: ["cycle"],
  online: ["channel"],
  paymentRemove: ["paymentMethods"],
  paymentAdd: ["paymentMethods"],
  rates: [],
  settlementLetter: [],
  headCodes: [],
  memberLevels: [],
  priceTypes: [],
  restrictions: [],
};

export function highlightedFields(keys: readonly FactKey[]): Set<keyof ActivityInfo> {
  const fields = new Set<keyof ActivityInfo>();
  for (const key of keys) for (const field of FIELDS_BY_FACT[key]) fields.add(field);
  return fields;
}
