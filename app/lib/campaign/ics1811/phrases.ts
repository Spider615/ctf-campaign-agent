// 中文说法 → 1811 取值（设计文档 6.3 节）。数值一律由代码从原话片段里算，不采用模型给的数。

// 只去掉千分位里的逗号（3,000、1，000，000）；「减 200，12 月」这种分句的逗号要保留，否则两个数字会粘成一个。
const GROUPED_NUMBER = /(?<![\d.])\d{1,3}(?:[,，]\d{3})+(?!\d)/g;

export function normalizeText(text: string): string {
  return text.replace(GROUPED_NUMBER, (match) => match.replace(/[,，]/g, ""));
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

// 「九五」逐位读成 95；带位的「十五」「三百八」「一千五」按位权读，末尾省掉的单位按上一位的下一级算（三百八 = 380）。
export function chineseNumber(token: string): number | null {
  const [whole, fraction] = token.split("点");
  if (!whole || [...whole].some((char) => !(char in CN_DIGIT) && !(char in CN_UNIT))) return null;
  let value: number;
  if (!/[十百千万]/.test(whole)) {
    value = Number([...whole].map((char) => CN_DIGIT[char]).join(""));
  } else {
    let total = 0;
    let section = 0;
    let digit = 0;
    let lastUnit = 1;
    let afterZero = false;
    for (const char of whole) {
      if (char in CN_DIGIT) {
        if (CN_DIGIT[char] === 0) afterZero = true;
        digit = CN_DIGIT[char];
        continue;
      }
      const unit = CN_UNIT[char];
      if (unit === 10000) {
        total += (section + digit) * unit;
        section = 0;
      } else {
        section += (digit || 1) * unit;
      }
      digit = 0;
      lastUnit = unit;
      afterZero = false;
    }
    value = total + section + (digit && !afterZero && lastUnit >= 10 ? digit * (lastUnit / 10) : digit);
  }
  if (fraction === undefined) return value;
  if (!fraction || [...fraction].some((char) => !(char in CN_DIGIT))) return null;
  return Number(`${value}.${[...fraction].map((char) => CN_DIGIT[char]).join("")}`);
}

// 中文数字后面跟着单位、比较词或非汉字时才当数字读，「一般足金类」「减一次」「一口价」「双十一活动」保持原样。
const CN_NUMBER = /(?<![\d.])[零〇一二两三四五六七八九十百千万]+(?:点[零〇一二三四五六七八九]+)?(?=折|月|日|号|年|元|块|倍|克|件|%|个点|减|送|返|[^\p{Script=Han}]|$)/gu;
const SCALED_NUMBER = /(\d+(?:\.\d+)?)([千百万kKwW])(?=元|块|减|送|返|[^\p{Script=Han}A-Za-z]|$)/gu;
const SCALE: Record<string, number> = { 百: 100, 千: 1000, 万: 10000, k: 1000, K: 1000, w: 10000, W: 10000 };

// 「九五折」→「95折」，「满五千减五百」→「满5000减500」，「5千」→「5000」，「百分之二」→「2%」。
export function digitize(text: string): string {
  return text
    .replace(/百分之([零〇一二两三四五六七八九十点]+|\d+(?:\.\d+)?)/gu, (match, number: string) => {
      const value = /\d/.test(number) ? Number(number) : chineseNumber(number);
      return value === null ? match : `${value}%`;
    })
    .replace(CN_NUMBER, (run) => String(chineseNumber(run) ?? run))
    .replace(SCALED_NUMBER, (_match, number: string, unit: string) => String(Number((Number(number) * SCALE[unit]).toFixed(4))));
}

const compact = (text: string) => digitize(normalizeText(text).replace(/\s+/g, ""));
const round = (value: number) => Number(value.toFixed(4));
const CLAUSE = /[，,；;。！!？?\n]/;

// 「不知道」「待定」不等于「没有」（设计文档 4.4 节）：这类回答一律不记。
const UNSURE = /不知道|不清楚|不确定|待定|没定|未定|没想好|再说|看情况|问一下|问问/;
const FILLER = /^(?:嗯|呃|额|哦|噢|啊|那|就|都|也|全都|全部|两个都|两项都|这个|那个)+/;
const withoutFiller = (text: string) => compact(text).replace(FILLER, "");

// 「9折」→ 0.9，「95折」→ 0.95，「9.5折」→ 0.95。
export function discountValue(token: string): number | null {
  const value = Number(token);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (token.includes(".")) return value < 10 ? round(value / 10) : null;
  if (value < 10) return round(value / 10);
  if (value < 100) return round(value / 100);
  return null;
}

// 纯打折句子里的所有折扣。
export function discountsFrom(text: string): number[] {
  return [...compact(text).matchAll(/(\d+(?:\.\d+)?)折/g)].map((match) => discountValue(match[1])).filter((value): value is number => value !== null);
}

// 「2%」「12个点」→ 小数；不带单位时只认不超过 1 的小数，「让扣点 2」这种说法不猜。
function rateValue(token: string, unit: string | undefined): number | null {
  const value = Number(token);
  if (!Number.isFinite(value) || value < 0) return null;
  if (unit) return round(value / 100);
  return value <= 1 ? value : null;
}

export function ratesFrom(text: string): { concession: number; collection: number } | null {
  const t = compact(text);
  if (UNSURE.test(t) || /还没|没给|没出/.test(t)) return null;
  const concessionMatch = /扣点(?:是|为|填)?(\d+(?:\.\d+)?)(%|个点)?/.exec(t);
  const collectionMatch = /回款率?(?:是|为|填)?(\d+(?:\.\d+)?)(%)?/.exec(t);
  const noConcession = /(没有|没|无|不需要|不涉及|不用|免)[^，,；;。]*扣点|扣点[^，,；;。]*(没有|没|无|为0|是0|填0|不需要|不用)/.test(t);
  const noCollection = /(没有|没|无|不需要|不涉及|不用|免)[^，,；;。]*回款|回款率?[^，,；;。]*(没有|没|无|为0|是0|填0|不需要|不用)/.test(t);
  const concession = concessionMatch ? rateValue(concessionMatch[1], concessionMatch[2]) : noConcession ? 0 : null;
  const collection = collectionMatch ? rateValue(collectionMatch[1], collectionMatch[2]) : noCollection ? 0 : null;
  return concession !== null && collection !== null ? { concession, collection } : null;
}

// 追问让扣点回款率时的整句回答：「都没有」「都是0」「没」。
export function noRatesAnswer(text: string): boolean {
  return /^(没有|没|无|不需要|不用|不涉及|是0|填0|为0|0)的?$/.test(withoutFiller(text).replace(/[。.!！]+$/, ""));
}

export function multipleFrom(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)倍/.exec(compact(text));
  return match ? Number(match[1]) : null;
}

// 铂金、钻石以小换大的开单折扣：优先「开单 9 折」，否则取句中第一个折扣。
export function billingDiscountFrom(text: string): number | null {
  const t = compact(text);
  const explicit = /开单(?:打)?(\d+(?:\.\d+)?)折/.exec(t);
  if (explicit) return discountValue(explicit[1]);
  return discountsFrom(t)[0] ?? null;
}

export function thresholdsFrom(text: string): Array<{ threshold: number; amount: number; every: boolean }> {
  return [...compact(text).matchAll(/(每)?满(\d+(?:\.\d+)?)[元块]?(?:都|就|立|即|可|再)?减(\d+(?:\.\d+)?)/g)].map((match) => ({
    threshold: Number(match[2]),
    amount: Number(match[3]),
    every: Boolean(match[1]),
  }));
}

// 「每克减15元」「每克便宜20块」「克减20」「一克优惠20」
export function perGramAmountFrom(text: string): number | null {
  const match = /(?:每|1)整?克(?:黄金|足金|金价)?(?:立|就|可|直接|能)?(?:减|便宜|优惠|少|让利?)(\d+(?:\.\d+)?)|克减(\d+(?:\.\d+)?)/.exec(compact(text));
  return match ? Number(match[1] ?? match[2]) : null;
}

// 黄金以旧换新：每个分句里配对「换大 N%」和「工费 M 折 / 免工费」。
export function goldTiersFrom(text: string): Array<{ upgradeRatio: number; discount: number | null }> {
  return compact(text).split(CLAUSE).flatMap((clause) => {
    const ratio = /换大(\d+(?:\.\d+)?)%/.exec(clause);
    if (!ratio) return [];
    const labor = /工费(?:打)?(\d+(?:\.\d+)?)折/.exec(clause);
    const discount = /免工费/.test(clause) ? 0 : labor ? discountValue(labor[1]) : null;
    return [{ upgradeRatio: round(Number(ratio[1]) / 100), discount }];
  });
}

// 买钻石享黄金克减：钻石的开单折扣（不打折 = 1）和黄金每克减多少。
export function diamondGoldFrom(text: string): { discount: number | null; amount: number | null } {
  const t = compact(text);
  const noDiscount = /钻石(?:本身)?(?:不打折|不折扣|原价)/.test(t);
  const discountMatch = /钻石[^，,；;。]*?(\d+(?:\.\d+)?)折/.exec(t);
  return { discount: noDiscount ? 1 : discountMatch ? discountValue(discountMatch[1]) : null, amount: perGramAmountFrom(t) };
}

export function thresholdRepeatFrom(text: string): "once" | "every" | null {
  const t = compact(text);
  if (/上不封顶/.test(t)) return "every";
  if (/只减一次|仅减一次|不累加|封顶/.test(t)) return "once";
  if (/每满|累加|减两次/.test(t)) return "every";
  return null;
}

export function gramBasisFrom(text: string): "actual" | "whole" | null {
  const t = compact(text);
  if (/整克|整数克/.test(t)) return "whole";
  if (/实际克重|按克重|实际重量/.test(t)) return "actual";
  return null;
}

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7 };

// 「每周二」→ [2]；「周三周四」「每周三四」→ [3, 4]；周日 = 7。
export function weekdaysFrom(text: string): number[] | null {
  const days = [...compact(text).matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7]+)/g)].flatMap((match) => [...match[1]].map((char) => WEEKDAY[char]));
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

// 提成口径：只出现「折上折」「可叠加」不算回答（§9(二)5）。「售价」「卖的价」都指实际售价。
export function commissionFrom(text: string, questionOpen = false): "actual_price" | "price_times_discount" | null {
  const t = compact(text);
  if (UNSURE.test(t)) return null;
  if (!/提成|实际售价/.test(t) && !questionOpen) return null;
  if (/[×xX*]折扣|乘(?:以)?折扣|折后价|打折后|折扣后/.test(t)) return "price_times_discount";
  return /实际售价|售价(?!类型|固定)|卖价|卖的价|实际价格/.test(t) ? "actual_price" : null;
}

// 纯打折时门店能不能在折扣基础上改价（Q3b）。「改成 9 折」是在改折扣，不算回答。
export function discountEditableFrom(text: string): boolean | null {
  const t = compact(text);
  if (UNSURE.test(t)) return null;
  if (/(不能|不可以|不允许|不许|不可|不让|别)[^，,；;。]*(改价|调价|少打|改(?![成为到]))|用固定|固定/.test(t)) return false;
  if (/(可以|能|允许|让)[^，,；;。]*(改价|调价|少打)|门店(?:可以|能|允许)(?:再|自己)?改(?![成为到])|基础上(?:可以|能)?(?:再)?改(?![成为到])|浮动/.test(t)) return true;
  return null;
}

// 很短的是 / 否回答，只在对应问题正在问时使用。
export function yesNo(text: string): boolean | null {
  const t = withoutFiller(text);
  if (!t || UNSURE.test(t)) return null;
  if (/^(没错|没问题)/.test(t)) return true;
  if (/^(不|没|无|否|还没|暂无|尚未|未|别)/.test(t)) return false;
  if (/^(可以|能|要|是|有|行|好|对|确认|已确认|法务确认|需要|转|ok)/i.test(t)) return true;
  return null;
}

export function legalConfirmedFrom(text: string): boolean | null {
  const t = compact(text);
  if (/法务[^，,；;。]*(没|未|还没|尚未|不)|(没|未|还没|尚未)[^，,；;。]*法务/.test(t)) return false;
  if (/法务[^，,；;。]*(确认过|已确认|确认了|审过|审核过|通过|过了)/.test(t)) return true;
  return null;
}

export type SloganParse = { wanted: false } | { wanted: true; text: string | null; legalConfirmed: boolean | null };

export function sloganFrom(text: string): SloganParse | null {
  const raw = text.trim();
  if (/(不加|不要|不用|没有|无需|不需要|不设)[^，,；;。]*标语|标语[^，,；;。]*(不加|不要|不用|没有|不需要)/.test(raw)) return { wanted: false };
  const match = /标语(?:用|是|为|写|定为)?\s*[:：]?\s*["“「『]?([^"”」』。\n，,；;]+)/.exec(raw);
  if (!match) return null;
  return { wanted: true, text: match[1].trim() || null, legalConfirmed: legalConfirmedFrom(raw) };
}

export function settlementLetterFrom(text: string): boolean | null {
  const t = compact(text);
  if (!/说明函/.test(t) || UNSURE.test(t)) return null;
  return !/没有|无|不需要|不用|还没/.test(t);
}

export function menuConversionFrom(text: string): boolean | null {
  const t = compact(text);
  if (!/餐牌/.test(t)) return null;
  if (/不转|不要转|不用转|不需要转/.test(t)) return false;
  return /转/.test(t) ? true : null;
}

export function onlineFrom(text: string): boolean | null {
  const t = compact(text);
  if (/线上|电商|天猫|京东|小程序|直播间/.test(t)) return true;
  if (/线下/.test(t)) return false;
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type DateParts = { year1?: string; month1: string; day1: string; nextYear?: boolean; year2?: string; month2?: string; day2: string };

// 没写年份时取 today 之后最近的日期；结束日期早于开始日期（或说了「明年」）时顺延一年。
function rangeOf(parts: DateParts, today: string): { start: string; end: string } | null {
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const month1 = +parts.month1;
  const day1 = +parts.day1;
  const year1 = parts.year1 ? +parts.year1 : month1 < todayMonth || (month1 === todayMonth && day1 < todayDay) ? todayYear + 1 : todayYear;
  const month2 = parts.month2 ? +parts.month2 : month1;
  const day2 = +parts.day2;
  const year2 = parts.year2 ? +parts.year2 : parts.nextYear || month2 < month1 || (month2 === month1 && day2 < day1) ? year1 + 1 : year1;
  const start = isoDate(year1, month1, day1);
  const end = isoDate(year2, month2, day2);
  return start && end ? { start, end } : null;
}

const TO = "(?:开始|起)?(?:到|至|~|～|—|–|-)";

// 「2027年5月1日到5月5日」「5月4号到10号」「十月八号到十五号」「10.8-10.15」「12月25日到明年1月3日」
export function dateRangeFrom(text: string, today: string): { start: string; end: string } | null {
  const t = compact(text);
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})(?:到|至|~|～|—)(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (iso) {
    const start = isoDate(+iso[1], +iso[2], +iso[3]);
    const end = isoDate(+iso[4], +iso[5], +iso[6]);
    return start && end ? { start, end } : null;
  }
  const written = new RegExp(`(?:(\\d{4})年)?(\\d{1,2})月(\\d{1,2})[日号]?${TO}(?:(明年|次年)|(\\d{4})年)?(?:(\\d{1,2})月)?(\\d{1,2})[日号]?`).exec(t);
  if (written) {
    return rangeOf({ year1: written[1], month1: written[2], day1: written[3], nextYear: Boolean(written[4]), year2: written[5], month2: written[6], day2: written[7] }, today);
  }
  const dotted = new RegExp(`(?:(\\d{4})[./])?(\\d{1,2})[./](\\d{1,2})[日号]?${TO}(?:(\\d{4})[./])?(?:(\\d{1,2})[./])?(\\d{1,2})(?![\\d.])`).exec(t);
  if (dotted) {
    return rangeOf({ year1: dotted[1], month1: dotted[2], day1: dotted[3], year2: dotted[4], month2: dotted[5], day2: dotted[6] }, today);
  }
  return null;
}
