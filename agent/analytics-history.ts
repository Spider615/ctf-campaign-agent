import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { sourceStatement } from "../app/lib/analytics/advisor.ts";
import type { AdvisorField, AdvisorSource } from "../app/lib/analytics/types.ts";

const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max = 12): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= 1200);

function readJson(directory: string, relative: string): unknown {
  try {
    const root = realpathSync(directory); const path = realpathSync(resolve(root, relative));
    if (!path.startsWith(`${root}${sep}`) || !statSync(path).isFile() || statSync(path).size > 256 * 1024) throw new Error();
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { throw new Error("历史知识文件不可用或格式不正确，请检查历史目录配置"); }
}

type HistoryCase = { id: string; title: string; period: string[]; population: string; status: string; evidence: string[]; limits: string[] };
type Catalog = { source_snapshot: string; metric_status: string; cases: HistoryCase[]; provenance: "imported" | "sample" };
function catalog(directory: string): Catalog {
  const value = readJson(directory, "observations-202508.json");
  if (!record(value) || value.schema !== "ctf-observations/v1" || typeof value.source_snapshot !== "string" || value.source_snapshot.length > 160 ||
    !Array.isArray(value.cases) || value.cases.length > 12 || typeof value.metric_status !== "string") throw new Error("历史案例目录不符合读取合同");
  for (const item of value.cases) {
    if (!record(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id) || typeof item.title !== "string" || item.title.length > 300 ||
      !strings(item.period, 6) || typeof item.population !== "string" || item.population.length > 1200 || typeof item.status !== "string" ||
      !strings(item.limits) || !strings(item.evidence, 6) || !item.evidence.length || item.evidence.some((s) => !/^Q\d{4,6}$/.test(s))) throw new Error("历史案例条目不完整");
  }
  if (new Set(value.cases.map((c) => c.id)).size !== value.cases.length) throw new Error("历史案例编号重复");
  // 用户外挂材料按其声明标识；未声明真实来源的资料保守显示为示例。
  const provenance = value.provenance === "imported" || typeof value.basis === "string" && value.basis.startsWith("真实本地数据") ? "imported" : "sample";
  return { source_snapshot: value.source_snapshot, metric_status: value.metric_status, cases: value.cases as HistoryCase[], provenance };
}

const fieldNames: Record<string, string> = {
  rows: "记录数", sale_rows: "销售记录数", orders: "订单数", stores: "门店数", amount: "销售金额", grams: "销售金重",
  median_g: "整单一般足金金重中位数", p10_g: "整单金重下十分位数", p90_g: "整单金重上十分位数",
  actual_gap_per_gram: "每克牌价实收加权差额", median_gap_per_gram: "每克牌价实收差额中位数", p90_gap_per_gram: "每克差额上十分位数",
  extra_over5_pct: "每克差额超名义金额五元以上的记录占比", gap_not_explained_by_headline: "名义金额未解释的牌价实收差额",
  within_half_yuan_pct: "实际每克差额接近名义金额的记录占比", without_biggest_store: "按查询定义去最大门店后的每克差额",
  single_quantity_only: "单件记录的每克差额", before_aug15: "八月中旬前每克差额", after_aug15: "八月中旬后每克差额",
  matched_store_days: "匹配店日数", days: "观察日数", activity_orders: "相关活动订单数", with_recovery: "关联回收订单数",
  recovery_order_pct: "关联回收的订单占比", positive_sales: "销售正金额", recovery_credit: "回收抵扣金额",
  amount_less_recovery_proxy: "销售正金额减抵扣代理额", median_price_gap: "同店同日回收单价差中位数",
  without_biggest_store_pct: "去最大门店后克重变化", gram_change_pct: "克重变化", parent_change_pct: "上层克重变化",
  first_week_orders: "首个窗口订单数", later_week_orders: "后续窗口订单数",
  total_gap: "名义金额未解释的差额", grams_over_parent_pattern: "相对上层走势的克重差额",
  median_gap: "店日回收单价差中位数", mean_same_day_store_price_gap: "店日回收单价差均值", positive_pct: "正价差店日占比",
  first_sale_day: "首次观察到的成交日期", last_sale_day: "最后观察到的成交日期", observed_days: "有成交记录的日数",
  first_week_grams: "首个窗口销售金重", later_week_grams: "后续窗口销售金重",
};
const priority = ["median_g", "actual_gap_per_gram", "extra_over5_pct", "recovery_order_pct", "gram_change_pct", "parent_change_pct", "median_price_gap", "median_gap", "first_sale_day", "last_sale_day", "orders", "rows", "stores"];
const unitOf = (key: string) => key.endsWith("_pct") || key.includes("pct_") ? "%" : key.includes("per_gram") || key.includes("price_gap") || key === "median_gap" ? "元/克" :
  ["without_biggest_store", "single_quantity_only", "before_aug15", "after_aug15"].includes(key) ? "元/克" :
  key.endsWith("_g") || key.includes("grams") || key === "grams" ? "克" : /amount|sales$|credit|total_gap|headline/.test(key) ? "元" : undefined;

export function inspectHistoricalKnowledge(directory?: string) {
  if (!directory) return { available: false, limitations: ["未配置历史知识目录；可以继续分析当前授权数据快照"] };
  const data = catalog(directory);
  return { available: true, version: data.source_snapshot, provenance: data.provenance, limitations: [data.metric_status, "历史资料不代表本回合新查数据库，不证明当前周期或未来效果"],
    cases: data.cases.map(({ id, title, period, population, status }) => ({ id, title, period, population, status })) };
}

export function readHistoricalCase(directory: string | undefined, id: string): AdvisorSource[] {
  if (!directory) throw new Error("历史知识尚未启用，请先使用当前数据");
  const data = catalog(directory); const item = data.cases.find((c) => c.id === id);
  if (!item) throw new Error("没有这个历史案例");
  return item.evidence.map((evidenceId) => {
    const evidence = readJson(directory, `evidence/${evidenceId}.json`);
    if (!record(evidence) || evidence.source_snapshot !== data.source_snapshot || evidence.query_id !== evidenceId || !Array.isArray(evidence.rows) ||
      !evidence.rows.length || evidence.rows.length > 30 || typeof evidence.note !== "string") throw new Error("历史证据版本或内容不一致，未采用");
    const rows = evidence.rows.map((row, index) => {
      if (!record(row) || Object.keys(row).length > 40 || Object.values(row).some((v) => v !== null && !(typeof v === "number" && Number.isFinite(v)) && !(typeof v === "string" && v.length <= 300))) throw new Error("历史证据的指标格式不正确");
      const label = [row.offer, row.offer_name, row.region, row.district, row.group_name, row.segment, row.day].filter((s) => typeof s === "string" && s).join(" / ") || `结果${index + 1}`;
      const fields: AdvisorField[] = Object.keys(row).filter((key) => Object.hasOwn(fieldNames, key)).map((key) => ({ label: fieldNames[key], value: row[key] as AdvisorField["value"], ...(unitOf(key) ? { unit: unitOf(key) } : {}) }));
      if (!fields.some((f) => f.value !== null)) throw new Error("历史记录没有已适配的有效指标，不能生成经营观察");
      const ordered = [...Object.keys(row)].filter((key) => Object.hasOwn(fieldNames, key)).sort((a, b) => (priority.indexOf(a) < 0 ? 100 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 100 : priority.indexOf(b)));
      return { label, fields, statement: sourceStatement(label, ordered.slice(0, 4).map((key) => fields.find((f) => f.label === fieldNames[key])!)) };
    });
    return { id: `history:${id}:${evidenceId}`, kind: "historical" as const, title: `${item.title} · ${evidenceId}`, provenance: data.provenance,
      datasetVersion: data.source_snapshot, periodLabel: item.period.length === 2 && item.period.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)) ? item.period.join("至") : item.period.join("；"),
      scope: item.population, definition: evidence.note, recordId: evidenceId, rows: rows.map(({ label, fields }) => ({ label, fields })), statements: rows.map((r) => r.statement),
      limitations: [data.metric_status, item.status, ...item.limits, "离线历史查询记录；不是本回合实时查库或当前周期结果"],
    };
  });
}
