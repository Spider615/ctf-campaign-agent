// ICS-1811 单条新增：事实层（用户说过的话）与每轮由代码推导的填写模型。
// 设计见 docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md。

// 填写模型字段的来源：user 用户原话、面板或用户同意的提议；ai 由规则、代码表推出；default 页面默认或 §9(四) 的 demo 处理；pending 还没有值。
export type Source = "user" | "ai" | "default" | "pending";

// proposal：Agent 提议了具体值，用户在对话里点头同意（quote 是用户那句话）。
export type FactVia = "text" | "card" | "panel" | "proposal";

// 事实层的一项：用户说过的值，附原话片段（结构化回答记作「卡片：Q1」）。
export type Fact<T> = { value: T; quote: string; via: FactVia };

export type OfferPattern =
  | "discount" // 纯打折
  | "threshold" // 满减 / 每满减
  | "per_gram" // 金价每克 / 每整克减免
  | "platinum_tradein" // 铂金以旧换新（铂金换购特殊营销折扣）
  | "diamond_upgrade" // 钻石以小换大
  | "gold_tradein" // 黄金以旧换新
  | "diamond_gold_gram" // 买钻石享黄金克减
  | "unsupported";

export type OfferItem = {
  // 纯打折的折扣；铂金、钻石以小换大、买钻石的开单折扣；黄金以旧换新的工费折扣。
  discount: number | null;
  upgradeRatio: number | null; // 黄金以旧换新的换大比例
  multiple: number | null; // 铂金以旧换新的换大倍数，填在判断金额
  threshold: number | null; // 满 X
  amount: number | null; // 减 Y；每克减 Y
  categories: string[] | null; // 多个货类折扣不同时，这一条单独对应的货类代码
};

export type OfferFact = { pattern: OfferPattern; items: OfferItem[]; unsupportedType: string | null };

export type SloganFact = { wanted: false } | { wanted: true; text: string; legalConfirmed: boolean | null };

export type RestrictionKey =
  | "allowModel"
  | "denyModel"
  | "allowSeries"
  | "denySeries"
  | "priceCap"
  | "priceFloor"
  | "allowInlay"
  | "denyInlay"
  | "allowModelCategory"
  | "denyGoodsGroup"
  | "orderAmountMin";

export type RestrictionMention = { field: RestrictionKey | null; value: string | null; text: string };

export type Facts = {
  // 人定（§9(二)）
  dates: Fact<{ start: string; end: string }> | null;
  stores: Fact<string[]> | null;
  offer: Fact<OfferFact> | null;
  discountEditable: Fact<boolean> | null;
  thresholdRepeat: Fact<"once" | "every"> | null;
  gramBasis: Fact<"actual" | "whole"> | null;
  categories: Fact<Record<string, string[]>> | null;
  menuConversion: Fact<boolean> | null;
  rates: Fact<{ concession: number; collection: number }> | null;
  commission: Fact<"actual_price" | "price_times_discount"> | null;
  settlementLetter: Fact<boolean> | null;
  slogan: Fact<SloganFact> | null;
  // AI 定字段的线索：用户提到时照原文换算（§9(三)）
  brands: Fact<string[]> | null;
  weekdays: Fact<number[]> | null;
  online: Fact<boolean> | null;
  productScope: Fact<string> | null;
  paymentRemove: Fact<string[]> | null;
  paymentAdd: Fact<string[]> | null;
  headCodes: Fact<string[]> | null;
  memberLevels: Fact<string[]> | null;
  priceTypes: Fact<string[]> | null;
  restrictions: Fact<RestrictionMention[]> | null;
};

export type FactKey = keyof Facts;

export type Ics1811Draft = {
  schema: "ics1811/v1";
  id: string;
  requestText: string;
  facts: Facts;
  unresolvedStores: string[]; // 对不上代码表的门店说法，追问时给候选
  unresolvedCategories: string[]; // 有歧义或对不上的货类说法
  copy: { name: string; content: string; source: "ai" | "user" } | null;
  // 对外宣传文案里模型能写的只有创意部分：主标题和卖点。日期、门店、优惠力度
  // 由代码从 fill 渲染，不让模型重写一遍（数字有守卫，但「闽深区」写成「华南区」拦不住）。
  // 旧会话读出来没有这个字段，取值处一律按 ?? null 容错。
  promo: { headline: string; highlights: string[]; source: "ai" | "user" } | null;
  dismissedNotes: string[]; // 用户在复述里选了「不限定」的提示
};

// ---- 每轮由代码推导的 1811 填写模型 ----

export type Field<T> = { value: T; source: Source; basis: string; tbc?: string };

export type DiscountMode = "浮动折扣模式" | "固定折扣模式";

export type ParamKey = "discount" | "billingDiscount" | "upgradeRatio" | "judgeAmount" | "offerAmount";

export type DetailParam = { key: ParamKey; label: string; value: Field<number | null>; inferred: boolean };

// baseVersion：这一栏在固定模式的基础 9 栏里（05a/05c/05e/05f），否则只在部分版本页面出现。
export type DetailRestriction = { key: RestrictionKey; label: string; value: Field<string>; baseVersion: boolean };

export type Detail = {
  index: number;
  mode: Field<DiscountMode | null>;
  offerType: Field<string | null>;
  params: DetailParam[];
  categories: Field<string[]>;
  headCodes: Field<string[]>;
  memberLevels: Field<string[]>;
  priceTypes: Field<string[]> | null; // 浮动模式页面没有这一栏
  businessCategory: Field<string>;
  concessionRate: Field<number | null>;
  collectionRate: Field<number | null>;
  restrictions: DetailRestriction[];
};

export type ActivityInfo = {
  name: Field<string>;
  slogan: Field<string>;
  content: Field<string>;
  startDate: Field<string | null>;
  endDate: Field<string | null>;
  channel: Field<string>;
  offerNature: Field<string>;
  brand: Field<string | null>;
  commission: Field<string | null>;
  joinDiscount: Field<string>;
  presaleDays: Field<number>;
  cycle: Field<string>;
  approvalFlow: Field<string | null>;
  productScope: Field<string>;
  menuConversion: Field<string | null>;
  couponOnly: Field<string>;
  region: Field<string | null>;
  division: Field<string | null>;
  subArea: Field<string | null>;
  city: Field<string | null>;
  branches: Field<string[]>;
  paymentMethods: Field<string[]>;
};

export type NoteKind =
  | "unsupported_offer"
  | "inferred_columns"
  | "multi_brand"
  | "price_type_lost"
  | "restriction_unresolved"
  | "needs_split"
  | "tbc";

export type Note = { id: string; kind: NoteKind; text: string; blocking: boolean; sop: string };

export type PostAction = { id: string; text: string; sop: string };

export type FillModel = {
  info: ActivityInfo;
  settlement: { has: Field<boolean | null>; fileNames: string[] } | null;
  details: Detail[];
  activityGroup: { value: string; basis: string };
  postActions: PostAction[];
  notes: Note[];
  outOfScope: string | null;
};

export type Check = { id: string; severity: "blocker" | "warning"; message: string; sop: string };

export type QuestionId = "Q1" | "Q2" | "Q3" | "Q3a" | "Q3b" | "Q3c" | "Q3d" | "Q3e" | "Q4" | "Q4a" | "Q5a" | "Q5b" | "Q5c" | "Q6a" | "Q6b";

export type Gap = {
  id: QuestionId;
  title: string;
  hint?: string;
  candidates?: string[];
  slots?: string[];
  params?: ParamKey[];
};

// Agent 在对话里提议的具体值：answer 是结构化回答（格式同 card.ts），text 由代码按事实层渲染，
// 用户回「行」「对」时按 answer 记下，不按模型嘴上说的记。
// before 是提议时这几项的原值（渲染文字）：之后用户自己改过这几项，提议就作废，免得一句「行」把用户刚说的覆盖回去。
// 旧消息里的提议没有 before，只在这一项仍缺时有效。
export type Proposal = { id: QuestionId; answer: Record<string, unknown>; text: string; before?: string };

// 没有「确认」这一步：人定项齐了、校验没有阻断，就是 ready，这一轮直接生成填写值。
export type Plan =
  | { action: "collect"; missing: Gap[]; blockers: Check[] }
  | { action: "ready" }
  | { action: "out_of_scope"; reason: string };

// 对话所处的阶段。放在这里而不是 turns.ts：等待时那句说明文案（thinking.ts）要用它，
// 领域层不能反过来依赖 server 层。turns.ts 的快照直接引这个类型。
// collecting 还缺人定项；blocked 不缺了但有校验阻断；ready 已经建好。
export type FlowPhase = "interpreting" | "collecting" | "blocked" | "ready" | "out_of_scope";
