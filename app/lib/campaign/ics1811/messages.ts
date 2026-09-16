// 对话消息（v: 2）。旧会话的 v1 消息读到时只保留一句文字。
// 对话状态（第几轮、卡片是否还开着、最新复述）全部从消息记录推出，不另存，撤销和恢复不会重置轮次。

import { byCode, CODEBOOK } from "./codebook.ts";
import { fillSheetText, type FillSheet } from "./fill-sheet.ts";
import type { Readback } from "./readback.ts";
import type { FactKey, Facts, Gap, Ics1811Draft, OfferFact, QuestionId } from "./types.ts";
import { isToolTrace, traceSummary, type ToolTrace } from "../../tool-trace.ts";

export type ChangeItem = { label: string; before: string; after: string };
export type RetryInput = { type: "text"; text: string } | { type: "interpret" };

export type StoredMessage =
  | { v: 2; kind: "user_text"; text: string }
  | { v: 2; kind: "user_card_submit"; round: number; label: string }
  | { v: 2; kind: "user_edit"; label: string; origin: "panel" | "tool" }
  | { v: 2; kind: "user_event"; event: "confirm" | "undo" | "rollback" | "dismiss"; label: string }
  | { v: 2; kind: "agent_text"; text: string }
  | { v: 2; kind: "agent_error"; text: string; retry?: RetryInput }
  | { v: 2; kind: "agent_tool_trace"; trace: ToolTrace }
  | { v: 2; kind: "agent_round_card"; round: 1 | 2; questions: Gap[] }
  | { v: 2; kind: "agent_change"; title: string; items: ChangeItem[]; versionSeq: number }
  | { v: 2; kind: "agent_readback"; versionSeq: number; readback: Readback }
  | { v: 2; kind: "agent_fill_sheet"; versionSeq: number; sheet: FillSheet };

export type MessageKind = StoredMessage["kind"];

export type ChatMessage = { id: string; role: "user" | "assistant"; createdAt: string; content: StoredMessage };

export type RoundCardMessage = ChatMessage & { content: Extract<StoredMessage, { kind: "agent_round_card" }> };
export type ReadbackMessage = ChatMessage & { content: Extract<StoredMessage, { kind: "agent_readback" }> };

export function encodeMessage(message: StoredMessage): string {
  return JSON.stringify(message);
}

function legacyText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; label?: unknown };
    if (typeof parsed?.text === "string") return parsed.text;
    if (typeof parsed?.label === "string") return parsed.label;
    return "（旧版本消息）";
  } catch {
    return raw;
  }
}

export function decodeMessage(role: string, raw: string): StoredMessage {
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; kind?: unknown; trace?: unknown };
    if (parsed && parsed.v === 2 && typeof parsed.kind === "string") {
      if (parsed.kind === "agent_tool_trace" && !isToolTrace(parsed.trace)) throw new Error("工具执行记录不完整");
      return parsed as StoredMessage;
    }
  } catch {
    // 旧数据可能是纯文本。
  }
  return role === "user" ? { v: 2, kind: "user_text", text: legacyText(raw) } : { v: 2, kind: "agent_text", text: legacyText(raw) };
}

export function messageToText(message: StoredMessage): string {
  switch (message.kind) {
    case "user_text":
    case "agent_text":
    case "agent_error":
      return message.text;
    case "agent_tool_trace":
      return traceSummary(message.trace);
    case "user_card_submit":
    case "user_edit":
    case "user_event":
      return message.label;
    case "agent_round_card":
      return [`第 ${message.round} 轮，还需要你补充：`, ...message.questions.map((question) => `- ${question.title}`)].join("\n");
    case "agent_change":
      return [message.title, ...message.items.map((item) => `${item.label}：${item.before} → ${item.after}`)].join("\n");
    case "agent_readback":
      return message.readback.paragraph;
    case "agent_fill_sheet":
      return fillSheetText(message.sheet);
    default:
      return "";
  }
}

export type FlowState = {
  roundsUsed: number;
  askedBefore: QuestionId[];
  openCard: RoundCardMessage | null;
  latestReadback: ReadbackMessage | null;
  confirmedSeq: number | null;
};

const CLOSES_CARD: readonly MessageKind[] = ["user_card_submit", "agent_readback", "agent_fill_sheet"];

export function flowOf(messages: readonly ChatMessage[]): FlowState {
  let roundsUsed = 0;
  let lastCardIndex = -1;
  messages.forEach((message, index) => {
    if (message.content.kind !== "agent_round_card") return;
    roundsUsed = Math.max(roundsUsed, message.content.round);
    lastCardIndex = index;
  });
  const lastCard = lastCardIndex >= 0 ? (messages[lastCardIndex] as RoundCardMessage) : null;
  const closed = !lastCard || messages.slice(lastCardIndex + 1).some((message) => CLOSES_CARD.includes(message.content.kind));
  const latestReadback = [...messages].reverse().find((message) => message.content.kind === "agent_readback") as ReadbackMessage | undefined;
  const latestSheet = [...messages].reverse().find((message) => message.content.kind === "agent_fill_sheet");
  return {
    roundsUsed,
    askedBefore: lastCard ? lastCard.content.questions.map((question) => question.id) : [],
    openCard: closed ? null : lastCard,
    latestReadback: latestReadback ?? null,
    confirmedSeq: latestSheet?.content.kind === "agent_fill_sheet" ? latestSheet.content.versionSeq : null,
  };
}

export const FACT_LABEL: Record<FactKey, string> = {
  dates: "活动日期",
  stores: "门店",
  offer: "优惠",
  discountEditable: "能否改价",
  thresholdRepeat: "满减是否累加",
  gramBasis: "克重口径",
  categories: "货类",
  menuConversion: "转换餐牌",
  rates: "让扣点和回款率",
  commission: "提成口径",
  settlementLetter: "结算说明函",
  slogan: "活动标语",
  brands: "品牌",
  weekdays: "每周生效日",
  online: "线上 / 线下",
  productScope: "货品范围",
  paymentRemove: "去掉的付款方式",
  paymentAdd: "增加的付款方式",
  headCodes: "号头",
  memberLevels: "会员级别",
  priceTypes: "售价类型",
  restrictions: "限制条件",
};

const OFFER_NAME: Record<OfferFact["pattern"], string> = {
  discount: "打折",
  threshold: "满减",
  per_gram: "每克减",
  platinum_tradein: "铂金以旧换新",
  diamond_upgrade: "钻石以小换大",
  gold_tradein: "黄金以旧换新",
  diamond_gold_gram: "买钻石享黄金克减",
  unsupported: "暂不支持",
};

function offerText(offer: OfferFact): string {
  const items = offer.items.map((item) =>
    [
      item.threshold !== null ? `满 ${item.threshold}` : "",
      item.amount !== null ? (offer.pattern === "per_gram" || offer.pattern === "diamond_gold_gram" ? `每克减 ${item.amount}` : `减 ${item.amount}`) : "",
      item.multiple !== null ? `${item.multiple} 倍` : "",
      item.upgradeRatio !== null ? `换大比例 ${item.upgradeRatio}` : "",
      item.discount !== null ? `${offer.pattern === "gold_tradein" ? "工费折扣" : "折扣"} ${item.discount}` : "",
    ].filter(Boolean).join(" "),
  );
  return [offer.unsupportedType ?? OFFER_NAME[offer.pattern], ...items.filter(Boolean)].join("：");
}

export function factText<K extends FactKey>(key: K, fact: Facts[K]): string {
  if (!fact) return "未填";
  const value: unknown = fact.value;
  switch (key) {
    case "dates": {
      const range = value as { start: string; end: string };
      return `${range.start} 至 ${range.end}`;
    }
    case "offer":
      return offerText(value as OfferFact);
    case "discountEditable":
      return value ? "门店可以改价（浮动折扣模式）" : "门店不能改价（固定折扣模式）";
    case "thresholdRepeat":
      return value === "every" ? "每满都减" : "只减一次";
    case "gramBasis":
      return value === "actual" ? "按实际克重" : "按整克";
    case "categories":
      return [...new Set(Object.values(value as Record<string, string[]>).flat())].join("、");
    case "menuConversion":
      return value ? "转为 outlet 餐牌" : "不转餐牌";
    case "rates": {
      const rates = value as { concession: number; collection: number };
      return `让扣点 ${rates.concession}，回款率 ${rates.collection}`;
    }
    case "commission":
      return value === "actual_price" ? "按实际售价算提成" : "按实际售价 × 折扣算提成";
    case "settlementLetter":
      return value ? "有" : "没有";
    case "slogan": {
      const slogan = value as { wanted: boolean; text?: string; legalConfirmed?: boolean | null };
      if (!slogan.wanted) return "不加";
      return `「${slogan.text}」${slogan.legalConfirmed === true ? "（法务已确认）" : slogan.legalConfirmed === false ? "（法务未确认）" : ""}`;
    }
    case "online":
      return value ? "线上" : "线下";
    case "restrictions":
      return (value as Array<{ text: string }>).map((item) => item.text).join("、");
    case "productScope":
      return byCode(CODEBOOK.productScopes, value as string)?.label ?? String(value);
    case "brands":
      return (value as string[]).map((code) => byCode(CODEBOOK.brands, code)?.label ?? code).join("、");
    default:
      return Array.isArray(value) ? value.join("、") : String(value);
  }
}

// 两版草稿之间用户能看懂的改动列表。
export function summarizeFactChanges(before: Ics1811Draft, after: Ics1811Draft): ChangeItem[] {
  const items = (Object.keys(FACT_LABEL) as FactKey[]).flatMap((key) => {
    const previous = factText(key, before.facts[key]);
    const next = factText(key, after.facts[key]);
    return previous === next ? [] : [{ label: FACT_LABEL[key], before: previous, after: next }];
  });
  for (const [label, pick] of [["活动名称", "name"], ["活动内容", "content"]] as const) {
    const previous = before.copy?.[pick] ?? "按模板生成";
    const next = after.copy?.[pick] ?? "按模板生成";
    if (previous !== next) items.push({ label, before: previous, after: next });
  }
  return items;
}
