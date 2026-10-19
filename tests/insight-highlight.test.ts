import assert from "node:assert/strict";
import test from "node:test";
import { buildInsightGraph } from "../app/lib/insight/score.ts";
import { highlightOf, lineKey } from "../app/lib/insight/highlight.ts";
import type { InsightCell } from "../app/lib/insight/types.ts";

const cell = (over: Partial<InsightCell>): InsightCell => ({ value: "全部", side: "offer", day: "20250801", rows: 1000, stores: 50, amount: 1000, grams: 1, quantity: 1, tagAmount: 1100, profit: 100, orders: 1, lines: 1, tradeInOrders: 0, agedAmount: 0, keySeriesAmount: 0, returnAmount: 0, ...over });
// 城市级别：单件克重差别大，每克让利一样；门店面积：什么都一样。
const city = (value: string, gramsPerItem: number) => [cell({ value, amount: 9800, grams: 10, quantity: 10 / gramsPerItem }), cell({ value, side: "base", amount: 10000, grams: 10, quantity: 1.25 })];
const flat = (value: string) => [cell({ value, amount: 9800, grams: 10, quantity: 1.25 }), cell({ value, side: "base", amount: 10000, grams: 10, quantity: 1.25 })];
const graph = buildInsightGraph({ request: { metric: "give_per_gram", offer: "克减类", category: "一般足金类" }, datasetVersion: "v", builtAt: "x", total: flat("全部"),
  cubes: [{ dimension: "cityTier", cells: [...city("一线", 4), ...city("二线", 12), ...city("三线", 8)] }, { dimension: "storeArea", cells: [...flat("小"), ...flat("中"), ...flat("大")] }] });

test("点维度：亮到中心的路径，列出它明显影响的指标", () => {
  const h = highlightOf(graph, { kind: "node", id: "dim:cityTier" })!;
  for (const id of ["dim:cityTier", "group:store", "metric"]) assert.ok(h.nodes.has(id), id);
  assert.ok(h.lines.has(lineKey.dimension("cityTier")) && h.lines.has(lineKey.center("store")));
  assert.ok(h.metrics.has("grams_per_item"));
  assert.ok(!h.metrics.has("give_per_gram"));
  assert.ok(!h.nodes.has("dim:storeArea"));
});

test("点组：亮组下全部维度和待采集项", () => {
  const h = highlightOf(graph, { kind: "node", id: "group:param" })!;
  assert.ok(h.nodes.has("missing:param:门槛与封顶") && h.nodes.has("dim:offerDepth"));
  assert.ok(h.lines.has(lineKey.missing("missing:param:门槛与封顶")));
});

test("点待采集项：亮它推测会影响的维度（一路到中心）和指标", () => {
  const h = highlightOf(graph, { kind: "node", id: "missing:param:门槛与封顶" })!;
  assert.ok(h.nodes.has("dim:offerDepth") && h.nodes.has("dim:itemWeight") && h.nodes.has("metric"));
  assert.ok(h.metrics.has("grams_per_item"));
  assert.equal(h.metrics.get("grams_per_item"), null);
});

test("点中心到组的线等于点组；按来源类型筛只亮这一类", () => {
  assert.deepEqual([...highlightOf(graph, { kind: "link", group: "store", to: "center" })!.nodes].sort(), [...highlightOf(graph, { kind: "node", id: "group:store" })!.nodes].sort());
  const ai = highlightOf(graph, { kind: "source", source: "inferred" })!;
  assert.ok(ai.nodes.has("dim:offerDepth") && ai.nodes.has("dim:storeAge"));
  assert.ok(!ai.nodes.has("dim:cityTier"));
  const real = highlightOf(graph, { kind: "source", source: "field" })!;
  assert.ok(real.nodes.has("dim:cityTier") && !real.nodes.has("dim:offerDepth"));
});
