import type { PatchOperation } from "../campaign/types.ts";

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
  region?: string;
  markets?: string[];
  channels?: string[];
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

function objectFromJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("模型没有返回有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型返回结构不正确");
  }
  return parsed as Record<string, unknown>;
}

function numberAppearsInText(value: number, text: string): boolean {
  const normalized = text.replaceAll(",", "").replaceAll("，", "");
  const forms = new Set([String(value), String(value * 10)]);
  return [...forms].some((form) => normalized.includes(form));
}

export function parseInterpretation(text: string, userText: string): InterpretationResult {
  const parsed = objectFromJson(text);
  const fields = parsed.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("模型返回字段不正确");
  const typedFields = fields as InterpretationFields;
  for (const key of ["thresholdAmount", "discountRate", "amountOff"] as const) {
    const value = typedFields[key];
    if (typeof value === "number" && !numberAppearsInText(value, userText)) {
      throw new Error("让利数值必须来自用户原话");
    }
  }
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "已识别活动需求",
    fields: typedFields,
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved.filter((item): item is string => typeof item === "string") : [],
  };
}

const generatedCopyKeys = new Set(["externalName", "icsName", "content", "slogan"]);

export function parseGeneratedCopy(text: string): GeneratedCopy {
  const parsed = objectFromJson(text);
  if (Object.keys(parsed).some((key) => !generatedCopyKeys.has(key))) {
    throw new Error("模型返回了不允许生成的字段");
  }
  for (const key of generatedCopyKeys) {
    if (typeof parsed[key] !== "string") throw new Error("模型文案字段不完整");
  }
  return parsed as GeneratedCopy;
}

const deniedPatchTerms = ["code", "memberLevel", "paymentMethod", "brandCode", "categoryCode", "approvalFlow"];

export function parsePatchProposal(text: string, instruction: string): PatchOperation[] {
  const parsed = objectFromJson(text);
  if (!Array.isArray(parsed.ops)) throw new Error("模型补丁结构不正确");
  return parsed.ops.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("模型补丁结构不正确");
    const item = candidate as Record<string, unknown>;
    const path = item.path;
    if (typeof path !== "string" || deniedPatchTerms.some((term) => path.toLowerCase().includes(term.toLowerCase()))) {
      throw new Error("模型补丁包含内部码表字段");
    }
    if (item.op !== "add" && item.op !== "replace" && item.op !== "remove") throw new Error("模型补丁操作不支持");
    if (/discountRate|amountOff|thresholdAmount|concessionRate|collectionRate/u.test(path)) {
      if (typeof item.value !== "number" || !numberAppearsInText(item.value, instruction)) {
        throw new Error("补丁中的数值必须来自用户原话");
      }
    }
    return {
      op: item.op,
      path,
      value: item.value,
      reason: typeof item.reason === "string" ? item.reason : "按用户要求修改",
      provenance: "ai",
    };
  });
}

