import assert from "node:assert/strict";
import test from "node:test";
import { dummies, etaSquared, leastSquares, logLinearFit, logSplit, strengthOf, twoWayShares, uniqueContributions, withinStoreDay, withinStoreDayBands, withinStoreDayFit } from "../app/lib/insight/stats.ts";
import { edgeKey, highlightOf, reach, routes, routesThrough } from "../app/lib/insight/paths.ts";
import { INSIGHT_NODE_IDS, INSIGHT_NODE_LABEL, type InsightChart } from "../app/lib/insight/types.ts";
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

test("对数线性回归：还原已知斜率和截距", () => {
  const xs = [1, 2, 4, 8, 16, 32];
  const trueSlope = 0.3; const trueIntercept = Math.log(50);
  const ys = xs.map((x) => Math.exp(trueIntercept + trueSlope * Math.log(x)));
  const fit = logLinearFit(xs, ys);
  assert.ok(Math.abs(fit.slope - trueSlope) < 1e-6);
  assert.ok(Math.abs(fit.intercept - trueIntercept) < 1e-6);
  assert.ok(fit.sigma < 1e-6); // 完全拟合，残差几乎为 0
  assert.ok(fit.r2 > 0.999);
});

test("对数线性回归：加噪声后 sigma 和 r2 反映离散程度", () => {
  const xs = [1, 2, 4, 8, 16, 32, 64, 128];
  const ys = xs.map((x, i) => Math.exp(0.3 * Math.log(x) + (i % 2 === 0 ? 0.1 : -0.1)));
  const fit = logLinearFit(xs, ys);
  assert.ok(fit.sigma > 0 && fit.sigma < 1);
  assert.ok(fit.r2 >= 0 && fit.r2 <= 1);
});

test("对数线性回归：样本太少或含非正数时不崩", () => {
  assert.doesNotThrow(() => logLinearFit([1], [10]));
  assert.doesNotThrow(() => logLinearFit([], []));
  const fit = logLinearFit([1, -2], [10, 20]);
  assert.ok(Number.isFinite(fit.slope) && Number.isFinite(fit.intercept) && Number.isFinite(fit.sigma));
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

test("同店不同日分档：门店大小、全国日期起落去掉后，认得出先升后降和单调", () => {
  // 10 家店 × 40 天：店的规模差 10 倍、日期有起落，这些都不该进到分档结果里；x 只在店内变化。
  const s: string[] = []; const d: string[] = []; const x: number[] = []; const peak: number[] = []; const up: number[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 40; j++) {
    const xi = ((i * 7 + j * 13) % 40) / 20 - 1; // −1 … +1，店内各天都有
    s.push(`S${i}`); d.push(`D${j}`); x.push(xi);
    const fe = Math.log(1 + i) + 0.3 * Math.sin(j);
    peak.push(fe - xi * xi); up.push(fe + 0.5 * xi);
  }
  const bands = withinStoreDayBands(s, d, Float64Array.from(x), [Float64Array.from(peak), Float64Array.from(up)], 8);
  assert.equal(bands.length, 8); assert.equal(bands.reduce((a, b) => a + b.n, 0), 400);
  for (let k = 1; k < 8; k++) assert.ok(bands[k].x >= bands[k - 1].x);
  const p = bands.map((b) => b.ys[0]); const top = p.indexOf(Math.max(...p));
  assert.ok(top > 0 && top < 7 && p[top] - p[0] > 0.3 && p[top] - p[7] > 0.3, `先升后降 ${p}`);
  const u = bands.map((b) => b.ys[1]); for (let k = 1; k < 8; k++) assert.ok(u[k] > u[k - 1], `单调 ${u}`);
  assert.deepEqual(withinStoreDayBands(["a"], ["1"], Float64Array.from([1]), [Float64Array.from([1])], 8), []);
});

test("联动：每克价格、毛利率、每件克重挂同一张多参数联动图，每档 单数 × 客单价 = 销售额", () => {
  const g = fakeGraph();
  for (const [id, initial] of [["depth", "price"], ["gm", "gm"], ["threshold", "weight"]] as const) {
    const sim = g.nodes.find((n) => n.id === id)!.card.sim!;
    assert.equal(sim.kind, "levers", id);
    if (sim.kind !== "levers") continue;
    assert.equal(sim.initial, initial); assert.ok(sim.levers.some((l) => l.id === initial));
    assert.ok(sim.base.items >= sim.base.orders && sim.base.orders > 0 && sim.base.aov > 0 && sim.base.gp > 0 && sim.base.gm > 0 && sim.base.gm < 100, JSON.stringify(sim.base));
    for (const l of sim.levers) {
      for (const col of [l.xs, l.orders, l.aov, l.items, l.gp, l.revEx]) assert.equal(col.length, 10, `${l.id} 档数`);
      for (let k = 1; k < 10; k++) assert.ok(l.xs[k] >= l.xs[k - 1], `${l.id} 横轴要从低到高`);
      assert.ok(l.xs[0] < 0 && l.xs[9] > 0, `${l.id} 横轴要跨过「平时」 ${l.xs}`);
      for (const v of [...l.orders, ...l.aov, ...l.items, ...l.gp, ...l.revEx]) assert.ok(v > 0 && Number.isFinite(v), `${l.id} ${v}`);
      assert.doesNotMatch([l.label, l.axis, l.note].join(" "), JARGON, l.id);
    }
    assert.doesNotMatch([sim.title, sim.note ?? ""].join(" "), JARGON, id);
    assert.doesNotMatch(JSON.stringify(sim), /NaN|undefined|Infinity/, id);
  }
});

test("订单数/客单价：card.sim 挂了 linked 图，基准值是日均口径的中位数店", () => {
  const g = fakeGraph();
  const orders = g.nodes.find((n) => n.id === "orders")!;
  const aov = g.nodes.find((n) => n.id === "aov")!;
  assert.equal(orders.card.sim?.kind, "linked");
  assert.equal(aov.card.sim?.kind, "linked");
  // node.chart（既有的商圈/活动力度对比图）不受影响，继续存在。
  assert.ok(orders.chart); assert.ok(aov.chart);
  assert.notEqual(orders.chart?.kind, "linked"); assert.notEqual(aov.chart?.kind, "linked");
  // 两个节点共享同一份回归系数（同一次计算），两个方向各自独立（不是互为代数反解）。
  const oc = orders.card.sim as Extract<InsightChart, { kind: "linked" }>;
  const ac = aov.card.sim as Extract<InsightChart, { kind: "linked" }>;
  assert.equal(oc.aToB.slope, ac.aToB.slope); assert.equal(oc.bToA.slope, ac.bToA.slope);
  assert.equal(oc.aToB.intercept, ac.aToB.intercept);
  // 基准值是正数、在 min/max 范围内。
  assert.ok(oc.a.base > 0 && oc.a.base >= oc.a.min && oc.a.base <= oc.a.max);
  assert.ok(oc.b.base > 0 && oc.b.base >= oc.b.min && oc.b.base <= oc.b.max);
  // 回归和展示用同一口径（日均）：在基准订单数处，aToB 算出的建议客单价要落在 b 的范围内，且接近真实基准客单价
  // （口径不一致时，比如误用月度口径拟合去推日均基准值，这里会系统性偏离，参见 ledger Final 裁决）。
  const suggestedB = Math.exp(oc.aToB.intercept + oc.aToB.slope * Math.log(oc.a.base));
  assert.ok(suggestedB >= oc.b.min * 0.5 && suggestedB <= oc.b.max * 1.5, `建议值 ${suggestedB} 应接近真实范围 [${oc.b.min}, ${oc.b.max}]`);
});

test("图谱：合成数据里设定的关系能被认出来", () => {
  const g = fakeGraph();
  const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to)!;
  assert.equal(edge("image", "store").strength, "strong");
  assert.equal(edge("qixi", "day").strength, "strong");
  assert.equal(edge("weekday", "day").strength, "strong");
  assert.match(edge("depth", "promo").basis, /克减 50 54\.0 元，克减 30 24\.0 元/);
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
    : c.kind === "columns" ? c.points.flatMap((p) => p.values) : c.kind === "lines" ? c.series.flatMap((s) => s.values.filter((v): v is number => v !== null)) : c.kind === "compare" ? c.items.map((x) => x.value) 
    : c.kind === "linked" ? [c.a.base, c.b.base, c.aToB.slope, c.aToB.intercept, c.aToB.sigma, c.bToA.slope, c.bToA.intercept, c.bToA.sigma]
    : c.kind === "levers" ? [c.base.items, c.base.orders, c.base.aov, ...c.levers.flatMap((l) => [...l.xs, ...l.orders, ...l.aov, ...l.items, ...l.gp, ...l.revEx])] : [...c.points.flat(), c.fit.slope, c.fit.intercept];
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
  // 货品结构 → 毛利率：按计价金占比分档，档位越高毛利率越低。
  const mix = g.edges.find((e) => e.from === "mix" && e.to === "gm")!.chart!;
  assert.ok(mix.kind === "bars" && mix.bars.length >= 3 && mix.bars[0].value > mix.bars.at(-1)!.value, JSON.stringify(mix));
});

test("指标的图：两条折线，横轴是门店分档不是时间；结果一路往上，另一个乘数贴着 1 倍", () => {
  const g = fakeGraph();
  for (const id of ["qty", "sales", "gp"] as const) {
    const c = g.nodes.find((n) => n.id === id)!.chart!;
    assert.equal(c.kind, "lines", id);
    if (c.kind !== "lines") continue;
    assert.ok(c.labels.length >= 3 && c.labels.length <= 5, `${id} 档位数 ${c.labels.length}`);
    assert.ok(c.labels.every((x) => !/^\d+\/\d+$/.test(x)), `${id} 横轴不能是日期`);
    assert.equal(c.series.length, 2);
    for (const s of c.series) { assert.equal(s.values.length, c.labels.length); assert.equal(s.hover.length, c.labels.length); }
    // 结果那条线最后一档比第一档高。
    assert.ok(c.series[0].values.at(-1)! > 1, `${id} ${JSON.stringify(c.series[0].values)}`);
    assert.match(c.base ?? "", /那一档$/);
  }
  const qty = g.nodes.find((n) => n.id === "qty")!.chart as { series: Array<{ label: string }>; title: string };
  assert.deepEqual(qty.series.map((s) => s.label), ["销量", "每单件数"]);
  assert.match(qty.title, /每单件数几乎不变/);
});

// 给总部业务看的卡片：一句话结论、怎么知道的、要注意、可以怎么做。
// 「对数」只拦统计说法（对数销售额、取对数），「和 Power BI 对数」是核对数字，不算。
const JARGON = /独有|解释度|R²|MAD|四分之一|对数(?:销售|刻度|方差|差异)|取对数|恒等式|固定效应|方差|样本|中位数|\dpp|偏 R/;
test("业务卡片：每个节点和每条线都有，结论和建议里没有统计说法", () => {
  const g = fakeGraph();
  const cards = [...g.nodes.map((n) => [n.id, n.card] as const), ...g.edges.map((e) => [edgeKey(e), e.card] as const)];
  for (const [id, c] of cards) {
    assert.ok(c && c.say && c.how, `${id} 没有卡片`);
    const text = [c.say, c.how, ...c.watch, c.todo ?? c.todoNote ?? "", c.chart?.title ?? ""].join(" ");
    assert.doesNotMatch(text, JARGON, id);
    assert.doesNotMatch(text, /NaN|undefined|Infinity/, id);
    // 有建议就必须带支撑它的数据；没有建议要写原因。
    if (c.todo) assert.ok(c.evidence.length > 0, `${id} 的建议没有数据`); else assert.ok(c.todoNote, `${id} 没建议也没原因`);
  }
  const say = (id: string) => g.nodes.find((n) => n.id === id)!.card.say;
  assert.match(say("image"), /【[\d,]+ 万】/);
  assert.match(say("day"), /倍】/);
  // 对比图：灰色对照只有一档，最突出的一档用主色。
  const day = g.nodes.find((n) => n.id === "day")!.card.chart!;
  assert.ok(day.kind === "compare" && day.items.filter((x) => x.tone === "base").length === 1 && day.items.some((x) => x.tone === "hot"));
  // 门店名带到「要注意」里时，每家都和同类一般水平比。
  const mix = g.edges.find((e) => e.from === "mix" && e.to === "gm")!.card;
  if (mix.stores) for (const r of mix.stores.rows) assert.ok(r.value < mix.stores.peer, r.name);
});

test("指标卡片：两个乘数各高多少、结果跟着高多少；下面挂联动面板，标出这个指标", () => {
  const g = fakeGraph();
  for (const [id, a, b] of [["sales", "订单数", "客单价"], ["qty", "订单数", "每单件数"], ["gp", "销售额", "毛利率"]] as const) {
    const card = g.nodes.find((n) => n.id === id)!.card;
    const c = card.chart!; assert.equal(c.kind, "lines", id);
    if (c.kind === "lines") {
      assert.deepEqual(c.series.map((x) => x.label), [a, b]);
      assert.equal(c.labels.length, 6); assert.equal(c.labels[2], "持平");
      // 和同类持平的那一档，结果也在 1 倍附近。
      for (const line of c.series) if (line.values[2] !== null) assert.ok(Math.abs(line.values[2] - 1) < 0.3, `${id} ${line.label} ${line.values[2]}`);
    }
    // 指标下面挂联动面板，打开时标出这个指标的格子。
    const sim = card.sim!; assert.equal(sim.kind, "levers", id);
    if (sim.kind === "levers") assert.equal(sim.focus, id);
  }
});
