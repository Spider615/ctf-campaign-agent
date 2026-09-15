import type { ClarifyOptions } from "../campaign/clarify.ts";
import { parseInterpretation, type InterpretationResult } from "./ai-schemas.ts";

export type ClarificationResult = InterpretationResult & {
  sufficient: boolean;
  ask: string[];
  options: ClarifyOptions;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function optionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 12 && !/岁|男性|女性/.test(item));
  return [...new Set(items)].slice(0, 5);
}

// 第一句话理解的结果，外加模型对「要不要追问、问哪些、给哪些候选」的判断。
export function parseClarification(text: string, userText: string): ClarificationResult {
  const base = parseInterpretation(text, userText);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const options = isRecord(parsed.options) ? parsed.options : {};
  return {
    ...base,
    sufficient: parsed.sufficient === true,
    ask: Array.isArray(parsed.ask) ? parsed.ask.filter((item): item is string => typeof item === "string") : [],
    options: { segments: optionList(options.segments), series: optionList(options.series) },
  };
}
