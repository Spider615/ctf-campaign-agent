import { MAX_IMPORT_BYTES, MAX_SALES_ROWS, MAX_SNAPSHOT_BYTES, type AnalyticsDataset, type CampaignRule, type DatasetSummary, type FieldSpec, type ImportDatasetInput, type ImportFile, type SalesRow } from "./types.ts";

const field = (key: string, label: string, required: boolean, ...aliases: string[]): FieldSpec => ({ key, label, required, aliases: [key, label, ...aliases] });
export const SALES_FIELDS: FieldSpec[] = [
  field("lineId", "明细ID", true, "明细编号", "销售明细ID", "流水号", "line_id"),
  field("date", "日期", true, "销售日期", "业务日期", "business_date"),
  field("store", "门店", true, "门店编号", "门店代码", "store_id"),
  field("category", "货类", true, "品类", "商品类别", "category_name"),
  field("netSales", "净销售额", true, "净销售额（元）", "net_sales", "sales_net"),
  field("quantity", "件数", true, "净销售件数", "销售件数", "qty"),
  field("orderId", "订单编号", false, "订单ID", "order_id"),
  field("region", "区域", false, "大区", "region_name"), field("city", "城市", false),
  field("sku", "商品编号", false, "SKU", "sku_id"),
  field("memberId", "会员编号", false, "会员ID", "member_id"),
  field("memberSegment", "会员分组", false, "会员标签", "新老会员", "member_segment"),
  field("campaignId", "活动编号", false, "活动ID", "campaign_id"),
  field("cost", "成本", false, "净销售成本", "cost_amount"),
  field("weightGrams", "克重", false, "净销售克重", "weight_grams"),
];
export const RULE_FIELDS: FieldSpec[] = [
  field("campaignId", "活动编号", true, "活动ID", "campaign_id"),
  field("name", "活动名称", true, "campaign_name"),
  field("mechanism", "优惠机制", false, "活动玩法", "优惠类型"),
  field("discountValue", "优惠力度", false, "优惠值", "discount_value"),
];

export function parseCsv(content: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let closed = false;
  const text = content.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new Error("CSV 引号格式不正确");
      quoted = true;
    } else if (c === ",") { row.push(cell); cell = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((v) => v.trim())) out.push(row);
      row = []; cell = ""; closed = false;
    } else {
      if (closed && c.trim()) throw new Error("CSV 引号后出现了多余内容");
      if (!closed) cell += c;
    }
  }
  if (quoted) throw new Error("CSV 引号没有闭合");
  row.push(cell); if (row.some((v) => v.trim())) out.push(row);
  return out;
}

export function inspectFile(content: string, format: "csv" | "json") {
  if (typeof content !== "string" || new TextEncoder().encode(content).length > MAX_IMPORT_BYTES) throw new Error("导入文件最多 1 MiB");
  let table: string[][];
  if (format === "csv") table = parseCsv(content);
  else if (format === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(content.replace(/^\uFEFF/, "")); } catch { throw new Error("JSON 文件格式不正确"); }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((v) => !v || typeof v !== "object" || Array.isArray(v))) throw new Error("JSON 应为非空的明细对象数组");
    const headers = [...new Set(parsed.flatMap((v) => Object.keys(v)))];
    table = [headers, ...parsed.map((v) => headers.map((h) => {
      const value = v[h];
      if (value !== null && value !== undefined && !["string", "number"].includes(typeof value)) throw new Error(`字段 ${h} 必须是文本或数字`);
      return value === null || value === undefined ? "" : String(value);
    }))];
  } else throw new Error("只支持 CSV 或 JSON 文件");
  const headers = (table[0] ?? []).map((h) => h.trim());
  if (!headers.length || headers.some((h) => !h)) throw new Error("表头不能为空");
  if (new Set(headers).size !== headers.length) throw new Error("文件包含重复表头，请先区分列名");
  const records = table.slice(1);
  if (!records.length) throw new Error("文件没有可导入的数据");
  if (records.length > MAX_SALES_ROWS) throw new Error(`本期最多导入 ${MAX_SALES_ROWS} 条明细，请缩小范围`);
  if (records.some((r) => r.length !== headers.length)) throw new Error("CSV 某行列数与表头不一致");
  return { headers, preview: records.slice(0, 5), records, count: records.length };
}

const canonical = (v: string) => v.replace(/[\s_（）()]/g, "").toLowerCase();
export function suggestMapping(headers: string[], fields: FieldSpec[]): Record<string, string> {
  return Object.fromEntries(fields.flatMap((f) => {
    const matches = headers.filter((h) => f.aliases.some((a) => canonical(a) === canonical(h)));
    return matches.length === 1 ? [[f.key, matches[0]]] : [];
  }));
}
function mappedFile(file: ImportFile, fields: FieldSpec[]) {
  if (!file || typeof file !== "object") throw new Error("请提供销售明细文件");
  const table = inspectFile(file.content, file.format);
  const mapping = { ...suggestMapping(table.headers, fields), ...file.mapping };
  for (const f of fields) {
    if (f.required && !mapping[f.key]) throw new Error(`请映射必填字段「${f.label}」`);
    if (mapping[f.key] && !table.headers.includes(mapping[f.key])) throw new Error(`字段「${f.label}」引用的列不存在`);
  }
  const rows = table.records.map((r) => Object.fromEntries(fields.map((f) => [f.key, mapping[f.key] ? r[table.headers.indexOf(mapping[f.key])].trim() : ""])));
  return { rows, mapping: Object.fromEntries(fields.flatMap((f) => mapping[f.key] ? [[f.key, mapping[f.key]]] : [])) };
}
export function normalizeDate(value: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!m) throw new Error("日期须为 YYYY-MM-DD 或 YYYY/MM/DD");
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`日期 ${value} 不存在`);
  return iso;
}
function numberOf(value: string, label: string, optional = false, money = false): number | null {
  if (optional && (!value || /^(null|n\/a|na|未知|未提供)$/i.test(value))) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`${label}必须是有效数字；金额请去掉货币符号和千位分隔符`);
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1_000_000_000) throw new Error(`${label}超出可计算范围`);
  if (money && Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) throw new Error(`${label}金额最多保留两位小数`);
  return n;
}
function optionalText(value: string): string | null { return value || null; }

export function importDataset(input: ImportDatasetInput): AnalyticsDataset {
  if (!input || !["imported", "sample"].includes(input.provenance) || input.currency !== "CNY" || typeof input.name !== "string" || !input.name.trim()) throw new Error("请提供名称、数据来源和 CNY 金额口径");
  if (input.name.length > 80) throw new Error("数据集名称不能超过 80 个字");
  const sales = mappedFile(input.sales, SALES_FIELDS); const ids = new Set<string>();
  const rows: SalesRow[] = sales.rows.map((r, index) => {
    try {
      if (Object.values(r).some((v) => v.length > 120)) throw new Error("字段文本不能超过 120 个字");
      for (const key of ["lineId", "date", "store", "category"]) if (!r[key]) throw new Error(`必填字段 ${key} 为空`);
      if (ids.has(r.lineId)) throw new Error(`重复销售明细 ID：${r.lineId}`);
      ids.add(r.lineId);
      const quantity = numberOf(r.quantity, "件数")!;
      if (!Number.isInteger(quantity)) throw new Error("件数必须是整数，退款用负数");
      return {
        lineId: r.lineId, date: normalizeDate(r.date), store: r.store, category: r.category,
        netSales: numberOf(r.netSales, "净销售额金额", false, true)!, quantity,
        cost: numberOf(r.cost, "成本金额", true, true), weightGrams: numberOf(r.weightGrams, "克重", true),
        orderId: optionalText(r.orderId), region: optionalText(r.region), city: optionalText(r.city), sku: optionalText(r.sku),
        memberId: optionalText(r.memberId), memberSegment: optionalText(r.memberSegment), campaignId: optionalText(r.campaignId),
      };
    } catch (e) { throw new Error(`销售文件第 ${index + 2} 行：${e instanceof Error ? e.message : "格式不正确"}`); }
  });
  const campaigns = input.campaigns ? mappedFile(input.campaigns, RULE_FIELDS) : null;
  const rules: CampaignRule[] = (campaigns?.rows ?? []).map((r, i) => {
    if (!r.campaignId || !r.name || Object.values(r).some((v) => v.length > 120)) throw new Error(`活动规则第 ${i + 2} 行缺少编号、名称或文本过长`);
    return { campaignId: r.campaignId, name: r.name, mechanism: optionalText(r.mechanism), discountValue: numberOf(r.discountValue, "优惠力度", true) };
  });
  const dates = rows.map((r) => r.date).sort();
  const warnings: string[] = [];
  if (rows.some((r) => r.cost === null)) warnings.push("部分明细没有成本；涉及这些明细的毛利不会计算");
  if (rows.some((r) => r.memberSegment === null)) warnings.push("部分明细没有会员分组；不能依据会员编号推断新老会员");
  if (!rules.length) warnings.push("未导入活动规则，无法解释具体优惠机制与力度");
  const unmatched = new Set(rows.filter((r) => r.campaignId && !rules.some((rule) => rule.campaignId === r.campaignId)).map((r) => r.campaignId));
  if (rules.length && unmatched.size) warnings.push(`${unmatched.size} 个销售活动编号没有对应规则`);
  const dataset: AnalyticsDataset = {
    schema: "analytics-dataset/v1", id: "", version: "", name: input.name.trim(), provenance: input.provenance, currency: "CNY", createdAt: "",
    rows, rules, minDate: dates[0], maxDate: dates.at(-1)!, warnings,
    sourceFiles: [input.sales.fileName ?? "销售明细", ...(input.campaigns ? [input.campaigns.fileName ?? "活动规则"] : [])],
    mappings: { sales: sales.mapping, campaigns: campaigns?.mapping ?? {} },
  };
  if (new TextEncoder().encode(JSON.stringify(dataset)).length > MAX_SNAPSHOT_BYTES) throw new Error("归一化数据超过 1.5 MiB，请缩小范围");
  return dataset;
}

export function datasetSummary(dataset: AnalyticsDataset): DatasetSummary {
  const { rows, rules, ...rest } = dataset;
  const values = (key: keyof SalesRow) => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === "string" && Boolean(v)))].sort();
  return { ...rest, rowCount: rows.length, ruleCount: rules.length, facets: { stores: values("store"), regions: values("region"), categories: values("category"), campaignIds: values("campaignId"), memberSegments: values("memberSegment") } };
}
