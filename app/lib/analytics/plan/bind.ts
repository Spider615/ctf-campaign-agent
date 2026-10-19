import type { AnalysisFact } from "../analysis-v2-types.ts";
import { ANALYSIS_FILTER_DIMENSIONS, SEMANTIC_DIMENSIONS, SEMANTIC_METRICS } from "../semantic/model.ts";
import type { NodeResult, NodeRole, NodeRow } from "./execute.ts";
import type { PlanNode, PlanScope } from "./types.ts";

// 计划答案的数字工具：正文引用解析（refs.ts）和答案组装（answer.ts）共用。
const DIRECTIONAL: NodeRole[] = ["delta", "change", "deviation"];
// 措辞里允许出现的数字只来自原话和业务名称，其余数字一律当作算出来的值拒绝：
// - 业务名称（维度取值、计划筛选值，如「H-克减30元」「东区/B区」）整段出现时，先从措辞里抹掉再检查；
// - 问题原文里的日期和时长（2025年、8月23日、7天）原样出现可以保留。
// 所以「克减30元档」可以写，「高了30元」不行。
const TIME_TOKEN = /\d+(?:\.\d+)?\s*(?:年|月|日|号|天|周)/g;
// 返回正文里不被允许的数字片段；为空表示可以通过。片段原样回给模型，便于它知道改哪里。
export function digitGuard(literals: readonly string[], names: readonly string[] = []): (text: string) => string[] {
  const allowedTimes = new Set((literals.join("\n").normalize("NFKC").match(TIME_TOKEN) ?? []).map((token) => token.replace(/\s+/g, "")));
  // 名称按长度降序抹掉，避免短名称先截断长名称。
  // 同时接受去掉编号前缀的简称：「H-克减30元」也可写作「克减30元」。
  const variants = names.flatMap((name) => { const full = name.normalize("NFKC"); return [full, ...full.split(/[-－]/).slice(1).map((part) => part.trim()).filter((part) => part.length >= 3)]; });
  const known = [...new Set(variants.filter((name) => /\d/.test(name)))].sort((a, b) => b.length - a.length);
  // 简称：数字连同前面两个字原样出现在业务名称或问题原文里（「克减50档」里的「克减50」），也按名称处理。
  // 档位简称：「50元档」里的「50元」原样出现在业务名称或原文里（「H-克减50元」）时按名称处理；「高50元」仍算算出来的数。
  // 名称比较不区分大小写（价位段写作 30K-50K，措辞里常写 30k-50k）。
  const nameText = [...known, ...literals].join("\n").normalize("NFKC").toLowerCase();
  return (raw: string) => {
    let text = raw.normalize("NFKC");
    const lower = text.toLowerCase();
    for (const name of known) { const target = name.toLowerCase(); let at = lower.indexOf(target); while (at >= 0) { text = text.slice(0, at) + " ".repeat(name.length) + text.slice(at + name.length); at = lower.indexOf(target, at + name.length); } }
    // 「50元档」「50档」：数字（连同单位）出现在业务名称或原文里时是档位简称。
    text = text.replace(/(\d+(?:\.\d+)?)([^\d\s{}]?)(?=档)/g, (token, number: string, unit: string) => nameText.includes(`${number}${unit || "元"}`.toLowerCase()) || unit && nameText.includes(token.toLowerCase()) ? " " : token);
    text = text.replace(TIME_TOKEN, (token) => allowedTimes.has(token.replace(/\s+/g, "")) ? " " : token);
    text = text.replace(/([^\d\s{}]{2})(\d+(?:\.\d+)?)/g, (token, prefix: string) => /^[\p{L}]{2}$/u.test(prefix) && nameText.includes(token) ? `${prefix} ` : token);
    return [...new Set(text.match(/\d+(?:[.,]\d+)*\s*(?:%|个百分点|[^\s\d{}，。；、（）()]?)/g) ?? [])].map((item) => item.trim());
  };
}

// 与出处面板一致的显示规则；计划式答案的数字格式只在这里定义。
export function displayUnit(unit: string): string {
  return /^(?:CNY|人民币|RMB)(?:(?:\/|每).+)?$/.test(unit) ? unit.replace(/^(?:CNY|人民币|RMB)/, "元").replace("每", "/")
    : unit === "百分比" || unit === "％" ? "%" : unit === "百分点" ? "个百分点" : unit === "unknown" ? "（单位待核对）" : unit;
}

export function formatValue(fact: AnalysisFact, signed: boolean): string {
  if (fact.value === null) return "暂无可计算值";
  const unit = fact.unit;
  const money = /^(?:CNY|人民币|RMB|元|USD|美元|HKD|港元|EUR|欧元)(?:(?:\/|每).+)?$/.test(unit);
  const perGram = /(?:\/|每)克$/.test(unit);
  const percent = unit === "%" || unit === "％" || unit === "百分比" || unit === "个百分点" || unit === "百分点";
  const min = perGram ? 0 : money || percent ? 2 : 0;
  // 情景假设保留原样；其余观察值最多两位小数，整数仍按整数显示。
  const max = fact.assumption && !fact.scenario ? 12 : 2;
  const rendered = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true }).format(Object.is(fact.value, -0) ? 0 : fact.value);
  // 差额、变化和偏离带明确正负号，读者一眼分得清涨跌。
  const sign = signed && fact.value > 0 && !rendered.startsWith("-") ? "+" : "";
  return `${sign}${rendered}${displayUnit(unit)}`;
}

// 百分比指标（毛利率、折扣率等）的差额是百分点，不是百分比变化，显示时写明。
export function formatRoleValue(fact: AnalysisFact, role: NodeRole): string {
  const text = formatValue(fact, DIRECTIONAL.includes(role));
  return role === "delta" && displayUnit(fact.unit) === "%" ? text.replace(/%$/, "个百分点") : text;
}

// ---- 口径检查 ----
// 两段范围的日历天数不同，或节庆、日类型、日期筛选不同时，覆盖的天数不同，合计值不能直接比较；
// 同样长度的两段（今年八月对去年八月）可以比合计。
const TIME_FILTERS = Object.entries(ANALYSIS_FILTER_DIMENSIONS).filter(([, dimension]) => SEMANTIC_DIMENSIONS[dimension].entity === "time").map(([key]) => key);
const calendarDays = (scope: PlanScope) => Math.round((Date.parse(`${scope.period.end}T00:00:00Z`) - Date.parse(`${scope.period.start}T00:00:00Z`)) / 86400000) + 1;
const timeOf = (scope: PlanScope) => JSON.stringify([calendarDays(scope), ...TIME_FILTERS.map((key) => [...((scope.filters as Record<string, string[] | undefined>)?.[key] ?? [])].sort())]);
const isTotal = (metric: string) => Boolean((SEMANTIC_METRICS as Record<string, { additive?: boolean }>)[metric]?.additive);
// 合计类指标（实收、件数、克重、毛利等）在时间不同的两段之间比较时为真；日均、单均、每店等比率不受影响。
export function totalAcrossWindows(node: PlanNode, metric: string, role: NodeRole): boolean {
  return node.op === "contrast" && timeOf(node.target) !== timeOf(node.reference) && isTotal(metric) && ["target", "reference", "delta", "change"].includes(role);
}
export const TOTAL_ACROSS_WINDOWS = "两段时间天数不同，合计值不能直接比较；请改用日均类指标（如日均实收、日均订单）";

// 计划节点里写到的筛选值和日期，也是用户语境里的业务名称。
// 计划范围里的日期（2025-08-23）也是业务原话的一部分：展开成「2025年」「8月」「8月23日」「23日」这些常见说法，
// 交给 digitGuard 当作允许的时间写法。日期范围之外的月份、年份不放行。
export function periodLiterals(dates: readonly string[]): string[] {
  const out = new Set<string>();
  for (const date of dates) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); if (!match) continue;
    const [year, month, day] = [match[1], String(Number(match[2])), String(Number(match[3]))];
    for (const text of [`${year}年`, `${month}月`, `${day}日`, `${day}号`, `${month}月${day}日`, `${year}年${month}月`, date]) out.add(text);
  }
  return [...out];
}

export function nodeLiterals(node: NodeResult["node"]): string[] {
  const scopes = node.op === "measure" ? [node.scope] : node.op === "contrast" ? [node.target, node.reference] : [];
  return scopes.flatMap((scope) => [scope.period.start, scope.period.end, ...Object.values(scope.filters ?? {}).flat()]);
}

export function defaultRole(result: NodeResult): NodeRole {
  const op = result.node.op;
  // 拆解节点只产出各项贡献，没有 value 行。
  return op === "contrast" ? "delta" : op === "drill" || op === "scan" ? "deviation" : op === "decompose" ? "contribution" : "value";
}

export const sameKey = (row: NodeRow, key: Record<string, string>) => {
  const names = Object.keys(key);
  return Object.keys(row.key).length === names.length && names.every((name) => row.key[name] === key[name]);
};
