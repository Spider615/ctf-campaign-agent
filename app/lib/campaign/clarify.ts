import { answerToOps, parseAnswer } from "./answers.ts";
import { applyPatch } from "./patcher.ts";
import {
  CATEGORY_OPTIONS,
  CHANNEL_OPTIONS,
  CUSTOMER_ACTION_OPTIONS,
  FIELD_LABEL,
  LEVEL_OPTIONS,
  MARKET_OPTIONS,
  missingFields,
  noIcsOrders,
  OCCASION_OPTIONS,
  SEGMENT_OPTIONS,
  type FieldKey,
  type TopicId,
} from "./topics.ts";
import type { CampaignDraft, PatchOperation } from "./types.ts";

export type ClarifyKey =
  | "customerAction"
  | "occasion"
  | "mechanism"
  | "tier"
  | "stacking"
  | "scope"
  | "markets"
  | "channels"
  | "dates"
  | "categories"
  | "series"
  | "segments"
  | "membership"
  | "rates"
  | "paymentRestricted";

export const CLARIFY_ORDER: ClarifyKey[] = [
  "customerAction",
  "occasion",
  "mechanism",
  "tier",
  "stacking",
  "scope",
  "markets",
  "channels",
  "dates",
  "categories",
  "series",
  "segments",
  "membership",
  "rates",
  "paymentRestricted",
];

export type ClarifyMode = "single" | "multi" | "tier" | "scope" | "dates" | "rates";
export type ClarifyOption = { value: string; label: string };

type CatalogEntry = {
  title: string;
  why: string;
  mode: ClarifyMode;
  options?: ClarifyOption[];
  customPlaceholder?: string;
};

const plain = (values: readonly string[]): ClarifyOption[] => values.map((value) => ({ value, label: value }));

// 枚举类选项是 ICS 能接受的固定值；人群、主推货品的选项由模型按这次活动生成；数字、日期只给输入框。
export const CLARIFY_CATALOG: Record<ClarifyKey, CatalogEntry> = {
  customerAction: { title: "顾客做到哪一步，这个活动才算数？", why: "只到「看到」就不在 ICS 开单。", mode: "single", options: plain(CUSTOMER_ACTION_OPTIONS), customPlaceholder: "其他说法" },
  occasion: { title: "这次活动的由头是哪一类？", why: "决定方案的叙事口径。", mode: "single", options: plain(OCCASION_OPTIONS), customPlaceholder: "其他由头，例如：品牌周年庆" },
  mechanism: {
    title: "拿什么让利？",
    why: "决定 ICS 里建哪类优惠规则。",
    mode: "single",
    options: [
      { value: "门槛型", label: "满减 / 满折" },
      { value: "直接价格", label: "直接打折 / 减价" },
      { value: "以旧换新换购", label: "以旧换新 / 换购" },
      { value: "赠品兑换", label: "送赠品" },
      { value: "券核销", label: "用券核销" },
      { value: "无让利", label: "不让利" },
    ],
    customPlaceholder: "其他让利方式",
  },
  tier: { title: "优惠力度是多少？", why: "优惠数字只用你给的，我不猜。", mode: "tier" },
  stacking: { title: "能和其他折扣、券叠加吗？", why: "决定 ICS 里是否计算折上折、能否用券。", mode: "single", options: [{ value: "否", label: "不能叠加" }, { value: "是", label: "可以叠加" }], customPlaceholder: "其他说明" },
  scope: { title: "活动做在哪个范围？", why: "范围层级和具体区域、门店决定拆几条 ICS 单。", mode: "scope", options: plain(LEVEL_OPTIONS) },
  markets: { title: "覆盖哪些市场？", why: "每个市场单独开单。", mode: "multi", options: plain(MARKET_OPTIONS), customPlaceholder: "其他市场" },
  channels: { title: "做线上还是线下？", why: "线上、线下在 ICS 里是两条单。", mode: "multi", options: plain(CHANNEL_OPTIONS), customPlaceholder: "其他渠道，例如：天猫旗舰店" },
  dates: { title: "活动哪天开始、哪天结束？", why: "ICS 不接受没有结束日期的活动。", mode: "dates" },
  categories: { title: "卖哪些货？", why: "决定 ICS 里选哪些货类。", mode: "multi", options: plain(CATEGORY_OPTIONS), customPlaceholder: "其他品类" },
  series: { title: "主推什么货品？", why: "写进方案的主推内容。", mode: "multi", customPlaceholder: "其他货品" },
  segments: { title: "主要打哪类人？", why: "按场合、关系、身份描述，不按年龄性别。", mode: "multi", customPlaceholder: "其他人群" },
  membership: { title: "限不限会员？", why: "限会员时要在 ICS 界面勾选会员级别。", mode: "single", options: [{ value: "不限", label: "不限会员" }, { value: "限", label: "限会员" }], customPlaceholder: "限哪些会员，例如：中高等级" },
  rates: { title: "这次的让扣点和回款率是多少？", why: "门店合约参数，AI 推不出来，要你明确给。", mode: "rates" },
  paymentRestricted: { title: "支付方式有没有限制？", why: "有限制时要在 ICS 界面勾选支付方式。", mode: "single", options: [{ value: "false", label: "不限制" }, { value: "true", label: "有限制" }], customPlaceholder: "限制说明" },
};

export const CLARIFY_LABEL: Record<ClarifyKey, string> = {
  customerAction: "顾客动作",
  occasion: "由头",
  mechanism: "让利方式",
  tier: "优惠力度",
  stacking: "能否叠加",
  scope: "范围",
  markets: "市场",
  channels: "渠道",
  dates: "日期",
  categories: "货品大类",
  series: "主推货品",
  segments: "人群",
  membership: "会员限制",
  rates: "让扣点与回款率",
  paymentRestricted: "支付方式",
};

export type ClarifyQuestion = { key: ClarifyKey; title: string; why: string; options?: string[] };
export type ClarifyOptions = { segments: string[]; series: string[] };

export const OFFER_CLARIFY_KEYS: ClarifyKey[] = ["mechanism", "tier", "stacking", "markets", "channels", "rates", "paymentRestricted"];

export function isClarifyKey(value: unknown): value is ClarifyKey {
  return typeof value === "string" && (CLARIFY_ORDER as string[]).includes(value);
}

function toClarifyKey(field: FieldKey): ClarifyKey {
  return field === "level" || field === "scopeCode" ? "scope" : (field as ClarifyKey);
}

const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
export const splitList = (text: string) => unique(text.split(/[、，,；;\n]/));

function providedByUser(draft: CampaignDraft, key: ClarifyKey): boolean {
  switch (key) {
    case "customerAction":
      return draft.intent.customerAction.provenance === "user";
    case "occasion":
      return draft.intent.occasion.provenance !== "pending";
    case "mechanism":
      return draft.offer.mechanism.provenance === "user";
    case "tier":
      return draft.offer.tiers.some((tier) => tier.discountRate !== null || tier.amountOff !== null);
    case "stacking":
      return draft.offer.stacking.provenance === "user";
    case "scope":
      return draft.scope.level.provenance === "user" && !missingFields(draft).includes("scopeCode");
    case "markets":
      return draft.scope.markets.provenance === "user";
    case "channels":
      return draft.scope.channels.provenance === "user";
    case "dates":
      return Boolean(draft.schedule.batches[0]?.startDate && draft.schedule.batches[0]?.endDate);
    case "categories":
      return draft.products.categories.provenance === "user";
    case "series":
      return Boolean(draft.products.series.trim());
    case "segments":
      return draft.audience.segments.provenance === "user";
    case "membership":
      return draft.audience.membership.provenance === "user";
    case "rates":
      return draft.operations.concessionRate.provenance === "user" && draft.operations.collectionRate.provenance === "user";
    case "paymentRestricted":
      return draft.operations.paymentRestricted.provenance === "user";
  }
}

// 问哪些项：开单必需但还缺的项一律保留（兜底），再加上模型认为值得问、用户还没明确说过的项。
export function buildClarifyQuestions(draft: CampaignDraft, ask: readonly string[], options: ClarifyOptions): ClarifyQuestion[] {
  const wanted = new Set<ClarifyKey>(missingFields(draft).map(toClarifyKey));
  for (const key of ask) {
    if (isClarifyKey(key) && !providedByUser(draft, key)) wanted.add(key);
  }
  if (wanted.has("mechanism")) wanted.add("tier");
  if (noIcsOrders(draft)) OFFER_CLARIFY_KEYS.forEach((key) => wanted.delete(key));

  return CLARIFY_ORDER.filter((key) => wanted.has(key)).map((key) => {
    const entry = CLARIFY_CATALOG[key];
    const generated = key === "segments"
      ? unique([...options.segments, ...draft.audience.segments.value, ...SEGMENT_OPTIONS]).slice(0, 6)
      : key === "series"
        ? unique([...options.series, ...splitList(draft.products.series)]).slice(0, 6)
        : undefined;
    return { key, title: entry.title, why: entry.why, ...(generated ? { options: generated } : {}) };
  });
}

export function missingLabels(draft: CampaignDraft): string[] {
  return [...new Set(missingFields(draft).map((key) => FIELD_LABEL[key]))];
}

// 「其他」输入框里的文字，需要模型解析才能落到固定取值上的项。
const MODEL_PARSED: Partial<Record<ClarifyKey, FieldKey>> = {
  customerAction: "customerAction",
  mechanism: "mechanism",
  stacking: "stacking",
  markets: "markets",
  channels: "channels",
  categories: "categories",
};

export type ClarifyCustom = { key: ClarifyKey; field: FieldKey; label: string; text: string };

export type ClarifyApplication = {
  draft: CampaignDraft;
  ops: PatchOperation[];
  customs: ClarifyCustom[];
  ignored: string[];
  summary: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const replaceOp = (path: string, value: unknown): PatchOperation => ({ op: "replace", path, value, reason: "补充卡片", provenance: "user" });

function guessLevel(text: string): string {
  if (/^[A-Za-z0-9-]+[\s　]+\S/m.test(text) || /门店/.test(text)) return "指定门店";
  if (/分区/.test(text)) return "分区";
  if (/全国/.test(text)) return "全国";
  if (/电商|天猫|京东/.test(text)) return "电商平台";
  return "区域";
}

function parseStoreLines(text: string): Array<{ code: string; name: string }> {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const match = /^([A-Za-z0-9-]+)[\s　]+(.+)$/.exec(line);
    return match ? [{ code: match[1], name: match[2].trim() }] : [];
  });
}

function tierText(tier: { thresholdAmount: number | null; discountRate: number | null; amountOff: number | null }): string {
  const head = tier.thresholdAmount !== null ? `满 ${tier.thresholdAmount} ` : "";
  if (tier.amountOff !== null) return `${head}减 ${tier.amountOff}`;
  if (tier.discountRate !== null) return `${head}打 ${Number((tier.discountRate * 10).toFixed(2))} 折`;
  return head.trim();
}

export function applyClarifyAnswers(raw: unknown, base: CampaignDraft, keys: readonly ClarifyKey[]): ClarifyApplication {
  let draft = base;
  const ops: PatchOperation[] = [];
  const customs: ClarifyCustom[] = [];
  const ignored: string[] = [];
  const summary: string[] = [];
  const answers = isRecord(raw) ? raw : {};

  const push = (next: PatchOperation[], text: string) => {
    draft = applyPatch(draft, next);
    ops.push(...next);
    summary.push(text);
  };
  const answer = (key: ClarifyKey, topic: TopicId, values: Record<string, unknown>, text: string) => {
    try {
      push(answerToOps(parseAnswer(topic, values, draft), draft), text);
    } catch {
      ignored.push(CLARIFY_LABEL[key]);
    }
  };

  for (const key of CLARIFY_ORDER) {
    const value = answers[key];
    if (!keys.includes(key) || !isRecord(value)) continue;
    const choice = typeof value.choice === "string" && value.choice ? value.choice : undefined;
    const choices = Array.isArray(value.choices) ? value.choices.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
    const custom = typeof value.custom === "string" ? value.custom.trim().slice(0, 200) : "";

    switch (key) {
      case "customerAction":
        if (choice) answer(key, "action", { customerAction: choice }, `顾客动作：${choice}`);
        break;
      case "occasion":
        if (choice) answer(key, "action", { occasion: choice }, `由头类型：${choice}`);
        if (custom) push([replaceOp("/intent/reason", custom)], `由头：${custom}`);
        break;
      case "mechanism":
        if (choice) answer(key, "offer", { mechanism: choice }, `让利：${CLARIFY_CATALOG.mechanism.options?.find((option) => option.value === choice)?.label ?? choice}`);
        break;
      case "tier": {
        const tier = { thresholdAmount: numberOrNull(value.thresholdAmount), discountRate: numberOrNull(value.discountRate), amountOff: numberOrNull(value.amountOff) };
        if (tier.discountRate !== null || tier.amountOff !== null) answer(key, "offer", { tier }, `优惠力度：${tierText(tier)}`);
        else if (tier.thresholdAmount !== null) ignored.push(CLARIFY_LABEL.tier);
        break;
      }
      case "stacking":
        if (choice) answer(key, "offer", { stacking: choice }, choice === "是" ? "可以叠加" : "不能叠加");
        break;
      case "scope": {
        const text = typeof value.text === "string" ? value.text.trim().slice(0, 400) : "";
        const level = typeof value.level === "string" && value.level ? value.level : text ? guessLevel(text) : undefined;
        if (!level) break;
        const values: Record<string, unknown> = { level };
        if (text && level === "区域") values.regionText = text;
        if (text && level === "分区") values.divisionText = text;
        if (text && level === "指定门店") values.stores = parseStoreLines(text);
        answer(key, "scope", values, `范围：${[level, text].filter(Boolean).join(" ")}`);
        break;
      }
      case "markets":
        if (choices.length) answer(key, "scope", { markets: choices }, `市场：${choices.join("、")}`);
        break;
      case "channels":
        if (choices.length) answer(key, "scope", { channels: choices }, `渠道：${choices.join("、")}`);
        break;
      case "categories":
        if (choices.length) answer(key, "audience_products", { categories: choices }, `货品：${choices.join("、")}`);
        break;
      case "dates": {
        const values: Record<string, unknown> = {};
        if (typeof value.startDate === "string" && value.startDate) values.startDate = value.startDate;
        if (typeof value.endDate === "string" && value.endDate) values.endDate = value.endDate;
        if (Object.keys(values).length) answer(key, "schedule", values, `日期：${values.startDate ?? "未填"} 至 ${values.endDate ?? "未填"}`);
        break;
      }
      case "segments": {
        const all = unique([...choices, ...splitList(custom)]);
        if (all.length) answer(key, "audience_products", { segments: all }, `人群：${all.join("、")}`);
        break;
      }
      case "series": {
        const all = unique([...choices, ...splitList(custom)]);
        if (all.length) push([replaceOp("/products/series", all.join("、"))], `主推：${all.join("、")}`);
        break;
      }
      case "membership": {
        const resolved = choice ?? (custom ? "限" : undefined);
        if (resolved) {
          answer(key, "audience_products", { membership: resolved, ...(resolved === "限" && custom ? { membershipDescription: custom } : {}) }, resolved === "不限" ? "不限会员" : `限会员${custom ? `：${custom}` : ""}`);
        }
        break;
      }
      case "rates": {
        const concessionRate = numberOrNull(value.concessionRate);
        const collectionRate = numberOrNull(value.collectionRate);
        const values: Record<string, unknown> = {};
        if (concessionRate !== null) values.concessionRate = concessionRate;
        if (collectionRate !== null) values.collectionRate = collectionRate;
        if (Object.keys(values).length) {
          answer(key, "operations", values, [concessionRate !== null ? `让扣点 ${concessionRate}` : "", collectionRate !== null ? `回款率 ${collectionRate}` : ""].filter(Boolean).join("，"));
        }
        break;
      }
      case "paymentRestricted": {
        const resolved = choice === "true" ? true : choice === "false" ? false : custom ? true : undefined;
        if (resolved !== undefined) answer(key, "operations", { paymentRestricted: resolved }, resolved ? `支付方式有限制${custom ? `：${custom}` : ""}` : "支付方式不限制");
        break;
      }
    }

    const field = MODEL_PARSED[key];
    if (custom && field) {
      const picked = choices.length ? `已选 ${choices.join("、")}；` : choice ? `已选 ${choice}；` : "";
      customs.push({ key, field, label: CLARIFY_LABEL[key], text: `${picked}其他：${custom}` });
    }
  }

  return { draft, ops, customs, ignored, summary };
}
