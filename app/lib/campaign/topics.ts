import type { CampaignDraft, FieldValue } from "./types.ts";

export type TopicId = "action" | "offer" | "scope" | "schedule" | "audience_products" | "operations" | "brief";

export type FieldKey =
  | "customerAction"
  | "occasion"
  | "mechanism"
  | "tier"
  | "stacking"
  | "level"
  | "scopeCode"
  | "markets"
  | "channels"
  | "dates"
  | "segments"
  | "categories"
  | "membership"
  | "rates"
  | "paymentRestricted";

export const ASKED_TOPICS: TopicId[] = ["action", "offer", "scope", "schedule", "audience_products", "operations"];

export const TOPIC_TITLE: Record<TopicId, string> = {
  action: "先确认顾客动作和由头",
  offer: "让利怎么设？",
  scope: "活动做在哪些范围？",
  schedule: "活动哪天开始、哪天结束？",
  audience_products: "打哪类人、卖哪些货？",
  operations: "还差几个只有你知道的数",
  brief: "文案与标题",
};

export const TYPING_HINT: Record<TopicId, string> = {
  action: "也可以直接打字，例如：顾客下单才算",
  offer: "也可以直接打字，例如：满 3000 减 300，不和券叠加",
  scope: "也可以直接打字，例如：华东区线下，内地",
  schedule: "也可以直接打字，例如：5 月 4 日到 5 月 10 日",
  audience_products: "也可以直接打字，例如：给家人买礼物的人，黄金类，不限会员",
  operations: "也可以直接打字，例如：让扣点 0.12，回款率 0.98，支付方式不限",
  brief: "想改哪里直接说，例如：活动名克制一点",
};

export const FIELD_TOPIC: Record<FieldKey, TopicId> = {
  customerAction: "action",
  occasion: "action",
  mechanism: "offer",
  tier: "offer",
  stacking: "offer",
  level: "scope",
  scopeCode: "scope",
  markets: "scope",
  channels: "scope",
  dates: "schedule",
  segments: "audience_products",
  categories: "audience_products",
  membership: "audience_products",
  rates: "operations",
  paymentRestricted: "operations",
};

export const FIELD_LABEL: Record<FieldKey, string> = {
  customerAction: "顾客动作",
  occasion: "由头类型",
  mechanism: "让利机制",
  tier: "优惠力度",
  stacking: "能否叠加",
  level: "范围层级",
  scopeCode: "具体范围",
  markets: "覆盖市场",
  channels: "渠道",
  dates: "起止日期",
  segments: "人群",
  categories: "业务大类",
  membership: "会员限制",
  rates: "让扣点与回款率",
  paymentRestricted: "支付方式限制",
};

export const FIELD_QUESTION: Record<FieldKey, string> = {
  customerAction: "顾客做到哪一步，这个活动才算数？",
  occasion: "这次活动的由头属于哪一类？",
  mechanism: "这次拿什么让利？",
  tier: "优惠力度是多少？",
  stacking: "这个优惠能和其他折扣、券叠加吗？",
  level: "活动做在哪个范围？",
  scopeCode: "具体是哪个区域、分区或哪些门店？",
  markets: "覆盖哪些市场？",
  channels: "做线上还是线下？",
  dates: "活动哪天开始、哪天结束？",
  segments: "主要打哪类人？",
  categories: "卖哪些货？",
  membership: "限不限会员？",
  rates: "这次的让扣点和回款率是多少？",
  paymentRestricted: "支付方式有没有限制？",
};

export const FIELD_WHY: Record<FieldKey, string> = {
  customerAction: "决定要不要在 ICS 开单：只到「看到」就不开单。",
  occasion: "决定方案的叙事和文案口径。",
  mechanism: "决定 ICS 里建哪类优惠规则。",
  tier: "优惠数字只用你给的，我不猜。",
  stacking: "决定 ICS 里是否计算折上折、能否用券。",
  level: "范围层级决定 ICS 里选哪一级。",
  scopeCode: "每个范围单元单独开单。",
  markets: "每个市场单独开单。",
  channels: "线上、线下在 ICS 里是两条单。",
  dates: "ICS 不接受没有结束日期的活动。",
  segments: "按场合、关系、身份描述，不按年龄性别猜。",
  categories: "决定 ICS 里选哪些货类。",
  membership: "限会员时要在 ICS 界面勾选会员级别。",
  rates: "门店合约参数，AI 推不出来；0 也合法，但要你明确给。",
  paymentRestricted: "有限制时要在 ICS 界面勾选支付方式。",
};

export const CUSTOMER_ACTION_OPTIONS = ["只看到", "参与互动", "到场", "留资", "下单", "带旧货来换"] as const;
export const OCCASION_OPTIONS = ["日历节点", "品牌节点", "外部节点", "线下场", "门店日常经营", "私域日常运营"] as const;
export const MECHANISM_OPTIONS = ["无让利", "以旧换新换购", "门槛型", "直接价格", "赠品兑换", "券核销"] as const;
export const NON_NUMERIC_MECHANISMS: readonly string[] = ["以旧换新换购", "赠品兑换", "券核销"];
export const LEVEL_OPTIONS = ["全国", "区域", "分区", "指定门店", "电商平台"] as const;
export const MARKET_OPTIONS = ["内地", "港澳"] as const;
export const CHANNEL_OPTIONS = ["线下", "线上"] as const;
export const SEGMENT_OPTIONS = ["家庭赠礼客群", "婚嫁客群", "悦己自购客群", "存量会员", "到店游客"] as const;
export const CATEGORY_OPTIONS = ["镶嵌类", "素金类", "黄金类", "赠品"] as const;

export function includesOption<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

// 推断出来、还没确认的「只看到」「无让利」不算数。
export function noIcsOrders(draft: CampaignDraft): boolean {
  const action = draft.intent.customerAction;
  const mechanism = draft.offer.mechanism;
  return (action.value === "只看到" && action.provenance !== "pending") || (mechanism.value === "无让利" && mechanism.provenance !== "pending");
}

const undecided = (field: FieldValue<string>) => field.provenance === "pending" || field.value === "还没定";

export function missingFields(draft: CampaignDraft): FieldKey[] {
  const missing: FieldKey[] = [];
  const onlySee = draft.intent.customerAction.value === "只看到" && draft.intent.customerAction.provenance !== "pending";
  const noIcs = noIcsOrders(draft);

  if (undecided(draft.intent.customerAction)) missing.push("customerAction");
  if (draft.intent.occasion.provenance === "pending") missing.push("occasion");

  if (!onlySee) {
    const mechanism = draft.offer.mechanism;
    const tier = draft.offer.tiers[0];
    if (undecided(mechanism)) missing.push("mechanism");
    if (mechanism.value === "门槛型" && (!tier || tier.thresholdAmount === null || (tier.discountRate === null && tier.amountOff === null))) {
      missing.push("tier");
    }
    if (mechanism.value === "直接价格" && (!tier || (tier.discountRate === null && tier.amountOff === null))) {
      missing.push("tier");
    }
    if (mechanism.value !== "无让利" && undecided(draft.offer.stacking)) missing.push("stacking");
  }

  const scope = draft.scope;
  if (scope.level.provenance === "pending") {
    missing.push("level");
  } else if (
    (scope.level.value === "区域" && !scope.regionCode.trim()) ||
    (scope.level.value === "分区" && !scope.divisionCode.trim()) ||
    (scope.level.value === "指定门店" && scope.stores.length === 0)
  ) {
    missing.push("scopeCode");
  }
  if (!noIcs) {
    if (scope.markets.provenance === "pending" || scope.markets.value.length === 0) missing.push("markets");
    if (scope.channels.provenance === "pending" || scope.channels.value.length === 0) missing.push("channels");
  }

  const batch = draft.schedule.batches[0];
  if (!batch?.startDate || !batch?.endDate) missing.push("dates");

  if (draft.audience.segments.value.length === 0) missing.push("segments");
  if (draft.products.categories.provenance === "pending" || draft.products.categories.value.length === 0) missing.push("categories");
  if (undecided(draft.audience.membership)) missing.push("membership");

  if (!noIcs) {
    const operations = draft.operations;
    if (
      operations.concessionRate.provenance !== "user" ||
      operations.concessionRate.value === null ||
      operations.collectionRate.provenance !== "user" ||
      operations.collectionRate.value === null
    ) {
      missing.push("rates");
    }
    if (operations.paymentRestricted.provenance !== "user") missing.push("paymentRestricted");
  }

  return missing;
}

export function missingFieldsOf(draft: CampaignDraft, topic: TopicId): FieldKey[] {
  return missingFields(draft).filter((key) => FIELD_TOPIC[key] === topic);
}

export function missingTopics(draft: CampaignDraft): TopicId[] {
  const topics = new Set(missingFields(draft).map((key) => FIELD_TOPIC[key]));
  return ASKED_TOPICS.filter((topic) => topics.has(topic));
}

export type PathKind = "enum" | "enumArray" | "textArray" | "number" | "boolean" | "text" | "date";

export type PathSpec = {
  path: string;
  label: string;
  kind: PathKind;
  topic: TopicId;
  fieldValue: boolean;
  options?: readonly string[];
};

export const PATH_TABLE: PathSpec[] = [
  { path: "/intent/customerAction", label: "顾客动作", kind: "enum", topic: "action", fieldValue: true, options: CUSTOMER_ACTION_OPTIONS },
  { path: "/intent/occasion", label: "由头类型", kind: "enum", topic: "action", fieldValue: true, options: OCCASION_OPTIONS },
  { path: "/intent/reason", label: "由头原话", kind: "text", topic: "action", fieldValue: false },
  { path: "/offer/mechanism", label: "让利机制", kind: "enum", topic: "offer", fieldValue: true, options: MECHANISM_OPTIONS },
  { path: "/offer/stacking", label: "能否叠加（是/否）", kind: "enum", topic: "offer", fieldValue: true, options: ["是", "否"] },
  { path: "/scope/level", label: "范围层级", kind: "enum", topic: "scope", fieldValue: true, options: LEVEL_OPTIONS },
  { path: "/scope/regionCode", label: "区域名称", kind: "text", topic: "scope", fieldValue: false },
  { path: "/scope/divisionCode", label: "分区名称", kind: "text", topic: "scope", fieldValue: false },
  { path: "/scope/markets", label: "覆盖市场", kind: "enumArray", topic: "scope", fieldValue: true, options: MARKET_OPTIONS },
  { path: "/scope/channels", label: "渠道", kind: "enumArray", topic: "scope", fieldValue: true, options: CHANNEL_OPTIONS },
  { path: "/schedule/batches/0/startDate", label: "开始日期（YYYY-MM-DD）", kind: "date", topic: "schedule", fieldValue: false },
  { path: "/schedule/batches/0/endDate", label: "结束日期（YYYY-MM-DD）", kind: "date", topic: "schedule", fieldValue: false },
  { path: "/audience/segments", label: "人群（按场合、关系、身份）", kind: "textArray", topic: "audience_products", fieldValue: true },
  { path: "/products/categories", label: "业务大类", kind: "enumArray", topic: "audience_products", fieldValue: true, options: CATEGORY_OPTIONS },
  { path: "/audience/membership", label: "会员限制", kind: "enum", topic: "audience_products", fieldValue: true, options: ["不限", "限"] },
  { path: "/audience/membershipDescription", label: "会员范围描述", kind: "text", topic: "audience_products", fieldValue: false },
  { path: "/operations/concessionRate", label: "让扣点", kind: "number", topic: "operations", fieldValue: true },
  { path: "/operations/collectionRate", label: "回款率", kind: "number", topic: "operations", fieldValue: true },
  { path: "/operations/paymentRestricted", label: "支付方式是否有限制", kind: "boolean", topic: "operations", fieldValue: true },
  { path: "/title", label: "活动标题", kind: "text", topic: "brief", fieldValue: false },
  { path: "/brief/externalName", label: "对外传播名", kind: "text", topic: "brief", fieldValue: false },
  { path: "/brief/icsName", label: "ICS 开单名（不超过 13 字，无特殊字符）", kind: "text", topic: "brief", fieldValue: false },
  { path: "/brief/content", label: "活动内容", kind: "text", topic: "brief", fieldValue: false },
  { path: "/brief/slogan", label: "活动标语", kind: "text", topic: "brief", fieldValue: false },
];

export const TIER_KEYS = ["thresholdAmount", "discountRate", "amountOff"] as const;

export function pathSpec(path: string): PathSpec | undefined {
  return PATH_TABLE.find((entry) => entry.path === path);
}

export function topicOfPath(path: string): TopicId | null {
  if (path.startsWith("/intent")) return "action";
  if (path.startsWith("/offer")) return "offer";
  if (path.startsWith("/scope")) return "scope";
  if (path.startsWith("/schedule")) return "schedule";
  if (path.startsWith("/audience") || path.startsWith("/products")) return "audience_products";
  if (path.startsWith("/operations")) return "operations";
  if (path.startsWith("/brief") || path === "/title") return "brief";
  return null;
}
