const THOUSANDS_SEPARATOR = /[,，]/g;

export function normalizeText(text: string): string {
  return text.replace(THOUSANDS_SEPARATOR, "");
}

function containsNumberToken(text: string, token: string): boolean {
  const escaped = token.replace(/\./g, "\\.");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(text);
}

const canonical = (value: number) => String(Number(value.toFixed(4)));

// 金额只认原数；折扣率与费率可写成 0.8 / 8 折 / 80%、0.12 / 12 个点（scaled = true）。
export function numberAppearsInText(value: number, text: string, scaled = false): boolean {
  if (!Number.isFinite(value)) return false;
  const normalized = normalizeText(text);
  const forms = scaled ? [...new Set([value, value * 10, value * 100].map(canonical))] : [canonical(value)];
  return forms.some((form) => containsNumberToken(normalized, form));
}

export const SCALED_NUMBER_KEYS = new Set(["discountRate", "concessionRate", "collectionRate"]);

export function collectNumbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(collectNumbers);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectNumbers);
  return [];
}

export const VALUE_EVIDENCE: Record<string, readonly string[]> = {
  内地: ["内地", "大陆"],
  港澳: ["港澳", "香港", "澳门"],
  线下: ["线下"],
  线上: ["线上"],
  黄金类: ["黄金"],
  素金类: ["素金"],
  镶嵌类: ["镶嵌"],
  赠品: ["赠品"],
};

export function valuesEvidenced(values: readonly string[], text: string): boolean {
  return values.length > 0 && values.every((value) => (VALUE_EVIDENCE[value] ?? [value]).some((word) => text.includes(word)));
}

export const KEYWORDS = {
  stacking: ["叠加", "同享", "一起用", "同时用", "折上折"],
  membership: ["会员"],
  paymentRestricted: ["支付", "付款"],
  concessionRate: ["扣点"],
  collectionRate: ["回款"],
} as const;

export function hasKeyword(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function mechanismEvidenced(mechanism: string, text: string): boolean {
  const normalized = normalizeText(text);
  switch (mechanism) {
    case "门槛型":
      return /满\s*\d/.test(normalized);
    case "直接价格":
      return /\d(?:\.\d+)?\s*折/.test(normalized) || /减\s*\d/.test(normalized);
    case "以旧换新换购":
      return /以旧换新|换购/.test(text);
    case "赠品兑换":
      return /赠品|赠送/.test(text);
    case "券核销":
      return /核销/.test(text);
    case "无让利":
      return /无优惠|不打折|无让利/.test(text);
    default:
      return false;
  }
}

export function dateEvidenced(date: string, text: string): boolean {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const normalized = normalizeText(text);
  const appears = (part: string) => containsNumberToken(normalized, String(Number(part))) || containsNumberToken(normalized, part);
  return appears(match[1]) && appears(match[2]);
}

export function stripParenthetical(value: string): string {
  return value.replace(/[（(][^）)]*[）)]/g, "").trim();
}

// 「华东」也算说了「华东区」。
export function regionEvidenced(region: string, text: string): boolean {
  const name = stripParenthetical(region);
  if (!name) return false;
  if (text.includes(name)) return true;
  const core = name.replace(/(大区|区域|地区|区)$/, "");
  return core.length >= 2 && text.includes(core);
}
