// 智能洞察：指标影响因素图谱的数据结构。图谱由 Agent 服务算好，页面只读不算。
// 设计见 docs/superpowers/specs/2026-10-20-insight-drivers-design.md。

// 节点从左到右四列：细项因素 → 因素 → 指标拆解 → 指标。
export const INSIGHT_NODE_IDS = [
  "image", "shoptype", "areaage", "region", "nature",
  "qixi", "weekday",
  "depth", "threshold", "tradein", "shift",
  "gold", "member",
  "store", "day", "promo", "mix",
  "orders", "aov", "gm",
  "qty", "sales", "gp",
] as const;
export type InsightNodeId = typeof INSIGHT_NODE_IDS[number];
// 节点的固定名字。「七夕」是 8 月数据里的节日，换了数据由 drivers.ts 按日历表里的节日改写。
export const INSIGHT_NODE_LABEL: Record<InsightNodeId, string> = {
  image: "商圈形象级别", shoptype: "店型", areaage: "面积、店龄、城市", region: "大区 / 区域", nature: "自营 / 加盟",
  qixi: "七夕", weekday: "星期", depth: "每克让多少", threshold: "克重门槛", tradein: "以旧换新", shift: "新增还是挪动",
  gold: "每日金价", member: "新老会员", store: "门店本身", day: "日期和活动", promo: "活动和力度", mix: "货品结构",
  orders: "订单数", aov: "客单价", gm: "毛利率", qty: "销量", sales: "销售额", gp: "毛利",
};
export type InsightColumn = 0 | 1 | 2 | 3;
export type InsightSection = "门店" | "时间" | "活动" | "缺数据";
export type InsightNodeKind = "leaf" | "factor" | "decomp" | "metric";

// 强弱档：强、中、弱由解释度分数定；id 是恒等式；missing 是数据里没有、AI 推测的关系。
export type InsightStrength = "strong" | "med" | "weak" | "id" | "missing";
// 解释度分数（0–100）：这一因素能解释结果差异的百分比，有分数的线用同一把尺子，可以直接比大小。
// 档位由分数换算：≥ 10 强，2–10 中，< 2 弱。怎么算写在 measure 里。
// 活动机制（每克让多少、门槛、以旧换新、新增还是挪动、力度和客单）另带 effect：一个带单位的效应值，帮业务看懂差多少。
// 拆解线（恒等式）也有分数：门店之间结果的差异多少来自这一项；缺数据的线没有分数。
export type InsightScore = { value: number; measure: string };
export type InsightEffect = { text: string; measure: string };

// 节点的来源。field 数据表里本来就有；derived 按固定公式算出；grouping AI 归类；
// inferred 取值来自数据，概念或解读是 AI 定的；suggested 数据里没有、AI 认为该补。
export type InsightSourceKind = "field" | "derived" | "grouping" | "inferred" | "suggested";
export const INSIGHT_SOURCE_KINDS: readonly InsightSourceKind[] = ["field", "derived", "grouping", "inferred", "suggested"];
export const INSIGHT_SOURCE_LABEL: Record<InsightSourceKind, { tag: string; name: string; desc: string }> = {
  field: { tag: "字段", name: "数据表字段", desc: "数据表里本来就有，直接汇总" },
  derived: { tag: "计算", name: "数据计算", desc: "按固定公式从字段算出来，没有解读" },
  grouping: { tag: "AI 归类", name: "AI 归类", desc: "AI 把几个字段或取值归成一类" },
  inferred: { tag: "AI 判断", name: "AI 判断", desc: "取值来自数据，但概念、对照组或解读是 AI 定的，待业务确认" },
  suggested: { tag: "待采集", name: "AI 提出待采集", desc: "数据里没有，AI 认为应该补" },
};
export const isRealSource = (kind: InsightSourceKind) => kind === "field" || kind === "derived";
export type InsightSource = { kind: InsightSourceKind; columns: string[]; how: string; judgement?: string };

// 节点详情里的小表：第一行是表头。
export type InsightTable = { head: string[]; rows: string[][] };
// 依据里的图：数字由 drivers.ts 算好、换成展示单位，页面只画。tone：main 主色、accent 重点、muted 对照。
// bars 横条比大小（可有负值）；split 一根条拆成几段（差异来自哪里）；columns 按日或按克的柱（可堆叠，band 标一段区间，mark 标在柱顶）；
// lines 逐日折线（同一根纵轴的倍数）；scatter 门店散点 + 最小二乘拟合线。
export type InsightChartTone = "main" | "accent" | "muted" | "soft";
export type InsightChartLegend = Array<{ tone: InsightChartTone; label: string }>;
export type InsightChart = { title: string; note?: string; legend?: InsightChartLegend } & (
  // compare：业务卡片用的竖柱对比，柱顶写数、柱下写名字；base 是对照（灰），hot 是最突出的一档。
  | { kind: "compare"; items: Array<{ label: string; sub?: string; value: number; text: string; tone: "base" | "hot" | "normal" }> }
  | { kind: "bars"; bars: Array<{ label: string; value: number; text: string; tone?: InsightChartTone }> }
  | { kind: "split"; parts: Array<{ label: string; value: number; tone: InsightChartTone }> }
  | { kind: "columns"; unit: string; digits: number; stacked: boolean; series: Array<{ label: string; tone: InsightChartTone }>;
      points: Array<{ label: string; values: number[]; mark?: string }>; band?: { from: string; to: string; label: string } }
  // lines：几条线都换算成「是第一个点的几倍」放在同一根纵轴上（不用双纵轴）；横轴可以是日期，也可以是门店分档。hover 是每条线每个点的原值文字。
  // base：「1×」指什么（例如「3 单以下那一档」），写在图下；不给时按平常工作日。
  | { kind: "lines"; labels: string[]; series: Array<{ label: string; tone: InsightChartTone; values: number[]; hover: string[] }>; band?: { from: string; to: string; label: string }; marks?: Array<{ at: string; label: string }>; base?: string }
  | { kind: "scatter"; x: { label: string; unit: string }; y: { label: string; unit: string }; points: Array<[number, number]>; fit: { slope: number; intercept: number } }
);
// 给总部业务看的卡片：一句话结论 → 一张对比图 → 怎么知道的 → 要注意 → 可以怎么做。
// say 里用【】包住要标蓝的数字。todo 是 AI 建议，evidence 是支撑这条建议的数据事实（问答时照这些回答）；给不出建议时 todo 为 null、todoNote 写原因。
// stores：要注意里点名的门店，每家和同类一般水平比。
export type InsightCardStores = { title: string; unit: string; rows: Array<{ name: string; value: number }>; peer: number };
export type InsightCard = { say: string; chart?: InsightChart; how: string; watch: string[]; stores?: InsightCardStores; todo: string | null; todoNote?: string; evidence: string[] };
export type InsightNode = {
  id: InsightNodeId; column: InsightColumn; section?: InsightSection; kind: InsightNodeKind;
  label: string; subtitle: string; strength?: InsightStrength; score?: InsightScore; effect?: InsightEffect;
  source: InsightSource; card: InsightCard; paragraphs: string[]; chart?: InsightChart; table?: InsightTable; note?: string;
};
// 每条线三部分（2026-10-19 会议定的）：依据 basis（数据验证的关联）、异常 anomalies（特殊案例和数据里能看到的共同点）、
// 推荐 recommendation（表现最好的取值和搭配；恒等式、缺数据或关系太弱时为 null，noRecommendation 写原因）。
// peers：同类店对比（peers.ts）。只有能落到门店层面的线才有；放在依据里，落后的店放在推荐里。
export type InsightEdge = {
  from: InsightNodeId; to: InsightNodeId; strength: InsightStrength; score?: InsightScore; effect?: InsightEffect;
  card: InsightCard; basis: string; chart?: InsightChart; outliers?: InsightOutliers; anomalies: string[]; recommendation: string | null; noRecommendation?: string; peers?: InsightPeers;
};
// 和同类店差得特别多的门店：一句总述 + 一店一行（门店、值、同类一般水平、主要原因、和同类比），给页面画成表；text 是同样内容的文字版，给问答用。
export type InsightOutliers = { metric: string; summary: string; head: string[]; rows: string[][]; foot?: string; text: string[] };
// verdict：works 参数有利的那头结果更好；flat 两头差不多或各组方向不一；reverse 和图上的方向相反。
export type InsightPeerSide = { param: string; outcome: string; value: number };
// lagRows：落后店的结构化数据（店名、结果值、同类一般水平），给业务卡片画条。
export type InsightPeers = {
  text: string; verdict: "works" | "flat" | "reverse"; groups: number; agree: number; stores: number;
  example: { group: string; n: number; k: number; param: string; outcome: string; hi: InsightPeerSide; lo: InsightPeerSide };
  laggards: string[]; lagRows: Array<{ name: string; value: number; peer: number }>;
};

export type InsightKpi = { id: "sales" | "gp" | "qty"; label: string; value: string; unit: string; detail: string };
export type InsightGraph = {
  schema: "insight-drivers/v2"; datasetVersion: string; builtAt: string;
  scope: { period: string; rows: number; stores: number; note: string };
  kpis: InsightKpi[]; nodes: InsightNode[]; edges: InsightEdge[]; summary: string[]; methods: Array<{ title: string; text: string }>;
};

export const INSIGHT_STRENGTH_LABEL: Record<InsightStrength, string> = { strong: "强", med: "中", weak: "弱", id: "拆解", missing: "缺数据" };
export const INSIGHT_KIND_LABEL: Record<InsightNodeKind, string> = { leaf: "细项因素", factor: "因素", decomp: "指标拆解", metric: "指标" };
export const INSIGHT_EDGE_SOURCE: Record<InsightStrength, string> = {
  strong: "数据算出的关联；强、中、弱的分档是按解释比例定的",
  med: "数据算出的关联；强、中、弱的分档是按解释比例定的",
  weak: "数据算出的关联；强、中、弱的分档是按解释比例定的",
  id: "定义（恒等式）；分数是对数方差拆分",
  missing: "AI 推测，没有数据",
};
