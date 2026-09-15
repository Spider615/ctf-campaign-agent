export type Provenance = "user" | "ai" | "default" | "pending";

export type Vintage = {
  year: number;
  sourceImage: string;
  completeness?: "complete" | "truncated" | "conflicted";
};

export type FieldValue<T> = {
  value: T;
  provenance: Provenance;
  vintage?: Vintage;
  suggested?: boolean;
};

export type CustomerAction =
  | "只看到"
  | "参与互动"
  | "到场"
  | "留资"
  | "下单"
  | "带旧货来换"
  | "还没定";

export type OccasionType =
  | "日历节点"
  | "品牌节点"
  | "外部节点"
  | "线下场"
  | "门店日常经营"
  | "私域日常运营";

export type OfferMechanism =
  | "无让利"
  | "以旧换新换购"
  | "门槛型"
  | "直接价格"
  | "赠品兑换"
  | "券核销"
  | "还没定";

export type CampaignBatch = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
};

export type OfferTier = {
  id: string;
  label: string;
  thresholdAmount: number | null;
  thresholdCount: number | null;
  judgingWeight: number | null;
  discountRate: number | null;
  amountOff: number | null;
};

export type CampaignBrief = {
  externalName: string;
  icsName: string;
  content: string;
  slogan: string;
};

export type CampaignDraft = {
  id: string;
  title: string;
  brief: CampaignBrief;
  intent: {
    occasion: FieldValue<OccasionType>;
    reason: string;
    customerAction: FieldValue<CustomerAction>;
    derivedType: string;
  };
  audience: {
    segments: FieldValue<string[]>;
    membership: FieldValue<"不限" | "限" | "还没定">;
    membershipDescription: string;
  };
  products: {
    categories: FieldValue<string[]>;
    series: string;
    narrowScope: boolean;
    productScope: FieldValue<number>;
    outletTagConversion: boolean;
    assignedItemMode: boolean;
    assignedItems: string[];
  };
  offer: {
    mechanism: FieldValue<OfferMechanism>;
    offerType: number | null;
    tiers: OfferTier[];
    responsibility: string;
    stacking: FieldValue<"是" | "否" | "还没定">;
    couponAllowed: boolean | null;
    tradeInUpgradeRatio: number | null;
  };
  scope: {
    level: FieldValue<"全国" | "区域" | "分区" | "指定门店" | "电商平台">;
    regionCode: string;
    divisionCode: string;
    rowCode: string;
    stores: Array<{ code: string; name: string }>;
    markets: FieldValue<string[]>;
    channels: FieldValue<Array<"线上" | "线下">>;
  };
  schedule: {
    batches: CampaignBatch[];
    lunarGregorianDate: string | null;
    cycleWeekdays: FieldValue<number[]>;
    longTermSplit: "按季度" | "按批次" | "按赛程" | "手动" | null;
  };
  metric: {
    name: string;
    target: number | null;
  };
  operations: {
    brandLine: FieldValue<string>;
    concessionRate: FieldValue<number | null>;
    collectionRate: FieldValue<number | null>;
    paymentRestricted: FieldValue<boolean>;
    activityGroup: string | null;
  };
  unresolved: string[];
};

export type SplitFactors = {
  batches: number;
  markets: number;
  channels: number;
  scopeUnits: number;
  offerTiers: number;
};

export type SplitSummary = {
  total: number;
  factors: SplitFactors;
  reason?: string;
};

export type IcsOrderDraft = {
  id: string;
  activitySequence: string;
  name: string;
  batch: CampaignBatch;
  market: string;
  channel: "线上" | "线下";
  scopeUnit: string;
  offerTier: OfferTier;
  status: "ready" | "blocked";
};

export type ValidationIssue = {
  ruleId: `R${number}`;
  severity: "blocker" | "warning";
  path: string;
  message: string;
  evidence?: string;
};

export type PatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
  reason: string;
  provenance: Provenance;
};

export type FieldDiff = {
  path: string;
  before: unknown;
  after: unknown;
};

export type DraftVersion = {
  seq: number;
  draft: CampaignDraft;
  source: "ai" | "human" | "rollback";
  reason: string;
  createdAt: string;
  diffs: FieldDiff[];
};

