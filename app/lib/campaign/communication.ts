// 营销传播方案领域逻辑。模型只能提供创意层；生成门槛、渠道边界和活动硬事实
// 都由这里根据 CampaignDraft 确定性判断与渲染。

import type { CampaignDraft, CommunicationCreative, CommunicationPlan } from "./types.ts";
import { storeByCode } from "./ics1811/codebook.ts";
import { deriveFill, discountText } from "./ics1811/derive.ts";
import type { FillModel } from "./ics1811/types.ts";

export type CommunicationRequirement =
  | "brief.objective"
  | "brief.audience"
  | "brief.theme"
  | "brief.channels"
  | "ics1811.dates"
  | "ics1811.stores"
  | "ics1811.offer"
  | "ics1811.categories";

export type CommunicationGate = {
  ready: boolean;
  missing: CommunicationRequirement[];
};

export function communicationGate(draft: CampaignDraft): CommunicationGate {
  const missing: CommunicationRequirement[] = [];
  if (!draft.brief.objective) missing.push("brief.objective");
  if (!draft.brief.audience) missing.push("brief.audience");
  if (!draft.brief.theme) missing.push("brief.theme");
  if (!draft.brief.channels?.value.length) missing.push("brief.channels");
  if (draft.ics1811) {
    if (!draft.ics1811.facts.dates) missing.push("ics1811.dates");
    if (!draft.ics1811.facts.stores?.value.length) missing.push("ics1811.stores");
    if (!draft.ics1811.facts.offer) missing.push("ics1811.offer");
    if (!draft.ics1811.facts.categories || !Object.values(draft.ics1811.facts.categories.value).some((items) => items.length)) {
      missing.push("ics1811.categories");
    }
  }
  return { ready: missing.length === 0, missing };
}

export type CommunicationCreativeValidation = {
  ok: boolean;
  errors: string[];
};

function creativeText(creative: CommunicationCreative): string {
  return [
    creative.concept.headline,
    creative.concept.subheadline,
    creative.concept.coreMessage,
    creative.visualDirection,
    ...creative.channelOutputs.flatMap((output) => [output.format, output.copy, output.cta]),
  ].join(" ");
}

function confirmedNumbers(draft: CampaignDraft): Set<string> {
  const numbers = new Set<string>();
  const addText = (value: unknown) => {
    if (typeof value === "number") {
      numbers.add(String(value));
      if (value > 0 && value <= 1) {
        const percentage = Number((value * 100).toFixed(2));
        numbers.add(String(percentage));
        numbers.add(percentage % 10 === 0 ? String(percentage / 10) : String(percentage));
      }
      return;
    }
    if (typeof value === "string") {
      for (const match of value.matchAll(/\d+(?:\.\d+)?/g)) numbers.add(match[0]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(addText);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(addText);
  };
  Object.values(draft.brief).forEach((fact) => {
    if (!fact) return;
    addText(fact.value);
    addText(fact.quote);
  });
  if (draft.ics1811) {
    Object.values(draft.ics1811.facts).forEach((fact) => {
      if (!fact) return;
      addText(fact.value);
      addText(fact.quote);
    });
  }
  return numbers;
}

const UNCONFIRMED_RIGHTS = ["赠", "送礼品", "好礼", "礼品", "抽奖", "免费", "加赠", "明星", "豪礼", "礼包", "限量", "仅剩"] as const;
const AUDIENCE_TERMS = ["会员", "情侣", "新人", "年轻人", "女性", "男性", "宝妈", "家庭", "儿童", "学生", "职场", "白领", "高净值", "Z世代", "亲子", "妈妈", "男士", "女士", "游客"] as const;

const WEEKDAY_NAME = ["", "一", "二", "三", "四", "五", "六", "日"];

function dateText(iso: string | null): string {
  return iso ? `${Number(iso.slice(0, 4))} 年 ${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日` : "";
}

function periodText(fill: FillModel): string | null {
  const start = fill.info.startDate.value;
  const end = fill.info.endDate.value;
  if (!start || !end) return null;
  const endText = start.slice(0, 4) === end.slice(0, 4) ? dateText(end).replace(/^\d+ 年 /, "") : dateText(end);
  const cycle = fill.info.cycle.value;
  const weekly = cycle && cycle !== "0"
    ? `，每周${cycle.split(",").map((day) => WEEKDAY_NAME[Number(day)]).join("、")}`
    : "";
  return `${dateText(start)}至 ${endText}${weekly}`;
}

function storesText(fill: FillModel): string | null {
  const names = fill.info.branches.value.map((code) => storeByCode(code)?.shortName ?? code);
  if (!names.length) return null;
  if (names.length > 3) return `${names.slice(0, 3).map((name) => `${name}店`).join("、")}等 ${names.length} 家门店`;
  return names.map((name) => `${name}店`).join("、");
}

function offerText(fill: FillModel): string[] {
  return fill.details.flatMap((detail) => {
    const param = (key: string) => detail.params.find((item) => item.key === key)?.value.value ?? null;
    const categories = detail.categories.value.join("、");
    if (!categories) return [];
    const amount = param("offerAmount");
    const threshold = param("judgeAmount");
    const discount = param("discount") ?? param("billingDiscount");
    switch (detail.offerType.value) {
      case "金价每克减免":
      case "金价每整克减免":
        return amount === null ? [] : [`${categories}每克立减 ${amount} 元`];
      case "满减":
        return threshold === null || amount === null ? [] : [`${categories}满 ${threshold} 元减 ${amount} 元`];
      case "每满减":
        return threshold === null || amount === null ? [] : [`${categories}每满 ${threshold} 元减 ${amount} 元`];
      case "售价固定折扣":
        return discount === null ? [] : [`${categories} ${discountText(discount)} 折`];
      case "黄金以旧换新":
        return [`${categories}以旧换新`];
      default:
        return [`${categories}参与本次活动`];
    }
  });
}

export function validateCommunicationCreative(
  draft: CampaignDraft,
  creative: CommunicationCreative,
): CommunicationCreativeValidation {
  const gate = communicationGate(draft);
  const errors = gate.missing.length ? [`传播方案还缺：${gate.missing.join("、")}`] : [];
  const confirmedChannels = new Set(draft.brief.channels?.value ?? []);
  const outputChannels = creative.channelOutputs.map((output) => output.channel);
  const unconfirmedChannels = [...new Set(outputChannels
    .filter((channel) => !confirmedChannels.has(channel)))];
  if (unconfirmedChannels.length) errors.push(`不能为未确认渠道生成内容：${unconfirmedChannels.join("、")}`);
  const missingChannels = [...confirmedChannels].filter((channel) => !outputChannels.includes(channel));
  if (missingChannels.length) errors.push(`缺少已确认渠道的内容：${missingChannels.join("、")}`);
  const allowedNumbers = confirmedNumbers(draft);
  const inventedNumbers = [...new Set([...creativeText(creative).matchAll(/\d+(?:\.\d+)?/g)]
    .map((match) => match[0])
    .filter((number) => !allowedNumbers.has(number)))];
  if (inventedNumbers.length) errors.push(`这些数字不在已确认事实中：${inventedNumbers.join("、")}`);
  const rights = UNCONFIRMED_RIGHTS.filter((word) => creativeText(creative).includes(word));
  if (rights.length) errors.push(`不能使用事实层没有的权益或承诺：${rights.join("、")}`);
  const confirmedAudience = `${draft.brief.audience?.value ?? ""} ${draft.brief.audience?.quote ?? ""}`;
  const fullCreativeText = creativeText(creative);
  const inventedAudience = AUDIENCE_TERMS
    .filter((word) => fullCreativeText.includes(word) && !confirmedAudience.includes(word))
    .sort((left, right) => fullCreativeText.indexOf(left) - fullCreativeText.indexOf(right));
  if (inventedAudience.length) errors.push(`这些目标人群不在已确认 Brief 中：${inventedAudience.join("、")}`);
  const slogan = draft.ics1811?.facts.slogan?.value;
  if (slogan?.wanted && slogan.legalConfirmed !== true && slogan.text && fullCreativeText.includes(slogan.text)) {
    errors.push("活动标语尚未经法务确认，不能放入传播创意。");
  }
  return { ok: errors.length === 0, errors };
}

export function renderCommunicationPlan(draft: CampaignDraft): CommunicationPlan | null {
  const creative = draft.communication;
  if (!creative || !validateCommunicationCreative(draft, creative).ok) return null;
  const fill = draft.ics1811 ? deriveFill(draft.ics1811) : null;
  const slogan = draft.ics1811?.facts.slogan?.value;
  const reviewNotes = [
    "这是供运营继续修改的传播草稿，对外发布前仍需人工审核。",
    "发布前请人工复核渠道规格、品牌表达和活动事实。",
  ];
  if (slogan?.wanted && slogan.legalConfirmed !== true) {
    reviewNotes.push("活动标语尚未经法务确认，当前传播方案没有使用该标语。");
  }
  return {
    status: "needs_review",
    concept: structuredClone(creative.concept),
    channelOutputs: structuredClone(creative.channelOutputs),
    visualDirection: creative.visualDirection,
    facts: {
      name: draft.brief.name?.value ?? null,
      objective: draft.brief.objective?.value ?? "",
      audience: draft.brief.audience?.value ?? "",
      theme: draft.brief.theme?.value ?? "",
      channels: [...(draft.brief.channels?.value ?? [])],
      timing: draft.brief.timing?.value ?? null,
      scope: draft.brief.scope?.value ?? null,
      period: fill ? periodText(fill) : null,
      stores: fill ? storesText(fill) : null,
      offer: fill ? offerText(fill) : [],
      slogan: slogan?.wanted === true && slogan.legalConfirmed === true ? slogan.text : null,
    },
    reviewNotes,
  };
}
