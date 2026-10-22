import assert from "node:assert/strict";
import test from "node:test";
import { dummies, etaSquared, leastSquares, logSplit, strengthOf, twoWayShares, uniqueContributions, withinStoreDay, withinStoreDayFit } from "../app/lib/insight/stats.ts";
import { edgeKey, highlightOf, reach, routes, routesThrough } from "../app/lib/insight/paths.ts";
import { INSIGHT_NODE_IDS, INSIGHT_NODE_LABEL } from "../app/lib/insight/types.ts";
import { fakeGraph } from "./helpers/insight-fixture.ts";

test("最小二乘：精确还原系数，共线的列记 0", () => {
  const x = Float64Array.from([1, 2, 3, 4, 5]); const ones = new Float64Array(5).fill(1);
  const beta = leastSquares([ones, x, Float64Array.from(x, (v) => v * 2)], Float64Array.from(x, (v) => 3 + 2 * v));
  assert.ok(Math.abs(beta[0] - 3) < 1e-9);
  assert.ok(Math.abs(beta[1] + 2 * beta[2] - 2) < 1e-9);
});

test("双向固定效应：纯门店差异全归门店，纯日期差异全归日期", () => {
  const s = ["a", "a", "b", "b"]; const d = ["1", "2", "1", "2"];
  assert.ok(twoWayShares(s, d, Float64Array.from([1, 1, 5, 5])).store > 99);
  assert.ok(twoWayShares(s, d, Float64Array.from([1, 5, 1, 5])).day > 99);
});

test("同店同日：门店和日期的差异剔掉后，只剩活动本身的差", () => {
  const s = ["a", "a", "b", "b", "c", "c"]; const d = ["1", "2", "1", "2", "1", "2"];
  const x = Float64Array.from([0, 1, 0, 0, 1, 0]);
  const y = Float64Array.from([10, 12 + 3, 20, 22, 30 + 3, 32]);
  assert.ok(Math.abs(withinStoreDay(s, d, y, [x])[0] - 3) < 0.05);
  // 去掉门店、日期差异后，活动正好解释剩下的全部差异。
  assert.ok(withinStoreDayFit(s, d, y, [x]).r2 > 99);
});

test("独有贡献：和 y 无关的属性贡献约 0；哑变量以第一个取值为基准", () => {
  const a = ["x", "y", "x", "y", "x", "y", "x", "y"]; const b = ["p", "p", "q", "q", "p", "p", "q", "q"];
  const y = Float64Array.from(a, (v) => v === "x" ? 1 : 5);
  const r = uniqueContributions({ a, b }, y);
  assert.ok(r.unique.a > 0.99 && Math.abs(r.unique.b) < 1e-9);
  assert.equal(dummies(["b", "a", "b"]).length, 1);
  assert.ok(etaSquared(a, y) > 99);
});

test("订单数 × 客单价：客单不变时全部是订单数", () => {
  const out = logSplit([100, 200, 400], [1, 2, 4]);
  assert.ok(out.orders > 99 && out.aov < 1);
  assert.equal(strengthOf(12), "strong"); assert.equal(strengthOf(3), "med"); assert.equal(strengthOf(0.5), "weak");
});

test("图谱：节点齐全、名字固定，每条线两端都在图上，依据里的数字由代码填", () => {
  const g = fakeGraph();
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), [...INSIGHT_NODE_IDS].sort());
  for (const n of g.nodes) if (n.id !== "qixi") assert.equal(n.label, INSIGHT_NODE_LABEL[n.id]);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) { assert.ok(ids.has(e.from) && ids.has(e.to), edgeKey(e)); assert.ok(e.basis.length > 0); assert.doesNotMatch(e.basis, /NaN|undefined|Infinity/); }
  for (const n of g.nodes) { assert.doesNotMatch([n.subtitle, ...n.paragraphs].join(""), /NaN|undefined|Infinity/, n.id); assert.ok(n.source.how); }
  // 只有最右一列是指标，恒等式只连到拆解和指标。
  assert.deepEqual(g.nodes.filter((n) => n.column === 3).map((n) => n.id), ["qty", "sales", "gp"]);
  assert.ok(g.edges.filter((e) => e.strength === "id").every((e) => ["orders", "aov", "gm"].includes(e.from)));
});

test("图谱：合成数据里设定的关系能被认出来", () => {
  const g = fakeGraph();
  const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to)!;
  assert.equal(edge("image", "store").strength, "strong");
  assert.equal(edge("qixi", "day").strength, "strong");
  assert.equal(edge("weekday", "day").strength, "strong");
  assert.match(edge("depth", "promo").basis, /克减 30 是 24\.0 元，克减 50 是 54\.0 元/);
  assert.match(g.nodes.find((n) => n.id === "shift")!.paragraphs[0], /^8\/22 全国克减铺开后/);
  assert.match(g.nodes.find((n) => n.id === "member")!.paragraphs[0], /97\.7%/);
});

test("来源：缺数据的两项是待采集；AI 归类、AI 判断都写了 AI 的部分", () => {
  const g = fakeGraph();
  assert.deepEqual(g.nodes.filter((n) => n.source.kind === "suggested").map((n) => n.id), ["gold", "member"]);
  for (const n of g.nodes.filter((x) => x.source.kind === "grouping" || x.source.kind === "inferred")) assert.ok(n.source.judgement, n.id);
});

test("链路：节点往下走到指标，线的完整链路经过它本身；高亮只含上下游", () => {
  const g = fakeGraph();
  const down = routes(g, "threshold", "down");
  assert.ok(down.length >= 3 && down.every((p) => p[0].from === "threshold" && ["qty", "sales", "gp"].includes(p.at(-1)!.to)));
  assert.ok(routes(g, "sales", "up").every((p) => p.at(-1)!.to === "sales"));
  const edge = g.edges.find((e) => e.from === "promo" && e.to === "mix")!;
  assert.ok(routesThrough(g, edge).every((p) => p.some((e) => edgeKey(e) === "promo>mix") && p.at(-1)!.to === "gp"));
  const lit = highlightOf(g, { kind: "node", id: "region" })!;
  assert.ok(lit.nodes.has("store") && lit.nodes.has("sales") && !lit.nodes.has("qixi"));
  assert.ok(!reach(g, "region", "down").has("image"));
  assert.equal(highlightOf(g, { kind: "source", source: "suggested" })!.edges.size, 0);
});

test("解释度分数：除缺数据外每条线都有分数；因素线档位由分数换算，拆解线保持「拆解」；活动机制另带效应值", () => {
  const g = fakeGraph();
  for (const e of g.edges) {
    if (e.strength === "missing") { assert.equal(e.score, undefined, edgeKey(e)); continue; }
    assert.ok(e.score, `${edgeKey(e)} 缺分数`);
    assert.ok(e.score!.value >= 0 && e.score!.value <= 100); assert.ok(e.score!.measure);
    if (e.strength !== "id") assert.equal(e.strength, strengthOf(e.score!.value), edgeKey(e));
  }
  assert.deepEqual(g.edges.filter((e) => e.strength === "id").map(edgeKey).sort(), ["aov>sales", "gm>gp", "orders>qty", "orders>sales"]);
  for (const id of ["depth", "threshold", "tradein", "shift"]) { const e = g.edges.find((x) => x.from === id)!; assert.ok(e.effect?.text, id); assert.ok(g.nodes.find((n) => n.id === id)!.score, id); }
});

test("每条线都有依据、异常、推荐三段；没有推荐时写原因", () => {
  const g = fakeGraph();
  for (const e of g.edges) {
    assert.ok(e.basis.length > 0); assert.ok(Array.isArray(e.anomalies));
    assert.ok(e.recommendation || e.noRecommendation, `${edgeKey(e)} 没推荐也没原因`);
    for (const t of [e.basis, ...e.anomalies, e.recommendation ?? ""]) assert.doesNotMatch(t, /NaN|undefined|Infinity/, edgeKey(e));
  }
  assert.ok(g.edges.filter((e) => e.strength === "id").every((e) => !e.recommendation && /恒等式/.test(e.noRecommendation!)));
});

test("依据里的图：每个有数据的节点和每条有分数的线都带图，图上的数是有限值", () => {
  const g = fakeGraph();
  const values = (c: NonNullable<typeof g.nodes[number]["chart"]>): number[] => c.kind === "bars" ? c.bars.map((b) => b.value) : c.kind === "split" ? c.parts.map((p) => p.value)
    : c.kind === "columns" ? c.points.flatMap((p) => p.values) : c.kind === "lines" ? c.series.flatMap((s) => s.values) : [...c.points.flat(), c.fit.slope, c.fit.intercept];
  for (const n of g.nodes) if (n.source.kind !== "suggested" && n.id !== "areaage") assert.ok(n.chart, n.id);
  for (const e of g.edges) if (e.score && e.from !== "areaage") assert.ok(e.chart, edgeKey(e));
  for (const c of [...g.nodes.map((n) => n.chart), ...g.edges.map((e) => e.chart)]) if (c) {
    assert.ok(values(c).length > 0 && values(c).every(Number.isFinite), c.title);
    assert.doesNotMatch(JSON.stringify(c), /NaN|undefined|Infinity/);
  }
  // 日期和活动：逐日堆叠柱，标出克减铺开的区间和七夕当天。
  const day = g.nodes.find((n) => n.id === "day")!.chart!;
  assert.equal(day.kind, "columns");
  if (day.kind === "columns") { assert.equal(day.points.length, 31); assert.deepEqual(day.band && [day.band.from, day.band.to], ["8/22", "8/31"]); assert.equal(day.points.find((p) => p.mark)?.label, "8/29"); }
  // 货品结构 → 毛利率：散点的拟合线往下走。
  const mix = g.edges.find((e) => e.from === "mix" && e.to === "gm")!.chart!;
  assert.ok(mix.kind === "scatter" && mix.fit.slope < 0);
});

test("指标的图：两个乘数两条线，都是平常工作日的几倍", () => {
  const g = fakeGraph();
  for (const id of ["qty", "sales", "gp"] as const) {
    const c = g.nodes.find((n) => n.id === id)!.chart!;
    assert.equal(c.kind, "lines", id);
    if (c.kind !== "lines") continue;
    assert.equal(c.series.length, 2); assert.equal(c.labels.length, 31);
    for (const s of c.series) { assert.equal(s.values.length, 31); assert.equal(s.hover.length, 31); }
    // 8/22 前的周一就是平常工作日，两条线都在 1 倍附近。
    const i = c.labels.indexOf("8/4"); for (const s of c.series) assert.ok(Math.abs(s.values[i] - 1) < 0.5, `${id} ${s.label} ${s.values[i]}`);
    assert.deepEqual(c.marks?.map((m) => m.at), ["8/29"]);
  }
  assert.deepEqual((g.nodes.find((n) => n.id === "qty")!.chart as { series: Array<{ label: string }> }).series.map((s) => s.label), ["订单数", "单均件数"]);
});
