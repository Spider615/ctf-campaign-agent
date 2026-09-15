import type { CampaignDraft, FieldValue, Provenance } from "./types.ts";

const field = <T>(
  value: T,
  provenance: Provenance,
  vintage?: { year: number; sourceImage: string; completeness?: "complete" | "truncated" | "conflicted" },
): FieldValue<T> => ({ value, provenance, ...(vintage ? { vintage } : {}) });

export function createMotherDaySeed(): CampaignDraft {
  return {
    id: "demo-mothers-day",
    title: "华东母亲节金饰礼遇",
    brief: {
      externalName: "她的光芒·母亲节金礼",
      icsName: "母亲节金礼",
      content: "母亲节期间，华东指定门店黄金类商品满 3000 元减 300 元。",
      slogan: "把爱戴在身边",
    },
    intent: {
      occasion: field("日历节点", "user"),
      reason: "母亲节送礼窗口",
      customerAction: field("下单", "user"),
      derivedType: "节点情感 × 门槛让利",
    },
    audience: {
      segments: field(["为母亲选礼的人", "家庭赠礼客群"], "ai"),
      membership: field("不限", "user"),
      membershipDescription: "",
    },
    products: {
      categories: field(["黄金类"], "user"),
      series: "母亲节主题金饰",
      narrowScope: false,
      productScope: field(0, "default", { year: 2021, sourceImage: "PPT-2021-货品范围", completeness: "complete" }),
      outletTagConversion: false,
      assignedItemMode: false,
      assignedItems: [],
    },
    offer: {
      mechanism: field("门槛型", "user"),
      offerType: 17,
      tiers: [
        {
          id: "tier-1",
          label: "满 3000 减 300",
          thresholdAmount: 3000,
          thresholdCount: null,
          judgingWeight: null,
          discountRate: 0.8,
          amountOff: null,
        },
      ],
      responsibility: "公司全担",
      stacking: field("否", "user"),
      couponAllowed: false,
      tradeInUpgradeRatio: null,
    },
    scope: {
      level: field("区域", "user"),
      regionCode: "华东区（请在生产界面选择）",
      divisionCode: "",
      rowCode: "",
      stores: [],
      markets: field(["内地"], "user"),
      channels: field(["线下"], "default", { year: 2021, sourceImage: "PPT-2021-线上线下", completeness: "complete" }),
    },
    schedule: {
      batches: [
        { id: "batch-1", label: "母亲节主档", startDate: "2026-05-04", endDate: "2026-05-10" },
      ],
      lunarGregorianDate: null,
      cycleWeekdays: field([0], "default", { year: 2021, sourceImage: "PPT-2021-周期", completeness: "complete" }),
      longTermSplit: null,
    },
    metric: { name: "活动期成交订单数", target: null },
    operations: {
      brandLine: field("周大福主品牌（观测值）", "user", { year: 2025, sourceImage: "PPT-2025-品牌线", completeness: "truncated" }),
      concessionRate: field(0.12, "user"),
      collectionRate: field(0.98, "user"),
      paymentRestricted: field(false, "user"),
      activityGroup: "门槛优惠",
    },
    unresolved: ["区域编码需在 1811 生产界面确认", "活动标语需法务确认"],
  };
}

export function createVisibilityOnlySeed(): CampaignDraft {
  const draft = createMotherDaySeed();
  draft.id = "demo-brand-visibility";
  draft.title = "传承系列品牌展览";
  draft.brief = {
    externalName: "传承之光城市展",
    icsName: "传承城市展",
    content: "以线下主题展览呈现传承系列工艺与故事。",
    slogan: "看见时间的手艺",
  };
  draft.intent.occasion = field("线下场", "user");
  draft.intent.reason = "城市主题展览";
  draft.intent.customerAction = field("只看到", "user");
  draft.intent.derivedType = "品牌展示，不含成交优惠";
  draft.offer.mechanism = field("无让利", "default");
  draft.offer.offerType = null;
  draft.offer.tiers = [];
  draft.unresolved = ["展览报名与到场数据应由 CRM 或活动系统承接"];
  return draft;
}

