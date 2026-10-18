// 营销分析语义层：维度、筛选、指标、对照基线的唯一定义。
// 数据库编译、能力目录、提示词和口径说明都从这里生成；这里只放数据，不放查询逻辑。
// 依据档位：schema 字段名或类型，data 2026-10-18 实测，business 周大福确认，assumption 推断待确认。
// 实测记录见 docs/superpowers/specs/2026-10-18-analytics-semantic-layer-design.md 第 4 节。

export type SemanticBasis = "schema" | "data" | "business" | "assumption";
export type SemanticEntity = "time" | "store" | "product" | "offer" | "line";

// 数据库来源由适配器编译成 SQL 表达式；没有来源的维度只在导入快照中出现。
export type SemanticDimensionSource =
  | { kind: "column"; column: string }
  | { kind: "composite"; columns: readonly [string, string] }
  | { kind: "coalesce"; column: string; fallback: string }
  | { kind: "date_range"; start: string; end: string }
  | { kind: "day_type"; sunday: string; weekend: string; workday: string }
  | { kind: "age_band"; column: string }
  // 源字段是代码值时映射成业务名称；映射之外的值保持原样。
  | { kind: "labels"; column: string; labels: Readonly<Record<string, string>> };

export const ANALYSIS_DIMENSIONS = [
  "day", "dayType", "festival",
  "region", "area", "district", "subdistrict", "store", "province", "city", "cityTier", "mallGroup",
  "storeType", "storeGroup", "sameStore", "shopType", "storeComposition", "imageLevel", "salesLevel", "storeLevel", "retailExperience", "storeArea", "storeAge",
  "category", "productGroup", "material", "materialGroup", "priceBand", "seriesGroup", "series", "keySeries", "sku",
  "offer", "offerPeriod", "campaignType",
  "memberFlag", "memberSegment",
] as const;
export type SemanticDimensionId = typeof ANALYSIS_DIMENSIONS[number];

export const ANALYSIS_FILTER_KEYS = [
  "days", "dayTypes", "festivals",
  "regions", "areas", "districts", "subdistricts", "stores", "provinces", "cities", "cityTiers", "mallGroups",
  "storeTypes", "storeGroups", "sameStores", "shopTypes", "storeCompositions", "imageLevels", "salesLevels", "storeLevels", "retailExperiences", "storeAreas", "storeAges",
  "categories", "productGroups", "materials", "materialGroups", "priceBands", "seriesGroups", "seriesNames", "keySeriesFlags", "skus",
  "offers", "offerPeriods", "campaignTypes",
  "memberFlags", "memberSegments",
] as const;
export type SemanticFilterKey = typeof ANALYSIS_FILTER_KEYS[number];

export type SemanticDimension = {
  label: string;
  filter: SemanticFilterKey;
  entity: SemanticEntity;
  parent?: SemanticDimensionId;
  scan: boolean;                       // 是否纳入「找新角度」的扫描空间
  source?: SemanticDimensionSource;    // 数据库来源；缺省表示数据库不提供
  definition: string;
  basis: SemanticBasis;
};

const column = (name: string): SemanticDimensionSource => ({ kind: "column", column: name });

export const SEMANTIC_DIMENSIONS: Record<SemanticDimensionId, SemanticDimension> = {
  day: { label: "日期", filter: "days", entity: "time", scan: false, source: column("交易日期wid"), definition: "交易日期", basis: "schema" },
  dayType: { label: "日类型", filter: "dayTypes", entity: "time", scan: true, source: { kind: "day_type", sunday: "周日标识", weekend: "周末标识", workday: "工作日标识" }, definition: "工作日、周六、周日，由源表周末、周日、工作日标识推出，三者互斥", basis: "data" },
  festival: { label: "节庆", filter: "festivals", entity: "time", scan: true, source: { kind: "coalesce", column: "节庆", fallback: "非节庆" }, definition: "源表节庆字段；没有节庆的日期记为非节庆。七夕节定义为七夕及前 6 天共 7 天", basis: "data" },
  region: { label: "大区", filter: "regions", entity: "store", scan: true, source: column("大区描述"), definition: "门店所属大区", basis: "data" },
  area: { label: "区域", filter: "areas", entity: "store", parent: "region", scan: true, source: column("区域描述"), definition: "大区下的区域，名称列出所含分区；与分区不完全对齐，日常用哪一层待确认", basis: "assumption" },
  district: { label: "分区", filter: "districts", entity: "store", parent: "region", scan: true, source: { kind: "composite", columns: ["大区描述", "分区描述"] }, definition: "大区加分区，写作「大区/分区」；同名分区在不同大区是不同对象", basis: "data" },
  subdistrict: { label: "小区", filter: "subdistricts", entity: "store", parent: "district", scan: false, source: column("小区描述"), definition: "分区下的小区，每个小区只属于一个大区加分区", basis: "data" },
  store: { label: "门店", filter: "stores", entity: "store", parent: "subdistrict", scan: false, source: column("实体分店店号"), definition: "实体分店店号", basis: "schema" },
  province: { label: "省份", filter: "provinces", entity: "store", scan: true, source: column("省份描述"), definition: "门店所在省份", basis: "schema" },
  city: { label: "城市", filter: "cities", entity: "store", parent: "province", scan: false, source: column("城市"), definition: "门店所在城市", basis: "schema" },
  cityTier: { label: "城市级别", filter: "cityTiers", entity: "store", scan: true, source: column("城市级别"), definition: "门店所在城市的级别", basis: "schema" },
  mallGroup: { label: "商场集团", filter: "mallGroups", entity: "store", scan: true, source: column("商场集团"), definition: "门店所在商场集团；街铺单独一类", basis: "data" },
  storeType: { label: "分店性质", filter: "storeTypes", entity: "store", scan: true, source: column("分店性质"), definition: "自营、合营、加盟（寄售/批发）", basis: "data" },
  storeGroup: { label: "性质分组", filter: "storeGroups", entity: "store", scan: true, source: column("性质分组"), definition: "自合营店与加盟店两组", basis: "data" },
  sameStore: { label: "同店类型", filter: "sameStores", entity: "store", scan: true, source: column("同店类型"), definition: "源表同店类型：同店、非同店（续存）、非同店（非续存）；同店判定口径待确认", basis: "assumption" },
  shopType: { label: "铺型", filter: "shopTypes", entity: "store", scan: true, source: column("铺型"), definition: "门店铺型", basis: "schema" },
  storeComposition: { label: "店铺组成", filter: "storeCompositions", entity: "store", scan: true, source: column("店铺组成"), definition: "门店店铺组成", basis: "schema" },
  imageLevel: { label: "形象级别", filter: "imageLevels", entity: "store", scan: true, source: column("形象级别描述"), definition: "门店形象级别", basis: "schema" },
  salesLevel: { label: "销售级别", filter: "salesLevels", entity: "store", scan: true, source: column("销售级别描述"), definition: "门店销售级别", basis: "schema" },
  storeLevel: { label: "分店级别", filter: "storeLevels", entity: "store", scan: true, source: column("分店级别"), definition: "分店级别", basis: "schema" },
  retailExperience: { label: "零售体验", filter: "retailExperiences", entity: "store", scan: true, source: column("零售体验描述"), definition: "门店零售体验类型", basis: "schema" },
  storeArea: { label: "面积区间", filter: "storeAreas", entity: "store", scan: true, source: column("分店面积区间"), definition: "门店面积区间", basis: "schema" },
  storeAge: { label: "店龄段", filter: "storeAges", entity: "store", scan: true, source: { kind: "age_band", column: "店龄" }, definition: "店龄（年）分为 0-1、2-3、4-5、6-10、10年以上；分段方式待确认", basis: "assumption" },
  category: { label: "货类", filter: "categories", entity: "product", scan: true, source: column("业务小类描述"), definition: "业务小类，如一般足金类、定价黄金类、钻石类", basis: "data" },
  productGroup: { label: "组别大类", filter: "productGroups", entity: "product", scan: true, source: column("组别大类描述"), definition: "货品组别大类；与货类是并列的两套分类，不是上下级", basis: "data" },
  material: { label: "材料", filter: "materials", entity: "product", scan: true, source: column("材料种类描述"), definition: "材料种类，如足金、定价足金、钻石", basis: "data" },
  materialGroup: { label: "材料组别", filter: "materialGroups", entity: "product", scan: true, source: column("材料种类组别描述"), definition: "材料种类组别", basis: "schema" },
  priceBand: { label: "价位段", filter: "priceBands", entity: "product", scan: true, source: column("价位段"), definition: "货品价位段，从 <500 到 >=1000k", basis: "data" },
  seriesGroup: { label: "产品系列组别", filter: "seriesGroups", entity: "product", scan: true, source: column("产品系列组别描述"), definition: "产品系列组别", basis: "schema" },
  series: { label: "产品系列", filter: "seriesNames", entity: "product", parent: "seriesGroup", scan: false, source: column("产品系列描述"), definition: "产品系列，183 个", basis: "data" },
  keySeries: { label: "重点系列", filter: "keySeriesFlags", entity: "product", scan: true, source: column("是否重点系列描述"), definition: "重点系列、非重点系列、无系列", basis: "data" },
  sku: { label: "货品", filter: "skus", entity: "product", scan: false, source: column("sku号"), definition: "SKU 号", basis: "schema" },
  offer: { label: "优惠", filter: "offers", entity: "offer", scan: true, source: column("优惠小类"), definition: "开单优惠名称；「一般開單」推断为不带优惠的普通开单，可作对照，待确认", basis: "assumption" },
  offerPeriod: { label: "活动期次", filter: "offerPeriods", entity: "offer", parent: "offer", scan: false, source: { kind: "date_range", start: "活动开始日期", end: "活动结束日期" }, definition: "优惠所属活动期次，写作「开始日至结束日」，结束日为次日零点；同一优惠名可有多个期次。期次是该行所属的活动设置，成交日不一定落在期次内，需要实际成交窗口时按日期分组查看", basis: "data" },
  campaignType: { label: "营销活动类型", filter: "campaignTypes", entity: "offer", scan: true, source: column("营销活动"), definition: "总部营销活动或地区营销活动", basis: "data" },
  memberFlag: { label: "会员销售", filter: "memberFlags", entity: "line", scan: true, source: { kind: "labels", column: "是否会员销售（1：是，0：否）", labels: { "1": "会员", "0": "非会员" } }, definition: "这笔销售是否会员销售，取值会员、非会员；数据里没有会员等级", basis: "schema" },
  memberSegment: { label: "会员分组", filter: "memberSegments", entity: "line", scan: true, definition: "导入快照提供的会员分组", basis: "schema" },
};

export const ANALYSIS_FILTER_DIMENSIONS = Object.fromEntries((Object.entries(SEMANTIC_DIMENSIONS) as Array<[SemanticDimensionId, SemanticDimension]>).map(([id, item]) => [item.filter, id])) as Record<SemanticFilterKey, SemanticDimensionId>;

// 基础度量直接汇总；比率由分子分母分别汇总后再相除，不平均各组比率。
export const ANALYSIS_BASE_FIELDS = ["amount", "quantity", "grams", "profit", "tag_amount", "orders", "stores", "rows"] as const;
export type SemanticBaseField = typeof ANALYSIS_BASE_FIELDS[number];
export const ANALYSIS_METRICS = [...ANALYSIS_BASE_FIELDS, "amount_per_day", "orders_per_day", "amount_per_order", "amount_per_item", "amount_per_gram", "tag_per_gram", "gap_per_gram", "margin_rate", "discount_rate", "amount_per_store", "profit_per_store"] as const;
export type SemanticMetricId = typeof ANALYSIS_METRICS[number];
export type SemanticRatioId = Exclude<SemanticMetricId, SemanticBaseField>;

export type SemanticUnit = "money" | "money_per_day" | "money_per_order" | "money_per_item" | "money_per_gram" | "money_per_store" | "count_per_day" | "percent" | "件" | "克" | "单" | "家" | "条";
export type SemanticPopulation = "sales" | "net" | "recovery" | "returns" | "zero_sales";
const ALL_POPULATIONS: readonly SemanticPopulation[] = ["sales", "net", "recovery", "returns", "zero_sales"];

export type SemanticRatio = {
  numerator: ReadonlyArray<{ field: SemanticBaseField; sign: 1 | -1 }>;
  denominator: SemanticBaseField | "days";   // days 是范围及分组内有成交记录的日期数
  scale: number;                              // 百分比为 100
  standardize: boolean;                       // 是否支持按控制层的参照权重标准化
  guarded: boolean;                           // 结论引用时是否必须是同层或标准化比较
};
export type SemanticMetric = {
  label: string; unit: SemanticUnit; grain: "line" | "selected_order";
  additive: boolean; populations: readonly SemanticPopulation[]; requires: readonly SemanticDimensionId[];
  definition: string; basis: SemanticBasis; ratio?: SemanticRatio;
};

const ratio = (numerator: SemanticRatio["numerator"], denominator: SemanticRatio["denominator"], options: Partial<Pick<SemanticRatio, "scale" | "standardize" | "guarded">> = {}): SemanticRatio => ({ numerator, denominator, scale: options.scale ?? 1, standardize: options.standardize ?? true, guarded: options.guarded ?? false });
const plus = (field: SemanticBaseField) => ({ field, sign: 1 as const });
const minus = (field: SemanticBaseField) => ({ field, sign: -1 as const });

export const SEMANTIC_METRICS: Record<SemanticMetricId, SemanticMetric> = {
  amount: { label: "实收金额", unit: "money", grain: "line", additive: true, populations: ALL_POPULATIONS, requires: [], definition: "实际销售金额，逐行按分汇总；任一参与行缺失则缺失，不补零", basis: "data" },
  quantity: { label: "件数", unit: "件", grain: "line", additive: true, populations: ALL_POPULATIONS, requires: [], definition: "销售件数，退货为负", basis: "schema" },
  grams: { label: "克重", unit: "克", grain: "line", additive: true, populations: ALL_POPULATIONS, requires: [], definition: "销售金重", basis: "schema" },
  profit: { label: "零售毛利", unit: "money", grain: "line", additive: true, populations: ALL_POPULATIONS, requires: [], definition: "源字段零售毛利直接汇总；实测不等于实收减成本，口径待确认", basis: "assumption" },
  tag_amount: { label: "牌仔价合计", unit: "money", grain: "line", additive: true, populations: ALL_POPULATIONS, requires: [], definition: "销售牌仔价逐行按分汇总；推断为吊牌标价，待确认", basis: "assumption" },
  orders: { label: "订单数", unit: "单", grain: "selected_order", additive: false, populations: ALL_POPULATIONS, requires: [], definition: "门店加销售单号去重；只覆盖当前筛选内成交部分，缺店号或单号的行不计入并注明行数", basis: "data" },
  stores: { label: "门店数", unit: "家", grain: "line", additive: false, populations: ALL_POPULATIONS, requires: [], definition: "范围内有成交记录的门店数", basis: "data" },
  rows: { label: "明细行数", unit: "条", grain: "line", additive: true, populations: ALL_POPULATIONS, requires: [], definition: "选定范围内的明细行数", basis: "data" },
  amount_per_day: { label: "日均实收", unit: "money_per_day", grain: "line", additive: false, populations: ALL_POPULATIONS, requires: [], definition: "实收除以该范围及分组内有成交记录的日期数；不同长度窗口直接用它比较", basis: "data", ratio: ratio([plus("amount")], "days", { standardize: false }) },
  orders_per_day: { label: "日均订单", unit: "count_per_day", grain: "selected_order", additive: false, populations: ["sales"], requires: [], definition: "订单数除以该范围及分组内有成交记录的日期数", basis: "data", ratio: ratio([plus("orders")], "days", { standardize: false }) },
  amount_per_order: { label: "单均实收", unit: "money_per_order", grain: "selected_order", additive: false, populations: ["sales"], requires: [], definition: "实收除以订单数；订单只覆盖当前筛选内成交部分，不是整张订单客单价", basis: "data", ratio: ratio([plus("amount")], "orders", { guarded: true }) },
  amount_per_item: { label: "件均实收", unit: "money_per_item", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "实收除以件数；受货类结构影响", basis: "data", ratio: ratio([plus("amount")], "quantity") },
  amount_per_gram: { label: "每克实收", unit: "money_per_gram", grain: "line", additive: false, populations: ["sales"], requires: ["category", "material"], definition: "实收除以克重；须同货类同材料比较", basis: "data", ratio: ratio([plus("amount")], "grams", { guarded: true }) },
  tag_per_gram: { label: "每克牌价", unit: "money_per_gram", grain: "line", additive: false, populations: ["sales"], requires: ["category", "material"], definition: "牌仔价除以克重，可作金价走势的代理指数；不等于当日金价，须同货类同材料比较", basis: "assumption", ratio: ratio([plus("tag_amount")], "grams", { guarded: true }) },
  gap_per_gram: { label: "每克牌价实收差额", unit: "money_per_gram", grain: "line", additive: false, populations: ["sales"], requires: ["category", "material"], definition: "牌仔价减实收后除以克重；含工费与其他权益，不等于完整活动优惠", basis: "assumption", ratio: ratio([plus("tag_amount"), minus("amount")], "grams", { guarded: true }) },
  margin_rate: { label: "毛利率", unit: "percent", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "零售毛利除以实收；毛利口径待确认，跨货类比较受货类结构影响", basis: "assumption", ratio: ratio([plus("profit")], "amount", { scale: 100 }) },
  discount_rate: { label: "折扣率", unit: "percent", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "（牌仔价 − 实收）÷ 牌仔价，代表让利幅度；牌仔价是否为标价待确认，跨货类比较受货类结构影响", basis: "assumption", ratio: ratio([plus("tag_amount"), minus("amount")], "tag_amount", { scale: 100 }) },
  amount_per_store: { label: "每店实收", unit: "money_per_store", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "实收除以范围内有成交的门店数；用于门店数量不同的分组之间比较", basis: "data", ratio: ratio([plus("amount")], "stores", { standardize: false }) },
  profit_per_store: { label: "每店毛利", unit: "money_per_store", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "零售毛利除以范围内有成交的门店数；毛利口径待确认", basis: "assumption", ratio: ratio([plus("profit")], "stores", { standardize: false }) },
};

export const semanticRatio = (metric: string): SemanticRatio | undefined => SEMANTIC_METRICS[metric as SemanticMetricId]?.ratio;
export const semanticFields = (metric: SemanticMetricId): SemanticBaseField[] => {
  const spec = SEMANTIC_METRICS[metric].ratio;
  if (!spec) return [metric as SemanticBaseField];
  return [...new Set([...spec.numerator.map((term) => term.field), ...(spec.denominator === "days" ? [] : [spec.denominator])])];
};
export function semanticUnit(unit: SemanticUnit, currency: string): string {
  if (unit === "money") return currency;
  if (unit === "money_per_day") return `${currency}/日`;
  if (unit === "money_per_order") return `${currency}/单`;
  if (unit === "money_per_item") return `${currency}/件`;
  if (unit === "money_per_gram") return `${currency}/克`;
  if (unit === "money_per_store") return `${currency}/家`;
  if (unit === "count_per_day") return "单/日";
  if (unit === "percent") return "%";
  return unit;
}

// 对照基线由现有筛选组合而成，供模型直接选用。
export const SEMANTIC_BASELINES = [
  { id: "plain_order", label: "一般開單", how: "参照范围 filters.offers=[\"一般開單\"]，其余条件与目标相同", definition: "推断为不带优惠的普通开单，可作活动成交的对照；待确认", basis: "assumption" as SemanticBasis },
  { id: "same_store", label: "同店", how: "目标与参照都加 filters.sameStores=[\"同店\"]", definition: "源表同店类型为同店的门店；同店口径待确认", basis: "assumption" as SemanticBasis },
  { id: "non_festival", label: "非节庆日", how: "参照范围 filters.festivals=[\"非节庆\"]，用 amount_per_day 等日均指标比较，并按 dayType 对齐", definition: "同月没有节庆的日期", basis: "data" as SemanticBasis },
  { id: "common_stores", label: "共同观察门店", how: "compare 设 commonStores=true", definition: "目标与参照两个范围都有成交的门店；不等于同店类型中的同店", basis: "data" as SemanticBasis },
] as const;

// 能力目录里的口径说明：每条一句，答案里按句去重。
export const SEMANTIC_DATABASE_LIMITATIONS = [
  "探索口径，尚未与 Power BI 对数；金额为源币种，未换汇",
  "零售毛利直接取源字段，实测不等于实收减成本，口径待确认",
  "只有是否会员销售标识，没有会员身份、等级与复购",
  "优惠名称和活动期次不含门槛、叠加与封顶规则；历史相关不证明因果或最优力度",
  "订单只覆盖当前筛选内成交部分；缺店号或单号的行不计入订单并在证据中注明",
] as const;

export const semanticDimensionLabel = (id: string): string => SEMANTIC_DIMENSIONS[id as SemanticDimensionId]?.label ?? id;
export const semanticMetricLabel = (id: string): string => SEMANTIC_METRICS[id as SemanticMetricId]?.label ?? id;

export type SemanticCatalogEntry = { id: SemanticDimensionId; label: string; filter: SemanticFilterKey; parent?: SemanticDimensionId; scan: boolean; definition: string; basis: SemanticBasis };
export function semanticDimensionCatalog(available: readonly SemanticDimensionId[]): SemanticCatalogEntry[] {
  return available.map((id) => { const item = SEMANTIC_DIMENSIONS[id]; return { id, label: item.label, filter: item.filter, ...(item.parent && available.includes(item.parent) ? { parent: item.parent } : {}), scan: item.scan, definition: item.definition, basis: item.basis }; });
}

// 数据库投影需要的全部源字段，供本地演示投影表与列裁剪使用。
export function semanticDatabaseColumns(): string[] {
  const columns = new Set(["_import_id", "交易日期wid", "实体分店店号", "销售单号", "币种描述", "实际销售金额", "销售件数", "销售金重", "零售毛利", "销售牌仔价"]);
  for (const item of Object.values(SEMANTIC_DIMENSIONS)) {
    const source = item.source; if (!source) continue;
    if (source.kind === "column" || source.kind === "coalesce" || source.kind === "age_band" || source.kind === "labels") columns.add(source.column);
    else if (source.kind === "composite") source.columns.forEach((name) => columns.add(name));
    else if (source.kind === "date_range") { columns.add(source.start); columns.add(source.end); }
    else { columns.add(source.sunday); columns.add(source.weekend); columns.add(source.workday); }
  }
  return [...columns];
}
