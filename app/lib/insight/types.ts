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
export type InsightNode = {
  id: InsightNodeId; column: InsightColumn; section?: InsightSection; kind: InsightNodeKind;
  label: string; subtitle: string; strength?: InsightStrength; score?: InsightScore; effect?: InsightEffect;
  // 拆解列和指标列直接写数值（如「87.3 亿」「9,682 元」），图上常态只显示这个。
  value?: string;
  source: InsightSource; paragraphs: string[]; table?: InsightTable; note?: string;
};
// 每条线三部分（2026-10-19 会议定的）：依据 basis（数据验证的关联）、异常 anomalies（特殊案例和数据里能看到的共同点）、
// 推荐 recommendation（表现最好的取值和搭配；恒等式、缺数据或关系太弱时为 null，noRecommendation 写原因）。
// peers：同类店对比（peers.ts）。只有能落到门店层面的线才有；放在依据里，落后的店放在推荐里。
export type InsightEdge = {
  from: InsightNodeId; to: InsightNodeId; strength: InsightStrength; score?: InsightScore; effect?: InsightEffect;
  basis: string; anomalies: string[]; recommendation: string | null; noRecommendation?: string; peers?: InsightPeers;
};
// verdict：works 参数有利的那头结果更好；flat 两头差不多或各组方向不一；reverse 和图上的方向相反。
export type InsightPeerSide = { param: string; outcome: string; value: number };
export type InsightPeers = {
  text: string; verdict: "works" | "flat" | "reverse"; groups: number; agree: number; stores: number;
  example: { group: string; n: number; k: number; param: string; outcome: string; hi: InsightPeerSide; lo: InsightPeerSide };
  laggards: string[];
};

// 图上一步一步讲的结论：一句话 + 点亮的链路（从因素到指标）。summary 和它一一对应。
export type InsightStory = { title: string; text: string; path: InsightNodeId[] };
export type InsightKpi = { id: "sales" | "gp" | "qty"; label: string; value: string; unit: string; detail: string };
export type InsightGraph = {
  schema: "insight-drivers/v2"; datasetVersion: string; builtAt: string;
  scope: { period: string; rows: number; stores: number; note: string };
  kpis: InsightKpi[]; nodes: InsightNode[]; edges: InsightEdge[]; summary: string[]; stories: InsightStory[]; methods: Array<{ title: string; text: string }>;
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
