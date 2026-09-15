import { answerToOps } from "../campaign/answers.ts";
import {
  collectNumbers,
  dateEvidenced,
  hasKeyword,
  KEYWORDS,
  mechanismEvidenced,
  normalizeText,
  numberAppearsInText,
  regionEvidenced,
  SCALED_NUMBER_KEYS,
  stripParenthetical,
  valuesEvidenced,
} from "../campaign/evidence.ts";
import { includesOption, LEVEL_OPTIONS, pathSpec, type FieldKey, type PathSpec } from "../campaign/topics.ts";
import type { CampaignDraft, PatchOperation } from "../campaign/types.ts";

export type InterpretationFields = {
  occasion?: string;
  reason?: string;
  customerAction?: string;
  audience?: string[];
  productCategories?: string[];
  offerMechanism?: string;
  thresholdAmount?: number;
  discountRate?: number;
  amountOff?: number;
  scopeLevel?: string;
  region?: string;
  divisionText?: string;
  stores?: Array<{ code: string; name: string }>;
  markets?: string[];
  channels?: string[];
  stacking?: string;
  membership?: string;
  membershipDescription?: string;
  concessionRate?: number;
  collectionRate?: number;
  paymentRestricted?: boolean;
  startDate?: string;
  endDate?: string;
};

export type InterpretationResult = {
  summary: string;
  fields: InterpretationFields;
  unresolved: string[];
};

export type GeneratedCopy = {
  externalName: string;
  icsName: string;
  content: string;
  slogan: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function objectFromJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("模型没有返回有效 JSON");
  }
  if (!isRecord(parsed)) throw new Error("模型返回结构不正确");
  return parsed;
}

function sanitizeFields(raw: Record<string, unknown>): InterpretationFields {
  const text = (key: string) => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined);
  const number = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined);
  const texts = (key: string) => (Array.isArray(raw[key])
    ? (raw[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : undefined);
  const fields: InterpretationFields = {
    occasion: text("occasion"),
    reason: text("reason"),
    customerAction: text("customerAction"),
    audience: texts("audience"),
    productCategories: texts("productCategories"),
    offerMechanism: text("offerMechanism"),
    thresholdAmount: number("thresholdAmount"),
    discountRate: number("discountRate"),
    amountOff: number("amountOff"),
    scopeLevel: text("scopeLevel"),
    region: text("region"),
    divisionText: text("divisionText"),
    stores: Array.isArray(raw.stores)
      ? raw.stores.filter(isRecord).map((store) => ({ code: String(store.code ?? "").trim(), name: String(store.name ?? "").trim() })).filter((store) => store.code && store.name)
      : undefined,
    markets: texts("markets"),
    channels: texts("channels"),
    stacking: text("stacking"),
    membership: text("membership"),
    membershipDescription: text("membershipDescription"),
    concessionRate: number("concessionRate"),
    collectionRate: number("collectionRate"),
    paymentRestricted: typeof raw.paymentRestricted === "boolean" ? raw.paymentRestricted : undefined,
    startDate: text("startDate"),
    endDate: text("endDate"),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as InterpretationFields;
}

export function parseInterpretation(text: string, userText: string): InterpretationResult {
  const parsed = objectFromJson(text);
  if (!isRecord(parsed.fields)) throw new Error("模型返回字段不正确");
  const fields = sanitizeFields(parsed.fields);
  // 数字只认用户原话；原话里没有的数字直接丢掉，由 Agent 追问。
  for (const key of ["thresholdAmount", "discountRate", "amountOff", "concessionRate", "collectionRate"] as const) {
    const value = fields[key];
    if (typeof value === "number" && !numberAppearsInText(value, userText, SCALED_NUMBER_KEYS.has(key))) delete fields[key];
  }
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    fields,
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
  };
}

const generatedCopyKeys = new Set(["externalName", "icsName", "content", "slogan"]);

export function parseGeneratedCopy(text: string): GeneratedCopy {
  const parsed = objectFromJson(text);
  if (Object.keys(parsed).some((key) => !generatedCopyKeys.has(key))) {
    throw new Error("模型返回了不允许生成的字段");
  }
  for (const key of generatedCopyKeys) {
    if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error("模型文案字段不完整");
  }
  return {
    externalName: (parsed.externalName as string).trim(),
    icsName: (parsed.icsName as string).trim(),
    content: (parsed.content as string).trim(),
    slogan: (parsed.slogan as string).trim(),
  };
}

const deniedPatchTerms = ["code", "memberLevel", "paymentMethod", "brandCode", "categoryCode", "approvalFlow"];

export function parsePatchProposal(text: string, instruction: string): PatchOperation[] {
  const parsed = objectFromJson(text);
  if (!Array.isArray(parsed.ops)) throw new Error("模型补丁结构不正确");
  return parsed.ops.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("模型补丁结构不正确");
    const path = candidate.path;
    if (typeof path !== "string" || deniedPatchTerms.some((term) => path.toLowerCase().includes(term.toLowerCase()))) {
      throw new Error("模型补丁包含内部码表字段");
    }
    if (candidate.op !== "add" && candidate.op !== "replace" && candidate.op !== "remove") throw new Error("模型补丁操作不支持");
    if (/discountRate|amountOff|thresholdAmount|concessionRate|collectionRate/u.test(path)) {
      if (typeof candidate.value !== "number" || !numberAppearsInText(candidate.value, instruction, true)) {
        throw new Error("补丁中的数值必须来自用户原话");
      }
    }
    return {
      op: candidate.op,
      path,
      value: candidate.value,
      reason: typeof candidate.reason === "string" ? candidate.reason : "按用户要求修改",
      provenance: "ai",
    };
  });
}

export type TextTurnGuard = {
  ops: PatchOperation[];
  dropped: string[];
  undecided: string[];
  reply: string | null;
};

const PATH_FIELD: Record<string, FieldKey> = {
  "/intent/customerAction": "customerAction",
  "/intent/occasion": "occasion",
  "/offer/mechanism": "mechanism",
  "/offer/stacking": "stacking",
  "/scope/level": "level",
  "/scope/regionCode": "scopeCode",
  "/scope/divisionCode": "scopeCode",
  "/scope/markets": "markets",
  "/scope/channels": "channels",
  "/schedule/batches/0/startDate": "dates",
  "/schedule/batches/0/endDate": "dates",
  "/audience/segments": "segments",
  "/products/categories": "categories",
  "/audience/membership": "membership",
  "/audience/membershipDescription": "membership",
  "/operations/concessionRate": "rates",
  "/operations/collectionRate": "rates",
  "/operations/paymentRestricted": "paymentRestricted",
};

function validKind(spec: PathSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "enum":
      return includesOption(spec.options ?? [], value);
    case "enumArray":
      return Array.isArray(value) && value.length > 0 && value.every((item) => includesOption(spec.options ?? [], item));
    case "textArray":
      return Array.isArray(value) && value.length > 0 && value.length <= 8 &&
        value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 30 && !/岁|男性|女性/.test(item));
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case "text":
      return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
  }
}

// 没被当前卡片直接问到的字段，要求原话里有依据。
function evidenceProvenance(path: string, value: unknown, text: string): "user" | "ai" | "drop" {
  const normalized = normalizeText(text);
  switch (path) {
    case "/intent/customerAction":
      return text.includes(String(value)) || (value === "下单" && /满\s*\d|\d\s*折|减\s*\d/.test(normalized)) ? "user" : "drop";
    case "/intent/occasion":
      return text.includes(String(value)) ? "user" : "ai";
    case "/offer/mechanism":
      return mechanismEvidenced(String(value), text) ? "user" : "drop";
    case "/offer/stacking":
      return hasKeyword(text, KEYWORDS.stacking) ? "user" : "drop";
    case "/scope/level":
      if (value === "全国") return text.includes("全国") ? "user" : "drop";
      if (value === "电商平台") return /电商|天猫|京东/.test(text) ? "user" : "drop";
      if (value === "分区") return text.includes("分区") ? "user" : "drop";
      if (value === "指定门店") return text.includes("门店") ? "user" : "drop";
      return text.includes("区") ? "user" : "drop";
    case "/scope/regionCode":
    case "/scope/divisionCode":
      return regionEvidenced(String(value), text) ? "user" : "drop";
    case "/scope/markets":
    case "/scope/channels":
    case "/products/categories":
      return valuesEvidenced(value as string[], text) ? "user" : "drop";
    case "/audience/segments":
      return (value as string[]).every((item) => text.includes(item)) ? "user" : "ai";
    case "/audience/membership":
      return hasKeyword(text, KEYWORDS.membership) ? "user" : "drop";
    case "/operations/concessionRate":
      return hasKeyword(text, KEYWORDS.concessionRate) ? "user" : "drop";
    case "/operations/collectionRate":
      return hasKeyword(text, KEYWORDS.collectionRate) ? "user" : "drop";
    case "/operations/paymentRestricted":
      return hasKeyword(text, KEYWORDS.paymentRestricted) ? "user" : "drop";
    default:
      return "user";
  }
}

function sanitizeReply(reply: unknown): string | null {
  if (typeof reply !== "string" || !reply.trim()) return null;
  const trimmed = reply.trim().slice(0, 300);
  if (/\d+\)/.test(trimmed) || /(提升|增长|增加)[^。，,]{0,6}\d+(?:\.\d+)?\s*%/.test(trimmed)) return null;
  return trimmed;
}

const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const SCOPE_PATHS = new Set(["/scope/level", "/scope/regionCode", "/scope/divisionCode"]);

export function guardTextTurn(
  content: string,
  context: { draft: CampaignDraft; userText: string; openFields: FieldKey[]; trustedFields?: FieldKey[] },
): TextTurnGuard {
  const parsed = objectFromJson(content);
  const rawOps = Array.isArray(parsed.ops) ? parsed.ops : [];
  const text = context.userText;
  const ops: PatchOperation[] = [];
  const dropped: string[] = [];
  const undecided: string[] = [];
  let tierCount = context.draft.offer.tiers.length;

  // 卡片只问一项时，用户这句话就是在回答它；数字类字段另有数字守卫，可以放宽到卡片上的所有数字项。
  // trustedFields：用户在某一项的「其他」框里写的内容，本来就是在回答这一项。日期始终要核对原话。
  const exempt = (field: FieldKey | undefined) =>
    field !== undefined && field !== "dates" && (
      (context.trustedFields?.includes(field) ?? false) ||
      (context.openFields.includes(field) && (context.openFields.length === 1 || field === "rates" || field === "tier"))
    );

  for (const candidate of rawOps) {
    if (!isRecord(candidate) || typeof candidate.path !== "string") continue;
    const { path, value } = candidate;
    const reason = typeof candidate.reason === "string" ? candidate.reason : "按用户要求修改";

    const tierLeaf = /^\/offer\/tiers\/(\d+)\/(thresholdAmount|discountRate|amountOff)$/.exec(path);
    if (tierLeaf) {
      const index = Number(tierLeaf[1]);
      const ok = candidate.op === "replace" && index < tierCount && (value === null || typeof value === "number") &&
        (typeof value !== "number" || numberAppearsInText(value, text, SCALED_NUMBER_KEYS.has(tierLeaf[2])));
      if (ok) ops.push({ op: "replace", path, value, reason, provenance: "user" });
      else dropped.push("优惠力度");
      continue;
    }

    const tierWhole = /^\/offer\/tiers\/(\d+)$/.exec(path);
    if (tierWhole) {
      const index = Number(tierWhole[1]);
      if (candidate.op === "add" && index === tierCount && isRecord(value)) {
        const tier = { thresholdAmount: numberOrNull(value.thresholdAmount), discountRate: numberOrNull(value.discountRate), amountOff: numberOrNull(value.amountOff) };
        const numbersOk = collectNumbers(tier).length > 0 &&
          (tier.thresholdAmount === null || numberAppearsInText(tier.thresholdAmount, text)) &&
          (tier.amountOff === null || numberAppearsInText(tier.amountOff, text)) &&
          (tier.discountRate === null || numberAppearsInText(tier.discountRate, text, true));
        if (numbersOk) {
          ops.push({ op: "add", path, value: { id: `tier-${index + 1}`, label: "", thresholdCount: null, judgingWeight: null, ...tier }, reason, provenance: "user" });
          tierCount += 1;
          continue;
        }
      }
      if (candidate.op === "remove" && index >= 1 && index < tierCount) {
        ops.push({ op: "remove", path, reason, provenance: "user" });
        tierCount -= 1;
        continue;
      }
      dropped.push("优惠力度");
      continue;
    }

    const spec = pathSpec(path);
    if (!spec || candidate.op !== "replace") continue;
    if (value === "还没定") {
      undecided.push(spec.label);
      continue;
    }
    const numberKey = path.split("/").at(-1) ?? "";
    if (!validKind(spec, value) || (spec.kind === "number" && !numberAppearsInText(value as number, text, SCALED_NUMBER_KEYS.has(numberKey)))) {
      dropped.push(spec.label);
      continue;
    }
    // 日期无论是不是当前在问，都必须在原话里写出月和日。
    if (spec.kind === "date" && !dateEvidenced(String(value), text)) {
      dropped.push(spec.label);
      continue;
    }
    let provenance: "user" | "ai" = "user";
    if (spec.topic !== "brief" && !exempt(PATH_FIELD[path])) {
      const judged = evidenceProvenance(path, value, text);
      if (judged === "drop") {
        dropped.push(spec.label);
        continue;
      }
      provenance = judged;
    }
    ops.push({
      op: "replace",
      path,
      value: spec.fieldValue ? { value, provenance } : value,
      reason,
      provenance: spec.topic === "brief" ? "ai" : "user",
    });
  }

  // 范围层级与区域、分区统一走选项回答的清空规则，避免区域、分区、门店同时有值。
  const scopeOps = ops.filter((op) => SCOPE_PATHS.has(op.path));
  if (scopeOps.length) {
    const levelOp = scopeOps.find((op) => op.path === "/scope/level");
    const regionOp = scopeOps.find((op) => op.path === "/scope/regionCode");
    const divisionOp = scopeOps.find((op) => op.path === "/scope/divisionCode");
    const levelValue = (levelOp?.value as { value?: unknown } | undefined)?.value;
    const level = includesOption(LEVEL_OPTIONS, levelValue) ? levelValue : regionOp ? "区域" : divisionOp ? "分区" : context.draft.scope.level.value;
    const normalizedOps = answerToOps({
      topic: "scope",
      values: {
        level,
        regionText: regionOp ? stripParenthetical(String(regionOp.value)) : undefined,
        divisionText: divisionOp ? stripParenthetical(String(divisionOp.value)) : undefined,
      },
    }, context.draft);
    ops.splice(0, ops.length, ...ops.filter((op) => !SCOPE_PATHS.has(op.path)), ...normalizedOps);
  }

  return { ops, dropped: [...new Set(dropped)], undecided: [...new Set(undecided)], reply: sanitizeReply(parsed.reply) };
}

export type TurnIntent = "edit" | "generate" | "confirm" | "undo" | "question" | "other";
const TURN_INTENTS: readonly TurnIntent[] = ["edit", "generate", "confirm", "undo", "question", "other"];

// 模型判断的用户意图；解析不出来时，有改动算修改，否则算其他。
export function parseTurnIntent(content: string, hasOps: boolean): TurnIntent {
  try {
    const parsed = JSON.parse(content) as { intent?: unknown };
    if (includesOption(TURN_INTENTS, parsed.intent)) return parsed.intent;
  } catch {
    // 非法 JSON 按默认处理。
  }
  return hasOps ? "edit" : "other";
}
