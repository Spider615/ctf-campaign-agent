import { stripParenthetical } from "./evidence.ts";
import {
  CATEGORY_OPTIONS,
  CHANNEL_OPTIONS,
  CUSTOMER_ACTION_OPTIONS,
  includesOption,
  LEVEL_OPTIONS,
  MARKET_OPTIONS,
  MECHANISM_OPTIONS,
  OCCASION_OPTIONS,
  type TopicId,
} from "./topics.ts";
import type { CampaignDraft, OccasionType, PatchOperation } from "./types.ts";

export type TierValues = { thresholdAmount: number | null; discountRate: number | null; amountOff: number | null };
export type ScopeLevel = (typeof LEVEL_OPTIONS)[number];
export type StoreEntry = { code: string; name: string };

export type AnswerValues = {
  action: { customerAction?: (typeof CUSTOMER_ACTION_OPTIONS)[number]; occasion?: OccasionType };
  offer: { mechanism?: (typeof MECHANISM_OPTIONS)[number]; tier?: TierValues; stacking?: "是" | "否" };
  scope: {
    level?: ScopeLevel;
    regionText?: string;
    divisionText?: string;
    stores?: StoreEntry[];
    markets?: Array<(typeof MARKET_OPTIONS)[number]>;
    channels?: Array<"线上" | "线下">;
  };
  schedule: { startDate?: string; endDate?: string };
  audience_products: {
    segments?: string[];
    categories?: Array<(typeof CATEGORY_OPTIONS)[number]>;
    membership?: "不限" | "限";
    membershipDescription?: string;
  };
  operations: { concessionRate?: number; collectionRate?: number; paymentRestricted?: boolean };
  brief: { title?: string; externalName?: string; icsName?: string; content?: string; slogan?: string };
};

export type Answer = { [K in TopicId]: { topic: K; values: AnswerValues[K] } }[TopicId];

export class AnswerError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_CODE = /^[A-Za-z0-9-]+$/;

function fail(message: string): never {
  throw new AnswerError(message);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label}不能为空`);
  if (value.trim().length > max) fail(`${label}不能超过 ${max} 个字`);
  return value.trim();
}

function uniqueOptions<T extends string>(value: unknown, options: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) fail(`请至少选择一个${label}`);
  if (!value.every((item) => includesOption(options, item))) fail(`${label}不在可选范围内`);
  return [...new Set(value as T[])];
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (!finite(value)) fail(`${label}必须是数字`);
  return value;
}

export function parseAnswer(topic: unknown, raw: unknown, draft: CampaignDraft): Answer {
  if (!isRecord(raw) || Object.values(raw).every((value) => value === undefined)) fail("回答内容不完整");

  switch (topic) {
    case "action": {
      if (raw.customerAction !== undefined && !includesOption(CUSTOMER_ACTION_OPTIONS, raw.customerAction)) fail("顾客动作不在可选范围内");
      if (raw.occasion !== undefined && !includesOption(OCCASION_OPTIONS, raw.occasion)) fail("由头类型不在可选范围内");
      return { topic, values: { customerAction: raw.customerAction as AnswerValues["action"]["customerAction"], occasion: raw.occasion as OccasionType | undefined } };
    }
    case "offer": {
      if (raw.mechanism !== undefined && !includesOption(MECHANISM_OPTIONS, raw.mechanism)) fail("让利机制不在可选范围内");
      if (raw.stacking !== undefined && raw.stacking !== "是" && raw.stacking !== "否") fail("叠加选项不正确");
      let tier: TierValues | undefined;
      if (raw.tier !== undefined) {
        if (!isRecord(raw.tier)) fail("优惠力度不完整");
        tier = {
          thresholdAmount: optionalNumber(raw.tier.thresholdAmount, "判断金额"),
          discountRate: optionalNumber(raw.tier.discountRate, "折扣率"),
          amountOff: optionalNumber(raw.tier.amountOff, "减免额"),
        };
        if (tier.discountRate !== null && tier.amountOff !== null) fail("折扣率和减免额只能填一个");
        if (tier.discountRate === null && tier.amountOff === null) fail("请填写折扣率或减免额");
        if (tier.discountRate !== null && (tier.discountRate <= 0 || tier.discountRate > 1)) fail("折扣率要填 0 到 1 之间的小数，8 折填 0.8");
        if (tier.amountOff !== null && tier.amountOff < 0) fail("减免额不能为负数");
        if (tier.thresholdAmount !== null && tier.thresholdAmount <= 0) fail("判断金额要大于 0");
        const mechanism = (raw.mechanism as string | undefined) ?? draft.offer.mechanism.value;
        if (mechanism === "门槛型" && tier.thresholdAmount === null) fail("门槛型优惠要填判断金额");
      }
      return { topic, values: { mechanism: raw.mechanism as AnswerValues["offer"]["mechanism"], tier, stacking: raw.stacking as "是" | "否" | undefined } };
    }
    case "scope": {
      if (raw.level !== undefined && !includesOption(LEVEL_OPTIONS, raw.level)) fail("范围层级不在可选范围内");
      let stores: StoreEntry[] | undefined;
      if (raw.stores !== undefined) {
        if (!Array.isArray(raw.stores) || raw.stores.length === 0) fail("请至少填写一家门店");
        const seen = new Set<string>();
        stores = raw.stores.map((entry) => {
          if (!isRecord(entry) || typeof entry.code !== "string" || !STORE_CODE.test(entry.code.trim())) fail("门店行号只能包含字母、数字和横线");
          return { code: entry.code.trim(), name: text(entry.name, "门店名称", 40) };
        }).filter((entry) => (seen.has(entry.code) ? false : (seen.add(entry.code), true)));
      }
      return {
        topic,
        values: {
          level: raw.level as ScopeLevel | undefined,
          regionText: raw.regionText === undefined ? undefined : text(raw.regionText, "区域名称", 40),
          divisionText: raw.divisionText === undefined ? undefined : text(raw.divisionText, "分区名称", 40),
          stores,
          markets: raw.markets === undefined ? undefined : uniqueOptions(raw.markets, MARKET_OPTIONS, "市场"),
          channels: raw.channels === undefined ? undefined : uniqueOptions(raw.channels, CHANNEL_OPTIONS, "渠道"),
        },
      };
    }
    case "schedule": {
      for (const key of ["startDate", "endDate"] as const) {
        if (raw[key] !== undefined && (typeof raw[key] !== "string" || !DATE.test(raw[key] as string))) fail("日期格式应为 YYYY-MM-DD");
      }
      const start = (raw.startDate as string | undefined) ?? draft.schedule.batches[0]?.startDate;
      const end = (raw.endDate as string | undefined) ?? draft.schedule.batches[0]?.endDate;
      if (start && end && start > end) fail("开始日期不能晚于结束日期");
      return { topic, values: { startDate: raw.startDate as string | undefined, endDate: raw.endDate as string | undefined } };
    }
    case "audience_products": {
      let segments: string[] | undefined;
      if (raw.segments !== undefined) {
        if (!Array.isArray(raw.segments) || raw.segments.length === 0) fail("请至少选择一类人群");
        segments = [...new Set(raw.segments.map((item) => text(item, "人群", 30)))];
        if (segments.some((item) => /岁|男性|女性/.test(item))) fail("人群按场合、关系、身份描述，不按年龄性别");
      }
      if (raw.membership !== undefined && raw.membership !== "不限" && raw.membership !== "限") fail("会员限制选项不正确");
      return {
        topic,
        values: {
          segments,
          categories: raw.categories === undefined ? undefined : uniqueOptions(raw.categories, CATEGORY_OPTIONS, "业务大类"),
          membership: raw.membership as "不限" | "限" | undefined,
          membershipDescription: raw.membershipDescription === undefined || raw.membershipDescription === "" ? undefined : text(raw.membershipDescription, "会员范围", 100),
        },
      };
    }
    case "operations": {
      for (const key of ["concessionRate", "collectionRate"] as const) {
        if (raw[key] !== undefined && (!finite(raw[key]) || (raw[key] as number) < 0)) fail("让扣点和回款率要填不小于 0 的数字");
      }
      if (raw.paymentRestricted !== undefined && typeof raw.paymentRestricted !== "boolean") fail("支付方式限制选项不正确");
      return {
        topic,
        values: {
          concessionRate: raw.concessionRate as number | undefined,
          collectionRate: raw.collectionRate as number | undefined,
          paymentRestricted: raw.paymentRestricted as boolean | undefined,
        },
      };
    }
    case "brief": {
      const limits = { title: 40, externalName: 40, icsName: 40, content: 500, slogan: 60 } as const;
      const values: AnswerValues["brief"] = {};
      for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
        if (raw[key] !== undefined) values[key] = text(raw[key], "文案", limits[key]);
      }
      return { topic, values };
    }
    default:
      return fail("回答的主题不正确");
  }
}

const replace = (path: string, value: unknown): PatchOperation => ({ op: "replace", path, value, reason: "用户回答", provenance: "user" });
const confirmed = <T>(value: T) => ({ value, provenance: "user" as const });
const withNote = (value: string) => `${stripParenthetical(value)}（请在生产界面选择）`;

export function answerToOps(answer: Answer, draft: CampaignDraft): PatchOperation[] {
  const ops: PatchOperation[] = [];
  switch (answer.topic) {
    case "action": {
      const values = answer.values;
      if (values.customerAction !== undefined) ops.push(replace("/intent/customerAction", confirmed(values.customerAction)));
      if (values.occasion !== undefined) ops.push(replace("/intent/occasion", confirmed(values.occasion)));
      break;
    }
    case "offer": {
      const values = answer.values;
      if (values.mechanism !== undefined) ops.push(replace("/offer/mechanism", confirmed(values.mechanism)));
      if (values.tier !== undefined) {
        if (draft.offer.tiers.length === 0) {
          ops.push({
            op: "add",
            path: "/offer/tiers/0",
            value: { id: "tier-1", label: "", thresholdCount: null, judgingWeight: null, ...values.tier },
            reason: "用户回答",
            provenance: "user",
          });
        } else {
          ops.push(
            replace("/offer/tiers/0/thresholdAmount", values.tier.thresholdAmount),
            replace("/offer/tiers/0/discountRate", values.tier.discountRate),
            replace("/offer/tiers/0/amountOff", values.tier.amountOff),
          );
        }
      }
      if (values.stacking !== undefined) ops.push(replace("/offer/stacking", confirmed(values.stacking)));
      break;
    }
    case "scope": {
      const values = answer.values;
      if (values.level !== undefined) ops.push(replace("/scope/level", confirmed(values.level)));
      const level = values.level ?? draft.scope.level.value;
      if (values.level !== undefined || values.regionText !== undefined || values.divisionText !== undefined || values.stores !== undefined) {
        ops.push(
          replace("/scope/regionCode", level === "区域" ? (values.regionText !== undefined ? withNote(values.regionText) : draft.scope.regionCode) : ""),
          replace("/scope/divisionCode", level === "分区" ? (values.divisionText !== undefined ? withNote(values.divisionText) : draft.scope.divisionCode) : ""),
          replace("/scope/rowCode", ""),
          replace("/scope/stores", level === "指定门店" ? (values.stores ?? draft.scope.stores) : []),
        );
      }
      if (values.markets !== undefined) ops.push(replace("/scope/markets", confirmed(values.markets)));
      if (values.channels !== undefined) ops.push(replace("/scope/channels", confirmed(values.channels)));
      break;
    }
    case "schedule": {
      const values = answer.values;
      if (values.startDate !== undefined) ops.push(replace("/schedule/batches/0/startDate", values.startDate));
      if (values.endDate !== undefined) ops.push(replace("/schedule/batches/0/endDate", values.endDate));
      break;
    }
    case "audience_products": {
      const values = answer.values;
      if (values.segments !== undefined) ops.push(replace("/audience/segments", confirmed(values.segments)));
      if (values.categories !== undefined) ops.push(replace("/products/categories", confirmed(values.categories)));
      if (values.membership !== undefined) {
        ops.push(replace("/audience/membership", confirmed(values.membership)));
        ops.push(replace("/audience/membershipDescription", values.membership === "限" ? (values.membershipDescription ?? draft.audience.membershipDescription) : ""));
      }
      break;
    }
    case "operations": {
      const values = answer.values;
      if (values.concessionRate !== undefined) ops.push(replace("/operations/concessionRate", confirmed(values.concessionRate)));
      if (values.collectionRate !== undefined) ops.push(replace("/operations/collectionRate", confirmed(values.collectionRate)));
      if (values.paymentRestricted !== undefined) ops.push(replace("/operations/paymentRestricted", confirmed(values.paymentRestricted)));
      break;
    }
    case "brief": {
      const values = answer.values;
      if (values.title !== undefined) ops.push(replace("/title", values.title));
      for (const key of ["externalName", "icsName", "content", "slogan"] as const) {
        if (values[key] !== undefined) ops.push(replace(`/brief/${key}`, values[key]));
      }
      break;
    }
  }
  return ops;
}

function tierText(tier: TierValues): string {
  const discount = tier.discountRate !== null ? `${Number((tier.discountRate * 10).toFixed(2))} 折` : null;
  const off = tier.amountOff !== null ? `减 ${tier.amountOff}` : null;
  return [tier.thresholdAmount !== null ? `满 ${tier.thresholdAmount}` : null, off ?? (discount ? `打 ${discount}` : null)].filter(Boolean).join(" ");
}

export function answerLabel(answer: Answer): string {
  const parts: string[] = [];
  switch (answer.topic) {
    case "action":
      if (answer.values.customerAction) parts.push(`顾客${answer.values.customerAction === "只看到" ? "只需看到" : answer.values.customerAction}才算`);
      if (answer.values.occasion) parts.push(`由头：${answer.values.occasion}`);
      break;
    case "offer":
      if (answer.values.mechanism) parts.push(answer.values.mechanism);
      if (answer.values.tier) parts.push(tierText(answer.values.tier));
      if (answer.values.stacking) parts.push(answer.values.stacking === "是" ? "可以叠加" : "不能叠加");
      break;
    case "scope":
      if (answer.values.level) parts.push(answer.values.level);
      if (answer.values.regionText) parts.push(answer.values.regionText);
      if (answer.values.divisionText) parts.push(answer.values.divisionText);
      if (answer.values.stores) parts.push(`${answer.values.stores.length} 家门店`);
      if (answer.values.markets) parts.push(`市场：${answer.values.markets.join("、")}`);
      if (answer.values.channels) parts.push(`渠道：${answer.values.channels.join("、")}`);
      break;
    case "schedule":
      parts.push(`${answer.values.startDate ?? "开始日期不变"} 至 ${answer.values.endDate ?? "结束日期不变"}`);
      break;
    case "audience_products":
      if (answer.values.segments) parts.push(answer.values.segments.join("、"));
      if (answer.values.categories) parts.push(answer.values.categories.join("、"));
      if (answer.values.membership) parts.push(answer.values.membership === "不限" ? "不限会员" : `限会员${answer.values.membershipDescription ? `：${answer.values.membershipDescription}` : ""}`);
      break;
    case "operations":
      if (answer.values.concessionRate !== undefined) parts.push(`让扣点 ${answer.values.concessionRate}`);
      if (answer.values.collectionRate !== undefined) parts.push(`回款率 ${answer.values.collectionRate}`);
      if (answer.values.paymentRestricted !== undefined) parts.push(answer.values.paymentRestricted ? "支付方式有限制" : "支付方式不限制");
      break;
    case "brief":
      parts.push(`修改${Object.keys(answer.values).length} 处文案`);
      break;
  }
  return parts.join("；") || "已回答";
}
