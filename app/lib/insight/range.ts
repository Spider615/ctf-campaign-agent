// 深度剖析的时间范围：解析、校验、节日预设、URL 读写。纯函数，Agent 和页面共用。
// 设计见 docs/superpowers/specs/2026-11-07-insight-date-range-design.md。

export type InsightRange = { from: string; to: string };
export type InsightFestival = { name: string; from: string; to: string };
// 短于 3 天时门店、活动的比较大多没有意义，不重算。
export const MIN_RANGE_DAYS = 3;

const DAY_MS = 86400000;
const toTime = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
// 8 位且是真实存在的日期（20250231 不算）。
const isDay = (d: string) => {
  if (!/^\d{8}$/.test(d)) return false;
  const t = new Date(toTime(d));
  return t.getUTCFullYear() === Number(d.slice(0, 4)) && t.getUTCMonth() + 1 === Number(d.slice(4, 6)) && t.getUTCDate() === Number(d.slice(6, 8));
};
const short = (d: string) => `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`;

export const rangeDays = (range: InsightRange) => Math.round((toTime(range.to) - toTime(range.from)) / DAY_MS) + 1;
export const rangeLabel = (range: InsightRange) => `${short(range.from)}–${short(range.to)}`;

export function parseRangeParams(from: string | null, to: string | null): InsightRange | null {
  const f = from?.trim() ?? ""; const t = to?.trim() ?? "";
  if (!f && !t) return null;
  if (!f || !t) throw new Error("起止日期要一起给");
  if (!isDay(f) || !isDay(t)) throw new Error("日期格式不正确，应为 8 位日期，例如 20250823");
  if (f > t) throw new Error("开始日期不能晚于结束日期");
  return { from: f, to: t };
}

export function checkRange(range: InsightRange, dataFrom: string, dataTo: string): void {
  if (range.from < dataFrom || range.to > dataTo) throw new Error(`超出数据范围（${short(dataFrom)}–${short(dataTo)}）`);
  if (rangeDays(range) < MIN_RANGE_DAYS) throw new Error(`范围太短，至少选 ${MIN_RANGE_DAYS} 天`);
}

export const isFullRange = (range: InsightRange | null, dataFrom: string, dataTo: string) => !range || (range.from === dataFrom && range.to === dataTo);

export function festivalsOf(days: ReadonlyArray<{ day: string; festival: string | null }>): InsightFestival[] {
  const by = new Map<string, InsightFestival>();
  for (const d of days) {
    if (!d.festival) continue;
    const name = d.festival.replace(/节$/, "") || d.festival;
    const f = by.get(name);
    by.set(name, f ? { name, from: d.day < f.from ? d.day : f.from, to: d.day > f.to ? d.day : f.to } : { name, from: d.day, to: d.day });
  }
  return [...by.values()].sort((a, b) => a.from.localeCompare(b.from));
}

export const rangeSearch = (range: InsightRange | null) => range ? `from=${range.from}&to=${range.to}` : "";

export function rangeFromSearch(search: string): InsightRange | null {
  const params = new URLSearchParams(search);
  try { return parseRangeParams(params.get("from"), params.get("to")); } catch { return null; }
}

// 页面自定义起止的校验：合格返回空字符串，否则返回控件旁显示的原因。空日期（清空了日期框）单独提示。
export function rangeDraftError(from: string, to: string, dataFrom: string, dataTo: string): string {
  if (!from.trim() || !to.trim()) return "请选择开始和结束日期";
  try {
    const range = parseRangeParams(from, to);
    if (range) checkRange(range, dataFrom, dataTo);
    return "";
  } catch (caught) { return caught instanceof Error ? caught.message : "日期不正确"; }
}
