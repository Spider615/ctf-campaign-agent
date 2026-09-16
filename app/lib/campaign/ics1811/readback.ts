// 白话摘要（设计文档 8.1 节）：代码模板生成，句子顺序照 SOP 第九部分的复述示例。模型不写。
// 不再有「复述 → 确认」这一步：活动建好时，填写值消息带上 summary 和 essentials，说清这次建了什么。

import { discountText } from "./derive.ts";
import { rateText, ratioText } from "./messages.ts";
import { QUESTION_EXAMPLE } from "./questions.ts";
import type { Check, Detail, FillModel, Gap, Ics1811Draft } from "./types.ts";

export type Readback = {
  // 一句话结论：名称、日期、门店。
  // 注意：旧会话的复述存在 D1 里，没有这个字段，界面要容忍它缺失。
  summary: string;
  // 这个活动的要点：名称和内容、日期、门店、每条明细、结算、标语。
  essentials: string[];
  // 按页面默认、不影响判断的句子，默认收起。
  defaults: string[];
  paragraph: string;
  attention: Array<{ id: string; text: string; dismissible: boolean }>;
  blockers: string[];
  missing: string[];
  canConfirm: boolean;
};

const stripCode = (display: string | null) => (display ? display.replace(/^\d+[) ]/, "") : "");
const dateText = (iso: string | null) => (iso ? `${Number(iso.slice(0, 4))} 年 ${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日` : "待补");
const WEEKDAY_NAME = ["", "一", "二", "三", "四", "五", "六", "日"];

function calculation(detail: Detail): string {
  const param = (key: string) => detail.params.find((item) => item.key === key)?.value.value ?? null;
  const cats = detail.categories.value.length ? detail.categories.value.join("、") : "货类待补";
  const lacks = detail.params.some((item) => item.value.value === null) ? "，力度待补" : "";
  const discount = param("discount") ?? param("billingDiscount");
  const amount = param("offerAmount");
  const judge = param("judgeAmount");
  switch (detail.offerType.value) {
    case null:
      if (detail.mode.value === "浮动折扣模式") return `${cats}折扣 ${discount ?? "待补"}${discount !== null ? `（${discountText(discount)} 折）` : ""}，门店可以在这个基础上改价`;
      return `${cats}，计算方式待定${lacks}`;
    case "金价每克减免":
      return `${cats}按实际克重每克减 ${amount ?? "待补"} 元（不是按整克计算的「金价每整克减免」）`;
    case "金价每整克减免":
      return `${cats}按单件重量的整数克每克减 ${amount ?? "待补"} 元`;
    case "满减":
      return judge !== null && amount !== null ? `${cats}满 ${judge} 减 ${amount}，满 ${judge * 2} 仍减 ${amount}` : `${cats}满减${lacks}`;
    case "每满减":
      return judge !== null && amount !== null ? `${cats}每满 ${judge} 减 ${amount}，满 ${judge * 2} 减 ${amount * 2}` : `${cats}每满减${lacks}`;
    case "售价固定折扣":
      return `${cats}${discount !== null ? `${discountText(discount)} 折（开单折扣 ${discount}）` : "折扣待补"}，门店不能改价`;
    case "铂金换购特殊营销折扣":
      return `铂金以旧换新，换大 ${judge ?? "待补"} 倍（判断金额填 ${judge ?? "待补"}），开单折扣 ${discount ?? "待补"}，货类选「不适用」、货类明细选 HP`;
    case "钻石以小换大":
      return `开单折扣 ${discount ?? "待补"}，货类选「不适用」、货类明细选 HA`;
    case "黄金以旧换新":
      return `${cats}${param("upgradeRatio") !== null ? `换大 ${ratioText(param("upgradeRatio") as number)}（换大比例填 ${param("upgradeRatio")}）` : "换大比例待补"}，${discount === 0 ? "免工费（开单折扣填 0）" : discount !== null ? `工费 ${discountText(discount)} 折（开单折扣 ${discount}）` : "工费折扣待补"}`;
    case "买钻石享黄金克减":
      return `${cats}${discount === 1 ? "钻石不打折（开单折扣填 1）" : discount !== null ? `钻石开单折扣 ${discount}` : "钻石折扣待补"}`;
    default:
      return `${cats}${lacks}`;
  }
}

function detailSentence(detail: Detail): string {
  const head = detail.mode.value === "浮动折扣模式" ? "浮动折扣模式" : `${detail.mode.value ?? "折扣模式待定"}，优惠类型「${detail.offerType.value ?? "待定"}」`;
  const business = detail.businessCategory.value ? `，业务大类填${detail.businessCategory.value}` : "";
  return `${head}：${calculation(detail)}${business}`;
}

export function buildReadback(draft: Ics1811Draft, fill: FillModel, checks: readonly Check[], missing: readonly Gap[]): Readback {
  const { info, details } = fill;
  const f = draft.facts;
  const parts: string[] = [];
  // 按默认走、不影响判断的句子进这里，界面上默认收起。
  const defaults: string[] = [];

  // 名称和内容是模型唯一的自由发挥区，标明是谁写的，用户一眼能看出哪段不是自己说的。
  // 用（）不用「」：界面和测试都按「」切分内容。模板态和模型态的 source 都是 ai，只能靠 draft.copy 在不在来区分。
  const copyBy = !draft.copy ? "（按模板生成）" : draft.copy.source === "ai" ? "（模型起草）" : "";
  parts.push(`活动名称「${info.name.value}」，活动内容「${info.content.value}」${copyBy}`);
  defaults.push(`品牌${info.brand.value ?? "待指定"}${info.brand.source === "default" ? "（页面默认）" : ""}，审批流${info.approvalFlow.value ? `选「${info.approvalFlow.value}」` : "不选（涉及多个品牌，由系统取最高审批等级）"}`);
  defaults.push(`${stripCode(info.channel.value)}，活动级优惠类型为${stripCode(info.offerNature.value)}`);
  const cycle = info.cycle.value === "0" ? "每天生效（周期填 0）" : `每周${info.cycle.value.split(",").map((day) => WEEKDAY_NAME[Number(day)]).join("、")}生效（周期填 ${info.cycle.value}）`;
  const { value: start } = info.startDate;
  const { value: end } = info.endDate;
  const dates = start && end ? `${dateText(start)}至 ${start.slice(0, 4) === end.slice(0, 4) ? dateText(end).replace(/^\d+ 年 /, "") : dateText(end)}` : "日期待补";
  parts.push(`${dates}（结束当天有效），${cycle}`);
  parts.push(info.branches.value.length ? `${stripCode(info.region.value)} ${info.branches.value.join("、")} 门店（分区、小区、城市不选）` : "门店待补");
  details.forEach((detail) => parts.push(`${details.length > 1 ? `第 ${detail.index} 条明细` : ""}${detailSentence(detail)}`));
  if (!details.length) parts.push("优惠方式待补");

  const menu = info.menuConversion.value ? `，转换餐牌选${stripCode(info.menuConversion.value)}` : "，转换餐牌待补";
  const heads = [...new Set(details.flatMap((detail) => detail.headCodes.value))];
  const members = [...new Set(details.flatMap((detail) => detail.memberLevels.value))];
  const prices = [...new Set(details.flatMap((detail) => detail.priceTypes?.value ?? []))];
  // 浮动模式页面没有售价类型栏：用户限定过就明说录不进去，不能说成「不限」（§9(三)）。
  const floatOnly = details.length > 0 && details.every((detail) => detail.priceTypes === null);
  const floatNote = floatOnly ? (f.priceTypes ? `浮动折扣模式没有售价类型栏，「${f.priceTypes.value.join("、")}」这条限定录不进去` : "浮动折扣模式没有售价类型栏") : "";
  const limits = [heads.length ? `号头限 ${heads.join("、")}` : "", members.length ? `会员级别限 ${members.join("、")}` : "", prices.length ? `售价类型限 ${prices.join("、")}` : "", floatNote].filter(Boolean);
  const unlimited = [heads.length ? "" : "号头", members.length ? "" : "会员级别", prices.length || floatOnly ? "" : "售价类型"].filter(Boolean);
  const restrictionRows = details.flatMap((detail) => detail.restrictions.map((item) => `${item.label}填 ${item.value.value}`));
  defaults.push([
    `货品范围为${stripCode(info.productScope.value)}${menu}`,
    [...limits, unlimited.length ? `不限${unlimited.join("、")}` : ""].filter(Boolean).join("，"),
    restrictionRows.length ? `限制条件：${[...new Set(restrictionRows)].join("、")}，其余不限` : "不排除任何商品，没有整单或单件的金额、件数、克重限制",
  ].join("，"));

  const payments = info.paymentMethods.basis.startsWith("默认") ? "付款方式按默认（含 GLP 积分抵现）" : `付款方式：${info.paymentMethods.value.join("、")}`;
  defaults.push(payments);

  const rates = f.rates ? (f.rates.value.concession === 0 && f.rates.value.collection === 0 ? "没有让扣点和回款率" : `让扣点 ${rateText(f.rates.value.concession)}、回款率 ${rateText(f.rates.value.collection)}`) : "让扣点和回款率待补";
  const commission = info.commission.value === "不计算折上折" ? "销售提成按实际售价计算" : info.commission.value === "计算折上折" ? "销售提成按实际售价 × 折扣计算（计算折上折）" : "提成口径待补";
  parts.push(`${rates}，${commission}`);

  const slogan = f.slogan?.value;
  parts.push(!slogan ? "活动标语待补" : !slogan.wanted ? "不加活动标语" : slogan.legalConfirmed === true ? `活动标语「${slogan.text}」（法务已确认）` : slogan.legalConfirmed === false ? "标语法务还没确认，这次不加" : "标语待确认法务是否审过");

  if (fill.settlement) {
    const has = fill.settlement.has.value;
    parts.push(has === true ? `结算说明函 ${fill.settlement.fileNames.length} 份，文件名建议：${fill.settlement.fileNames.join("、")}` : has === false ? "没有结算说明函" : "结算说明函待补");
  }
  defaults.push(fill.activityGroup.value.startsWith("3)") ? `活动分组保持默认「${fill.activityGroup.value}」` : `活动分组建完后在 ICS-1815 改为「${fill.activityGroup.value}」`);
  defaults.push("是否参与打折、预售时间、是否凭券使用按默认值");

  const blockers = checks.filter((check) => check.severity === "blocker");
  const attention = [
    ...fill.notes.map((note) => ({ id: note.id, text: note.text, dismissible: note.kind === "restriction_unresolved" })),
    ...checks.filter((check) => check.severity === "warning" && !check.id.startsWith("note:")).map((check) => ({ id: check.id, text: check.message, dismissible: false })),
    ...Object.values(info).filter((item) => item.tbc).map((item) => ({ id: `tbc:${item.tbc}`, text: item.tbc as string, dismissible: false })),
  ];
  const canConfirm = missing.length === 0 && blockers.length === 0;
  // 结论只放最能认出是哪个活动的三项：名称、日期、门店。优惠和明细在要点里。
  const shortDate = start && end
    ? `${Number(start.slice(5, 7))}月${Number(start.slice(8, 10))}日–${Number(end.slice(5, 7))}月${Number(end.slice(8, 10))}日`
    : "日期待补";
  const branches = info.branches.value;
  const shortStores = !branches.length
    ? "门店待补"
    : branches.length > 2 ? `${branches[0]} 等 ${branches.length} 家门店` : `${branches.join("、")} 门店`;
  const summary = `「${info.name.value}」 · ${shortDate} · ${shortStores}`;
  return {
    summary,
    essentials: parts,
    defaults,
    // 整段仍然保留：复制用，旧会话也还在读它。
    paragraph: `${[...parts, ...defaults].join("；")}。`,
    attention: attention.filter((item, index) => attention.findIndex((other) => other.id === item.id) === index),
    blockers: blockers.filter((check) => !check.id.startsWith("V-A08")).map((check) => check.message),
    // 缺项带上能照抄的回答示例。
    missing: missing.map((gap) => (QUESTION_EXAMPLE[gap.id] ? `${gap.title}（直接打字回答，比如「${QUESTION_EXAMPLE[gap.id]}」）` : gap.title)),
    canConfirm,
  };
}
