import type { InterpretationResult } from "../server/ai-schemas.ts";
import {
  dateEvidenced,
  hasKeyword,
  KEYWORDS,
  mechanismEvidenced,
  numberAppearsInText,
  regionEvidenced,
  stripParenthetical,
  valuesEvidenced,
} from "./evidence.ts";
import { diffDrafts } from "./patcher.ts";
import {
  CATEGORY_OPTIONS,
  CHANNEL_OPTIONS,
  CUSTOMER_ACTION_OPTIONS,
  includesOption,
  LEVEL_OPTIONS,
  MARKET_OPTIONS,
  MECHANISM_OPTIONS,
  NON_NUMERIC_MECHANISMS,
  OCCASION_OPTIONS,
} from "./topics.ts";
import type { CampaignDraft, DraftVersion, FieldValue, IcsOrderDraft, OfferTier } from "./types.ts";

export type SavedVersionRecord = {
  seq: number;
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
  createdBy: "ai" | "human" | "rollback";
  createdAt: string;
};

export function rehydrateSessionVersions(records: SavedVersionRecord[]): DraftVersion[] {
  return records.map((record, index) => ({
    seq: record.seq,
    draft: structuredClone(record.draft),
    source: record.createdBy,
    reason: record.createdBy === "ai" ? "已保存的对话修改" : record.createdBy === "rollback" ? "已保存的版本恢复" : "已保存的初始版本",
    createdAt: record.createdAt,
    diffs: index === 0 ? [] : diffDrafts(records[index - 1].draft, record.draft),
  }));
}

// 草稿里的待界面选择条目只由代码按条件生成；模型提到的不确定项只进回读。
export const CODE_UNRESOLVED = {
  regionCode: "区域编码需在 1811 生产界面确认",
  divisionCode: "分区编码需在 1811 生产界面确认",
  offerDetails: "让利细节需在 ICS 界面填写",
} as const;

export const EXAMPLE_TEXT = "母亲节华东区线下黄金类满 3000 减 300";

export const EXAMPLE_INTERPRETATION: InterpretationResult = {
  summary: "华东母亲节黄金满减",
  fields: {
    occasion: "日历节点",
    reason: "母亲节",
    customerAction: "下单",
    audience: ["家庭赠礼客群"],
    productCategories: ["黄金类"],
    offerMechanism: "门槛型",
    thresholdAmount: 3000,
    amountOff: 300,
    scopeLevel: "区域",
    region: "华东区",
    markets: ["内地"],
    channels: ["线下"],
  },
  unresolved: [],
};

export const EXAMPLE_PREFILL = { concessionRate: 0.12, collectionRate: 0.98, source: "演示数据" };

const user = <T>(value: T): FieldValue<T> => ({ value, provenance: "user" });
const suggested = <T>(value: T): FieldValue<T> => ({ value, provenance: "pending", suggested: true });

export function createEmptyDraft(): CampaignDraft {
  return {
    id: crypto.randomUUID(),
    title: "未命名活动",
    brief: { externalName: "", icsName: "", content: "", slogan: "" },
    intent: {
      occasion: { value: "日历节点", provenance: "pending" },
      reason: "",
      customerAction: { value: "还没定", provenance: "pending" },
      derivedType: "待确认活动类型",
    },
    audience: {
      segments: { value: [], provenance: "pending" },
      membership: { value: "还没定", provenance: "pending" },
      membershipDescription: "",
    },
    products: {
      categories: { value: [], provenance: "pending" },
      series: "",
      narrowScope: false,
      productScope: { value: 0, provenance: "default" },
      outletTagConversion: false,
      assignedItemMode: false,
      assignedItems: [],
    },
    offer: {
      mechanism: { value: "还没定", provenance: "pending" },
      offerType: null,
      tiers: [],
      responsibility: "",
      stacking: { value: "还没定", provenance: "pending" },
      couponAllowed: null,
      tradeInUpgradeRatio: null,
    },
    scope: {
      level: { value: "区域", provenance: "pending" },
      regionCode: "",
      divisionCode: "",
      rowCode: "",
      stores: [],
      markets: { value: [], provenance: "pending" },
      channels: { value: [], provenance: "pending" },
    },
    schedule: {
      batches: [{ id: "batch-1", label: "主档期", startDate: "", endDate: "" }],
      lunarGregorianDate: null,
      cycleWeekdays: { value: [0], provenance: "default" },
      longTermSplit: null,
    },
    metric: { name: "", target: null },
    operations: {
      brandLine: { value: "", provenance: "pending" },
      concessionRate: { value: null, provenance: "pending" },
      collectionRate: { value: null, provenance: "pending" },
      paymentRestricted: { value: false, provenance: "pending" },
      activityGroup: null,
    },
    unresolved: [],
  };
}

function formatDiscount(rate: number): string {
  return String(Number((rate * 10).toFixed(2)));
}

export function tierLabel(mechanism: string, tier: Pick<OfferTier, "thresholdAmount" | "discountRate" | "amountOff">): string {
  if (NON_NUMERIC_MECHANISMS.includes(mechanism)) return `${mechanism}（细节需在 ICS 界面填写）`;
  const discount = tier.discountRate !== null ? `${formatDiscount(tier.discountRate)} 折` : null;
  if (mechanism === "门槛型" && tier.thresholdAmount !== null) {
    if (tier.amountOff !== null) return `满 ${tier.thresholdAmount} 减 ${tier.amountOff}`;
    if (discount) return `满 ${tier.thresholdAmount} 打 ${discount}`;
  }
  if (tier.amountOff !== null) return `减 ${tier.amountOff} 元`;
  if (discount) return discount;
  return "待补优惠档位";
}

// 每个回合应用修改后执行：维护派生字段与机制之间的联动。只看取值与来源，不看上一版本，撤销和恢复不会被改写。
export function deriveDraft(input: CampaignDraft): CampaignDraft {
  const draft = structuredClone(input) as CampaignDraft;
  const offer = draft.offer;
  const action = draft.intent.customerAction;

  if (action.value === "只看到" && action.provenance !== "pending") {
    offer.mechanism = { value: "无让利", provenance: "default" };
    offer.stacking = { value: "还没定", provenance: "default" };
    offer.tiers = [];
  } else if (offer.mechanism.value === "无让利" && offer.mechanism.provenance === "default") {
    offer.mechanism = { value: "还没定", provenance: "pending" };
    offer.stacking = { value: "还没定", provenance: "pending" };
    offer.tiers = [];
  }

  const mechanism = offer.mechanism.value;
  if (mechanism === "无让利") offer.tiers = [];
  if (NON_NUMERIC_MECHANISMS.includes(mechanism)) {
    offer.tiers = [{
      id: offer.tiers[0]?.id || "tier-1",
      label: "",
      thresholdAmount: null,
      thresholdCount: null,
      judgingWeight: null,
      discountRate: null,
      amountOff: null,
    }];
  }
  offer.tiers = offer.tiers.map((tier, index) => ({ ...tier, id: tier.id || `tier-${index + 1}`, label: tierLabel(mechanism, tier) }));
  offer.couponAllowed = offer.stacking.value === "否" ? false : offer.stacking.value === "是" ? true : null;

  draft.intent.derivedType = action.value === "只看到"
    ? "品牌展示，不含成交优惠"
    : `${draft.intent.occasion.provenance === "pending" ? "由头待定" : draft.intent.occasion.value} × ${mechanism === "还没定" ? "让利待定" : mechanism}`;
  draft.operations.activityGroup = mechanism === "以旧换新换购" ? "增值服务" : mechanism === "还没定" || mechanism === "无让利" ? null : "门槛优惠";

  const level = draft.scope.level;
  const unresolved: string[] = [];
  if (level.provenance !== "pending" && level.value === "区域") unresolved.push(CODE_UNRESOLVED.regionCode);
  if (level.provenance !== "pending" && level.value === "分区") unresolved.push(CODE_UNRESOLVED.divisionCode);
  if (NON_NUMERIC_MECHANISMS.includes(mechanism)) unresolved.push(CODE_UNRESOLVED.offerDetails);
  draft.unresolved = unresolved;

  return draft;
}

const DEMOGRAPHIC_SEGMENT = /岁|男性|女性/;

export function mergeInterpretation(userText: string, interpretation: InterpretationResult): CampaignDraft {
  const text = userText;
  const fields = interpretation.fields;
  const draft = createEmptyDraft();
  draft.title = (interpretation.summary || text).slice(0, 28);

  if (includesOption(OCCASION_OPTIONS, fields.occasion)) draft.intent.occasion = { value: fields.occasion, provenance: "ai" };
  if (fields.reason) draft.intent.reason = fields.reason;

  if (includesOption(MECHANISM_OPTIONS, fields.offerMechanism)) {
    const mechanism = fields.offerMechanism;
    draft.offer.mechanism = mechanismEvidenced(mechanism, text) ? user(mechanism) : suggested(mechanism);
    const explicit = (value: number | undefined, scaled = false) => (typeof value === "number" && numberAppearsInText(value, text, scaled) ? value : null);
    const tier = {
      thresholdAmount: explicit(fields.thresholdAmount),
      discountRate: explicit(fields.discountRate, true),
      amountOff: explicit(fields.amountOff),
    };
    if ((mechanism === "门槛型" || mechanism === "直接价格") && Object.values(tier).some((value) => value !== null)) {
      draft.offer.tiers = [{ id: "tier-1", label: "", thresholdCount: null, judgingWeight: null, ...tier }];
    }
  }

  if (includesOption(CUSTOMER_ACTION_OPTIONS, fields.customerAction)) {
    const action = fields.customerAction;
    const mechanism = draft.offer.mechanism;
    const impliedByOffer = mechanism.provenance === "user" && (
      (action === "下单" && (mechanism.value === "门槛型" || mechanism.value === "直接价格")) ||
      (action === "带旧货来换" && mechanism.value === "以旧换新换购")
    );
    draft.intent.customerAction = impliedByOffer || text.includes(action) ? user(action) : suggested(action);
  }

  const segments = (fields.audience ?? []).filter((item) => typeof item === "string" && item.trim() && !DEMOGRAPHIC_SEGMENT.test(item));
  if (segments.length) draft.audience.segments = { value: segments.slice(0, 6), provenance: "ai" };

  const categories = (fields.productCategories ?? []).filter((item) => includesOption(CATEGORY_OPTIONS, item));
  if (categories.length) draft.products.categories = valuesEvidenced(categories, text) ? user(categories) : suggested(categories);
  const markets = (fields.markets ?? []).filter((item) => includesOption(MARKET_OPTIONS, item));
  if (markets.length) draft.scope.markets = valuesEvidenced(markets, text) ? user(markets) : suggested(markets);
  const channels = (fields.channels ?? []).filter((item): item is "线上" | "线下" => includesOption(CHANNEL_OPTIONS, item));
  if (channels.length) draft.scope.channels = valuesEvidenced(channels, text) ? user(channels) : suggested(channels);

  const level = includesOption(LEVEL_OPTIONS, fields.scopeLevel)
    ? fields.scopeLevel
    : fields.region ? "区域" : fields.divisionText ? "分区" : fields.stores?.length ? "指定门店" : null;
  if (level) {
    const region = fields.region ? stripParenthetical(fields.region) : "";
    const division = fields.divisionText ? stripParenthetical(fields.divisionText) : "";
    const stores = (fields.stores ?? []).filter((store) => store && typeof store.code === "string" && /^[A-Za-z0-9-]+$/.test(store.code) && typeof store.name === "string");
    let evidenced = false;
    if (level === "全国") evidenced = text.includes("全国");
    if (level === "电商平台") evidenced = /电商|天猫|京东/.test(text);
    if (level === "区域" && region && regionEvidenced(region, text)) {
      evidenced = true;
      draft.scope.regionCode = `${region}（请在生产界面选择）`;
    }
    if (level === "分区" && division && text.includes("分区") && regionEvidenced(division, text)) {
      evidenced = true;
      draft.scope.divisionCode = `${division}（请在生产界面选择）`;
    }
    if (level === "指定门店" && stores.length && stores.every((store) => text.includes(store.code))) {
      evidenced = true;
      draft.scope.stores = stores;
    }
    draft.scope.level = evidenced ? user(level) : suggested(level);
  }

  if ((fields.stacking === "是" || fields.stacking === "否") && hasKeyword(text, KEYWORDS.stacking)) {
    draft.offer.stacking = user(fields.stacking);
  }
  if ((fields.membership === "不限" || fields.membership === "限") && hasKeyword(text, KEYWORDS.membership)) {
    draft.audience.membership = user(fields.membership);
    if (fields.membership === "限" && fields.membershipDescription) draft.audience.membershipDescription = fields.membershipDescription;
  }
  if (typeof fields.concessionRate === "number" && hasKeyword(text, KEYWORDS.concessionRate) && numberAppearsInText(fields.concessionRate, text, true)) {
    draft.operations.concessionRate = user(fields.concessionRate);
  }
  if (typeof fields.collectionRate === "number" && hasKeyword(text, KEYWORDS.collectionRate) && numberAppearsInText(fields.collectionRate, text, true)) {
    draft.operations.collectionRate = user(fields.collectionRate);
  }
  if (typeof fields.paymentRestricted === "boolean" && hasKeyword(text, KEYWORDS.paymentRestricted)) {
    draft.operations.paymentRestricted = user(fields.paymentRestricted);
  }

  const batch = draft.schedule.batches[0];
  if (fields.startDate && dateEvidenced(fields.startDate, text)) batch.startDate = fields.startDate;
  if (fields.endDate && dateEvidenced(fields.endDate, text)) batch.endDate = fields.endDate;

  return deriveDraft(draft);
}
