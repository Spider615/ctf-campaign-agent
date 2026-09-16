// 明细优惠类型规格（设计文档第 5 节）。支持级别：A 有截图；B 参数栏是推断的；C 提示人工录入；D SOP 明确不支持。

import { digitize, normalizeText } from "./phrases.ts";
import type { OfferPattern, ParamKey } from "./types.ts";

export type SupportLevel = "A" | "B" | "C" | "D";

export type ParamSpec = { key: ParamKey; label: string };

export type OfferTypeSpec = {
  name: string;
  pageLabel: string;
  params: ParamSpec[];
  support: SupportLevel;
  group: "3" | "17" | "19";
  fixedCategories?: string[];
  fixedHeadCodes?: string[];
  sop: string;
};

const billing: ParamSpec = { key: "billingDiscount", label: "开单折扣" };
const offerAmount: ParamSpec = { key: "offerAmount", label: "优惠金额" };
const judgeAmount: ParamSpec = { key: "judgeAmount", label: "判断金额" };
const upgradeRatio: ParamSpec = { key: "upgradeRatio", label: "换大比例" };

export const FLOAT_PARAMS: ParamSpec[] = [{ key: "discount", label: "折扣" }];

const spec = (name: string, params: ParamSpec[], support: SupportLevel, group: OfferTypeSpec["group"], sop: string, extra: Partial<OfferTypeSpec> = {}): OfferTypeSpec => ({
  name, pageLabel: name, params, support, group, sop, ...extra,
});

export const OFFER_TYPES: Record<string, OfferTypeSpec> = {
  金价每克减免: spec("金价每克减免", [offerAmount], "A", "3", "§5(四)6；03d/05f"),
  金价每整克减免: spec("金价每整克减免", [offerAmount], "B", "3", "§9(五)", { pageLabel: "金价每整克减免(按单件重量整数优惠)" }),
  黄金工费打折: spec("黄金工费打折", [], "C", "3", "§9(五)"),
  售价固定折扣: spec("售价固定折扣", [billing], "B", "3", "§3(三)3"),
  每满减: spec("每满减", [judgeAmount, offerAmount], "B", "3", "§9(四)"),
  满减: spec("满减", [judgeAmount, offerAmount], "B", "3", "§9(四)"),
  满件折: spec("满件折", [], "C", "3", "§9(五)"),
  每满返: spec("每满返", [], "C", "3", "§9(五)"),
  满折: spec("满折", [], "C", "3", "§9(五)"),
  联单: spec("联单", [], "C", "3", "§9(五)"),
  分克重段每整克优惠: spec("分克重段每整克优惠", [], "D", "3", "§9(四)"),
  铂金换购特殊营销折扣: spec("铂金换购特殊营销折扣", [billing, judgeAmount], "A", "17", "§5(一)2-3；05a", { fixedCategories: ["不适用"], fixedHeadCodes: ["HP"] }),
  钻石以小换大: spec("钻石以小换大", [billing], "A", "17", "§5(二)2-3；05c", { fixedCategories: ["不适用"], fixedHeadCodes: ["HA"] }),
  买钻石享黄金克减: spec("买钻石享黄金克减", [billing], "A", "3", "§5(四)；05e"),
  黄金以旧换新: spec("黄金以旧换新", [upgradeRatio, billing], "A", "19", "§5(三)3-5；05d"),
};

// 满减、克减、以旧换新等只在固定折扣模式下可选（§9(三)）。
export const FIXED_ONLY_PATTERNS: readonly OfferPattern[] = ["threshold", "per_gram", "platinum_tradein", "diamond_upgrade", "gold_tradein", "diamond_gold_gram"];

// 货类固定、不追问 Q4 的玩法（§9(二)4）。
export const FIXED_CATEGORY_PATTERNS: readonly OfferPattern[] = ["platinum_tradein", "diamond_upgrade"];

export type DetectedPattern = { pattern: OfferPattern; unsupportedType: string | null };

// 由代码按原话关键词判定玩法，模型给的类型只作参考（设计文档第 5 节推导规则 1）。顺序有意义：先特殊活动，再不支持的类型，最后是通用玩法。
export function detectPattern(text: string): DetectedPattern | null {
  const t = digitize(normalizeText(text).replace(/\s+/g, ""));
  const unsupported = (type: string): DetectedPattern => ({ pattern: "unsupported", unsupportedType: type });
  if (/分克重|前克|余克/.test(t)) return unsupported("分克重段每整克优惠");
  if (/铂金/.test(t) && /以旧换新|换购/.test(t)) return { pattern: "platinum_tradein", unsupportedType: null };
  if (/以小换大/.test(t)) return { pattern: "diamond_upgrade", unsupportedType: null };
  if (/黄金|足金/.test(t) && /以旧换新/.test(t)) return { pattern: "gold_tradein", unsupportedType: null };
  // 「换大 N%」只出现在黄金以旧换新里；原话片段漏了「黄金以旧换新」时也不能落到「工费打折」
  if (/换大\d+(?:\.\d+)?%/.test(t)) return { pattern: "gold_tradein", unsupportedType: null };
  if (/钻石/.test(t) && /克减|每克|1克/.test(t)) return { pattern: "diamond_gold_gram", unsupportedType: null };
  if (/联单/.test(t)) return unsupported("联单");
  if (/每满[^，。；,;]*返/.test(t)) return unsupported("每满返");
  if (/满\d+件/.test(t)) return unsupported("满件折");
  // 1811 明细优惠类型里没有的玩法（设计文档 4.4 节）
  if (/第2件/.test(t)) return unsupported("第二件优惠");
  if (/买\d+送\d+/.test(t)) return unsupported("买一送一");
  if (/赠品|送礼品/.test(t)) return unsupported("送赠品");
  if (/积分加倍|双倍积分|加倍积分/.test(t)) return unsupported("积分加倍");
  if (/满\d+(?:\.\d+)?[元块]?[^，。；,;减折]*送/.test(t)) return unsupported("满送");
  if (/满\d+(?:\.\d+)?[元块]?[^，。；,;减折]*返/.test(t)) return unsupported("满返");
  if (/满\d+(?:\.\d+)?[元块]?[^，。；,;减]*\d+(?:\.\d+)?折/.test(t)) return unsupported("满折");
  if (/工费[^，。；,;]*折/.test(t)) return unsupported("黄金工费打折");
  if (/满\d+(?:\.\d+)?[元块]?[^，。；,;]*减\d+/.test(t)) return { pattern: "threshold", unsupportedType: null };
  if (/(?:每|1)整?克[^，。；,;]*(?:减|便宜|优惠|少|让利)|克减/.test(t)) return { pattern: "per_gram", unsupportedType: null };
  if (/\d+(?:\.\d+)?折/.test(t)) return { pattern: "discount", unsupportedType: null };
  // 只说了玩法没说力度（「国庆钻石打折」「帮我弄个满减」）：先认下玩法，力度按 Q3a 接着问，
  // 不然 Agent 会反过来问「打折还是满减」，用户明明说过了。「不打折」不算打折。
  if (/满减/.test(t)) return { pattern: "threshold", unsupportedType: null };
  if (/(?<!不)打(?:个|点)?折|折扣活动|做(?:个)?折扣/.test(t)) return { pattern: "discount", unsupportedType: null };
  return null;
}

// 玩法 → 明细优惠类型。pending 表示要等用户回答（Q3b/Q3c/Q3d）才能定。
export function offerTypeFor(
  pattern: OfferPattern,
  answers: { discountEditable: boolean | null; thresholdRepeat: "once" | "every" | null; gramBasis: "actual" | "whole" | null },
): { types: Array<string | null>; float: boolean | null } {
  switch (pattern) {
    case "discount":
      return answers.discountEditable === null ? { types: [null], float: null } : answers.discountEditable ? { types: [null], float: true } : { types: ["售价固定折扣"], float: false };
    case "threshold":
      return { types: [answers.thresholdRepeat === null ? null : answers.thresholdRepeat === "every" ? "每满减" : "满减"], float: false };
    case "per_gram":
      return { types: [answers.gramBasis === null ? null : answers.gramBasis === "actual" ? "金价每克减免" : "金价每整克减免"], float: false };
    case "platinum_tradein":
      return { types: ["铂金换购特殊营销折扣"], float: false };
    case "diamond_upgrade":
      return { types: ["钻石以小换大"], float: false };
    case "gold_tradein":
      return { types: ["黄金以旧换新"], float: false };
    case "diamond_gold_gram":
      return { types: ["买钻石享黄金克减", "金价每克减免"], float: false };
    case "unsupported":
      return { types: [], float: null };
  }
}

// 每种玩法必须由用户给出的参数（Q3a）。
export function missingOfferParams(pattern: OfferPattern, items: readonly { discount: number | null; upgradeRatio: number | null; multiple: number | null; threshold: number | null; amount: number | null }[]): string[] {
  const first = items[0];
  const lacks = (label: string, ok: boolean) => (ok ? [] : [label]);
  switch (pattern) {
    case "discount":
      return lacks("打几折", items.length > 0 && items.every((item) => item.discount !== null));
    case "threshold":
      return [...lacks("满多少", items.length > 0 && items.every((item) => item.threshold !== null)), ...lacks("减多少", items.length > 0 && items.every((item) => item.amount !== null))];
    case "per_gram":
      return lacks("每克减多少", first?.amount != null);
    case "platinum_tradein":
      return [...lacks("换大几倍", first?.multiple != null), ...lacks("开单打几折", first?.discount != null)];
    case "diamond_upgrade":
      return lacks("开单打几折", first?.discount != null);
    case "gold_tradein":
      return lacks("每个换大比例对应的工费折扣", items.length > 0 && items.every((item) => item.upgradeRatio !== null && item.discount !== null));
    case "diamond_gold_gram":
      return [...lacks("钻石本身打几折", first?.discount != null), ...lacks("黄金每克减多少", first?.amount != null)];
    case "unsupported":
      return [];
  }
}

// 参数取值检查（设计文档 V-D03、V-D04）。返回阻断原因；warning 另行处理。
export function paramProblem(typeName: string | null, key: ParamKey, value: number): string | null {
  if (!Number.isFinite(value)) return "不是数字";
  switch (key) {
    case "discount":
      return value > 0 && value <= 1 ? null : "折扣要填 0 到 1 之间的小数，9 折填 0.9";
    case "billingDiscount":
      if (typeName === "黄金以旧换新") return value >= 0 && value <= 1 ? null : "工费折扣要填 0 到 1 之间的小数，免工费填 0";
      return value > 0 && value <= 1 ? null : "开单折扣要填 0 到 1 之间的小数，0 只用于黄金以旧换新的免工费";
    case "upgradeRatio":
    case "judgeAmount":
    case "offerAmount":
      return value > 0 ? null : "要大于 0";
  }
}
