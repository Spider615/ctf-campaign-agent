// 对外宣传文案：在 1811 内部填写值之外，另出一份给运营拿去改的对外草稿。
//
// 分工和活动名称/内容一致——模型只供给创意（主标题和卖点，见 tools.ts 的
// draft_promo_copy），活动时间、门店、优惠力度一律由这里从事实层渲染。
// 原因：数字有 allowedNumbers 守卫拦着，但「闽深区」写成「华南区」、门店编号
// 张冠李戴，守卫拦不住，而这些一旦对外发出去就是事故。
//
// 两条对外的红线写死在这里，不靠谁记得：
// 1. 内部代码不出门——门店写店名不写编号，区域去掉「214)」这类前缀；
// 2. 活动标语只有在用户给了原文且法务确认过时才出现（§9(三)），模型不写标语。

import { discountText } from "./derive.ts";
import { storeByCode } from "./codebook.ts";
import type { FillModel, Ics1811Draft } from "./types.ts";

export type PromoDoc = {
  headline: string;
  highlights: string[];
  slogan: string | null;
  period: string;
  stores: string;
  offer: string[];
  notes: string[];
};

const WEEKDAY_NAME = ["", "一", "二", "三", "四", "五", "六", "日"];
const dateText = (iso: string | null) => (iso ? `${Number(iso.slice(0, 4))} 年 ${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日` : "");

// 对消费者只说店名。fill.info.branches 里是门店编号，codebook 换成简称。
function storeText(fill: FillModel): string {
  const names = fill.info.branches.value.map((code) => storeByCode(code)?.shortName ?? code);
  if (!names.length) return "";
  // 中文说「东门鸿展店」，不说「东门鸿展门店」。
  if (names.length > 3) return `${names.slice(0, 3).map((name) => `${name}店`).join("、")}等 ${names.length} 家门店`;
  return names.map((name) => `${name}店`).join("、");
}

function periodText(fill: FillModel): string {
  const start = fill.info.startDate.value;
  const end = fill.info.endDate.value;
  if (!start || !end) return "";
  // 同一年不把年份写两遍：「2027 年 5 月 1 日至 5 月 5 日」。
  const endText = start.slice(0, 4) === end.slice(0, 4) ? dateText(end).replace(/^\d+ 年 /, "") : dateText(end);
  const cycle = fill.info.cycle.value;
  const weekly = cycle && cycle !== "0"
    ? `，每周${cycle.split(",").map((day) => WEEKDAY_NAME[Number(day)]).join("、")}`
    : "";
  return `${dateText(start)}至 ${endText}${weekly}`;
}

// 面向消费者的优惠说明。不复用 readback 的措辞：那是给运营核对填写值用的，
// 带着「不是按整克计算的『金价每整克减免』」这类内部提示，对外不能出现。
function offerLines(fill: FillModel): string[] {
  return fill.details
    .map((detail) => {
      const param = (key: string) => detail.params.find((item) => item.key === key)?.value.value ?? null;
      const cats = detail.categories.value.join("、");
      if (!cats) return "";
      const amount = param("offerAmount");
      const judge = param("judgeAmount");
      const discount = param("discount") ?? param("billingDiscount");
      switch (detail.offerType.value) {
        case "金价每克减免":
        case "金价每整克减免":
          return amount === null ? "" : `${cats}每克立减 ${amount} 元`;
        case "满减":
          return judge === null || amount === null ? "" : `${cats}满 ${judge} 元减 ${amount} 元`;
        case "每满减":
          return judge === null || amount === null ? "" : `${cats}每满 ${judge} 元减 ${amount} 元`;
        case "售价固定折扣":
          return discount === null ? "" : `${cats} ${discountText(discount)} 折`;
        case "黄金以旧换新":
          return `${cats}以旧换新`;
        default:
          return `${cats}参与本次活动`;
      }
    })
    .filter(Boolean);
}

export function renderPromo(draft: Ics1811Draft, fill: FillModel): PromoDoc | null {
  const promo = draft.promo ?? null;
  // 只有事实、没有主张的文案不是文案，不如不出。
  if (!promo) return null;

  const slogan = draft.facts.slogan?.value;
  // §9(三)：标语只能照抄用户给的、法务确认过的原文，其余一律不出。
  const sloganText = slogan?.wanted && slogan.legalConfirmed === true && slogan.text ? slogan.text : null;

  const notes = ["本文案由系统按已确认的活动信息生成，对外发布前请走法务确认。"];
  if (slogan?.wanted && slogan.legalConfirmed !== true) {
    notes.push("活动标语尚未经法务确认，这份草稿里没有放标语。");
  }
  const period = periodText(fill);
  if (period) notes.push("活动以门店实际公示为准，最终解释权以门店告示为准。");

  return {
    headline: promo.headline,
    highlights: [...promo.highlights],
    slogan: sloganText,
    period,
    stores: storeText(fill),
    offer: offerLines(fill),
    notes,
  };
}
