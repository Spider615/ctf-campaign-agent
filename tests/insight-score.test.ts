import assert from "node:assert/strict";
import test from "node:test";
import { alignedGive, buildInsightGraph, type DimensionCube } from "../app/lib/insight/score.ts";
import type { InsightCell, InsightRequest } from "../app/lib/insight/types.ts";

const cell = (over: Partial<InsightCell>): InsightCell => ({ value: "全部", side: "offer", day: "20250801", rows: 1000, stores: 50, amount: 1000, grams: 1, quantity: 1, tagAmount: 1100, profit: 100, orders: 1, lines: 1, tradeInOrders: 0, agedAmount: 0, keySeriesAmount: 0, returnAmount: 0, ...over });
const request: InsightRequest = { metric: "give_per_gram", offer: "克减类", category: "一般足金类" };
// 一个取值的格子：活动每克 base - give，对照每克 base。
const pair = (value: string, give: number, rows = 1000, base = 1000): InsightCell[] => [
  cell({ value, side: "offer", amount: (base - give) * 10, grams: 10, rows }),
  cell({ value, side: "base", amount: base * 10, grams: 10, rows }),
];
const build = (cubes: DimensionCube[], over: Partial<Parameters<typeof buildInsightGraph>[0]> = {}) =>
  buildInsightGraph({ request, datasetVersion: "v1", builtAt: "2026-10-19T00:00:00Z", total: pair("全部", 20), cubes, ...over });
const edge = (graph: ReturnType<typeof build>, dim: string) => graph.edges.find((e) => e.dimension === dim)!;

test("每克让利按日对齐：逐日求差再按活动克重加权", () => {
  const cells = [
    cell({ day: "d1", side: "offer", amount: 1000, grams: 1 }), cell({ day: "d1", side: "base", amount: 1100, grams: 1 }),
    cell({ day: "d2", side: "offer", amount: 2000, grams: 2 }), cell({ day: "d2", side: "base", amount: 2100, grams: 2 }),
  ];
  // d1 差 100，d2 差 50；按活动克重加权 (100×1 + 50×2) / 3。
  assert.ok(Math.abs(alignedGive(cells).value! - 200 / 3) < 1e-9);
  // 活动集中在金价低的日子：不对齐直接比整体每克会把金价差算成让利。
  // d1 金价 1100、活动 9 克每克 1000；d2 金价 1000、只有对照 9 克。整体对照每克 1050，直接相减得 50，对齐后是 100。
  const skewed = [cell({ day: "d1", side: "offer", amount: 9000, grams: 9 }), cell({ day: "d1", side: "base", amount: 9900, grams: 9 }), cell({ day: "d2", side: "base", amount: 9000, grams: 9 })];
  assert.equal(alignedGive(skewed).value, 100);
  // 没有同日对照的克重计入丢弃比例。
  assert.equal(alignedGive([cell({ day: "d1", grams: 1 }), cell({ day: "d1", side: "base", grams: 1 }), cell({ day: "d3", grams: 3 })]).droppedShare, 0.75);
});

test("各取值差值相同为弱关系，不给建活动草稿；差别明显时为强关系", () => {
  const flat = build([{ dimension: "cityTier", cells: ["一线", "二线", "三线"].flatMap((v) => pair(v, 20)) }]);
  assert.equal(edge(flat, "cityTier").weak, true);
  assert.equal(edge(flat, "cityTier").draft, null);
  const steep = build([{ dimension: "cityTier", cells: [...pair("一线", 10), ...pair("二线", 20), ...pair("三线", 60)] }]);
  const e = edge(steep, "cityTier");
  assert.equal(e.weak, false);
  // 每克让利越少越好：最优是一线。
  assert.equal(e.best, "一线");
  assert.match(e.recommendation!, /^8 月里「一线」/);
  assert.doesNotMatch(e.recommendation!, /会|将|提升/);
  assert.ok(e.draft?.endsWith("："));
});

test("样本少的取值不参与比较和推荐，但仍出现在取值表里", () => {
  const graph = build([{ dimension: "shopType", cells: [...pair("购物中心", 30), ...pair("百货", 40), ...pair("街铺", 1, 100)] }]);
  const e = edge(graph, "shopType");
  assert.equal(e.table.find((r) => r.value === "街铺")?.small, true);
  assert.equal(e.best, "购物中心");
  assert.ok(e.basis.every((line) => !line.includes("街铺")));
});

test("离群取值进异常，带可能原因", () => {
  const values = ["A", "B", "C", "D", "E", "F"].flatMap((v, i) => pair(v, 10 + (i % 2)));
  const odd = [cell({ value: "G", side: "offer", amount: 9200, grams: 10, quantity: 1, rows: 1000, stores: 10 }), cell({ value: "G", side: "base", amount: 10000, grams: 10, rows: 1000 })];
  const e = edge(build([{ dimension: "region", cells: [...values, ...odd] }]), "region");
  assert.equal(e.anomalies.length, 1);
  assert.match(e.anomalies[0], /^G：/);
  assert.match(e.anomalies[0], /只有约 10 家店/);
});

test("数据缺失的维度画成待采集节点，不连线", () => {
  const graph = build([], { unavailable: { offerDepth: "表里没有优惠小类" } });
  const node = graph.nodes.find((n) => n.id === "dim:offerDepth")!;
  assert.equal(node.status, "missing");
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.nodes.some((n) => n.kind === "missing" && n.note?.includes("Discount")));
});

test("指标本身缺列时中心节点为待采集，没有连线", () => {
  const graph = buildInsightGraph({ request: { ...request, metric: "trade_in_rate" }, datasetVersion: "v1", builtAt: "x", total: pair("全部", 20), cubes: [{ dimension: "cityTier", cells: pair("一线", 1) }], unavailableMetrics: { trade_in_rate: "表里没有回收金标识" } });
  assert.equal(graph.metric.status, "missing");
  assert.equal(graph.edges.length, 0);
});

test("分解四段的占比合计为 1", () => {
  const total = [cell({ side: "offer", orders: 120, lines: 150, grams: 900, amount: 900_000 }), cell({ side: "base", orders: 100, lines: 140, grams: 800, amount: 860_000 })];
  const graph = build([], { total });
  const sum = graph.decomposition.reduce((s, d) => s + (d.share ?? 0), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("节点带来源；维度的影响范围由数据算，待采集项的影响范围是 AI 推测", () => {
  // 城市级别下单件克重差别大、每克让利一样：点城市级别应高亮单件克重，不高亮每克让利。
  const mk = (value: string, gramsPerItem: number): InsightCell[] => [
    cell({ value, side: "offer", amount: 9800, grams: 10, quantity: 10 / gramsPerItem }), cell({ value, side: "base", amount: 10000, grams: 10, quantity: 10 / 8 }),
  ];
  const graph = build([{ dimension: "cityTier", cells: [...mk("一线", 4), ...mk("二线", 12), ...mk("三线", 8)] }]);
  const node = graph.nodes.find((n) => n.id === "dim:cityTier")!;
  assert.equal(node.source.kind, "field");
  assert.ok(node.affects!.metrics.includes("grams_per_item"));
  assert.ok(!node.affects!.metrics.includes("give_per_gram"));
  assert.ok((graph.influence.cityTier?.grams_per_item ?? 0) > (graph.influence.cityTier?.give_per_gram ?? 0));
  const missing = graph.nodes.find((n) => n.id === "missing:param:门槛与封顶")!;
  assert.equal(missing.source.kind, "suggested");
  assert.ok(missing.affects!.dimensions.includes("offerDepth"));
  assert.equal(graph.nodes.find((n) => n.id === "group:store")!.source.kind, "grouping");
});

test("对照接近 0 的指标不会因量级太小把强度顶满", () => {
  // 折扣率：活动 ~3.5%，对照 ~0.5%；城市间活动折扣率只差 0.2 个百分点，相对 3 个百分点的整体差是弱关系。
  const mk = (value: string, offerRate: number): InsightCell[] => [
    cell({ value, side: "offer", amount: 10000 * (1 - offerRate), tagAmount: 10000, grams: 10 }), cell({ value, side: "base", amount: 9950, tagAmount: 10000, grams: 10 }),
  ];
  const graph = buildInsightGraph({ request: { ...request, metric: "discount_rate" }, datasetVersion: "v", builtAt: "x", total: [...mk("全部", 0.035)], cubes: [{ dimension: "cityTier", cells: [...mk("一线", 0.036), ...mk("二线", 0.035), ...mk("三线", 0.034)] }] });
  assert.equal(graph.edges[0].weak, true);
});
