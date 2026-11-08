import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createInsightGraphService, insightQueries, toDriverData } from "../agent/insight-graph.ts";
import type { HistoryConnection } from "../agent/analytics-database.ts";
import { fakeResults, fakeResultsIn } from "./helpers/insight-fixture.ts";
import { highlightOf } from "../app/lib/insight/paths.ts";
import { loadReactComponent } from "./helpers/react-component.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { comparePeriods } from "../app/lib/insight/comparison.ts";
import { parseSelection as parseUrlSelection, selectionSearch } from "../app/lib/insight/context.ts";
import { buildComparisonGraph } from "../app/lib/insight/comparison-graph.ts";
import { askContext } from "../app/lib/insight/ask.ts";

const range = { from: "20250823", to: "20250829" };

type RawPanel = Record<string, string | number | null | undefined>;
const row = (store: string, d: string, sales = 100, extra: RawPanel = {}): RawPanel => ({ store, d, sales, gp: sales / 5, rev_ex: sales, items: 2, orders: 1, gold: sales / 2, base_gold: 0, heavy_gold: 0, gold_grams: 1, gold_qty: 1, k50: 0, k30: 0, gt: 0, ...extra });
const smallRange = { from: "20250823", to: "20250825" };

async function syntheticGraph(panel: RawPanel[], window = smallRange, options: { festivals?: string[]; rollout?: string | null } = {}) {
  const names = new Map([...Object.entries(insightQueries("t")), ...Object.entries(insightQueries("t", true))].map(([key, sql]) => [sql, key]));
  const connection: HistoryConnection = {
    async query() { return [[], []]; },
    async execute(sql: string, params: string[] = []) {
      if (sql.includes("AS min_day")) return [[{ n: 10, min_day: "20250801", max_day: "20250831" }], []];
      const all = fakeResults();
      const picked = params.length ? panel.filter((p) => String(p.d) >= params[0] && String(p.d) <= params[1]) : panel;
      const data = { ...all, panel: picked, ptype: [{ ptype: "计价金", sales: picked.reduce((a, p) => a + Number(p.sales ?? 0), 0), gp: picked.reduce((a, p) => a + Number(p.gp ?? 0), 0), rev_ex: 100, items: picked.reduce((a, p) => a + Number(p.items ?? 0), 0), grams: 1 }],
        daily: all.daily.map((d) => ({ ...d, festival: options.festivals?.includes(d.d) ? "其他节日" : d.festival, promo_gold: options.rollout === null || (options.rollout && d.d < options.rollout) ? "0" : options.rollout ? "2" : d.promo_gold, base_gold: options.rollout === undefined ? d.base_gold : "1" })) };
      return [data[names.get(sql) as keyof typeof data] ?? [], []];
    }, destroy() {},
  };
  const service = createInsightGraphService({ table: "t", evidenceDir: "/tmp/insight-comparison-test", connect: async () => connection, logger: { log() {}, error() {} } });
  return service.graph(window);
}

test("规模差十倍的门店同幅增长，变化率一致；周末原本高不会制造涨幅", async () => {
  const rates: number[] = [];
  for (const scale of [1, 10]) {
    const graph = await syntheticGraph([row("S0", "20250802", 300 * scale), row("S0", "20250809", 300 * scale), row("S0", "20250823", 360 * scale)]);
    assert.ok(graph.comparison);
    rates.push(graph.comparison.metrics.sales!.rate!);
  }
  assert.deepEqual(rates, [20, 20]);
  const weekend = await syntheticGraph([row("S0", "20250802", 300), row("S0", "20250809", 300), row("S0", "20250804", 100), row("S0", "20250811", 100), row("S0", "20250823", 300)]);
  assert.equal(weekend.comparison!.metrics.sales!.delta, 0);
});

test("同星期匹配只用范围前、非节日、铺开前日期，且至少两条有效记录", async () => {
  const graph = await syntheticGraph([
    row("S0", "20250802", 100), row("S0", "20250809", 100), row("S0", "20250816", 900), row("S0", "20250822", 900), row("S0", "20250823", 200), row("S0", "20250830", 900),
    row("S1", "20250802", 100), row("S1", "20250823", 200),
  ], smallRange, { festivals: ["20250816"], rollout: "20250820" });
  assert.ok(graph.comparison);
  assert.deepEqual(graph.comparison.baselineDates, ["20250802", "20250809"]);
  assert.equal(graph.comparison.coverage.storeDays, 1);
  assert.equal(graph.comparison.coverage.totalStoreDays, 2);
  assert.equal(graph.comparison.metrics.sales!.baseline, 10000);
});

test("缺字段与缺记录不补零，零毛利和负毛利保留，非正基准不展示变化率", async () => {
  const graph = await syntheticGraph([
    row("S0", "20250802", 100, { gp: 0 }), row("S0", "20250809", 100, { gp: -20 }), row("S0", "20250823", 100, { gp: -5 }),
    row("S1", "20250802", 100), row("S1", "20250809", 100, { orders: null }), row("S1", "20250823", 100),
    row("S2", "20250802", 100), row("S2", "20250809", 100), row("S2", "20250823", 100, { gp: null }),
  ]);
  assert.ok(graph.comparison);
  assert.equal(graph.comparison.coverage.storeDays, 1);
  assert.equal(graph.comparison.metrics.gp!.current, -500);
  assert.equal(graph.comparison.metrics.gp!.baseline, -1000);
  assert.equal(graph.comparison.metrics.gp!.rate, null);
  const data = toDriverData({ ...fakeResults(), panel: [row("S0", "20250823", 100, { orders: null })] }, "v");
  assert.equal(data.panel[0].orders, 0, "旧全月仍保持缺值转零的合同");
});

test("金额先逐记录换分、均值逐单元取分，销售和毛利对称拆解逐分守恒", async () => {
  const graph = await syntheticGraph([
    row("S0", "20250802", 100.005, { gp: -5.005, orders: 2, items: 3 }), row("S0", "20250809", 100.015, { gp: 6.015, orders: 3, items: 4 }), row("S0", "20250823", 131.027, { gp: 18.027, orders: 4, items: 6 }),
    row("S1", "20250802", 20.015), row("S1", "20250809", 20.025), row("S1", "20250823", 29.035),
  ]);
  assert.ok(graph.comparison);
  const c = graph.comparison;
  assert.equal(c.sample!.baseline.salesCents, 12005, "逐记录半入到分，再将两个匹配单元的均值各自半入到分");
  assert.equal(c.sample!.current.salesCents, 16007);
  assert.equal(c.sample!.baseline.orders, 3.5);
  assert.equal(c.decomposition!.sales.ordersCents + c.decomposition!.sales.aovCents, c.metrics.sales!.delta);
  assert.equal(c.decomposition!.gp.revExCents + c.decomposition!.gp.gmCents, c.metrics.gp!.delta);
});

test("没有可比平日时只给本期事实和缺少原因，不回退宏观解释", async () => {
  const graph = await syntheticGraph([row("S0", "20250823", 100)]);
  assert.ok(graph.comparison);
  assert.equal(graph.comparison.status, "unavailable");
  assert.equal(graph.comparison.sample, null);
  assert.match(graph.summary.join(""), /至少.*2.*历史|不足.*2|没有.*对照/);
  assert.doesNotMatch(JSON.stringify(graph), /NaN|Infinity|门店规模|解释了.*%/);
  assert.equal(graph.edges.length, 0);
});

test("正数换分后为零的分母不进入可比样本，负毛利图保留真实负值", async () => {
  const graph = await syntheticGraph([row("S0", "20250802", 100), row("S0", "20250809", 100), row("S0", "20250823", 0.004, { rev_ex: 0.004 })]);
  assert.equal(graph.comparison!.status, "unavailable");
  const loss = await syntheticGraph([row("S0", "20250802", 100, { gp: -20 }), row("S0", "20250809", 100, { gp: -10 }), row("S0", "20250823", 100, { gp: -5 })]);
  const chart = loss.nodes.find((node) => node.id === "gp")!.card.chart!;
  assert.equal(chart.kind, "bars", "毛利为负时使用支持负值的坐标");
  if (chart.kind === "bars") assert.ok(chart.bars.every((bar) => bar.value < 0));
});

test("节日范围服务输出同店同星期的可比样本，不再解释门店规模", async () => {
  const names = new Map([...Object.entries(insightQueries("t")), ...Object.entries(insightQueries("t", true))].map(([key, sql]) => [sql, key]));
  const connection: HistoryConnection = {
    async query() { return [[], []]; },
    async execute(sql: string, params: string[] = []) {
      if (sql.includes("AS min_day")) return [[{ n: 10, min_day: "20250801", max_day: "20250831" }], []];
      const data = params.length ? fakeResultsIn({ from: params[0], to: params[1] }) : fakeResults();
      return [data[names.get(sql) as keyof typeof data] ?? [], []];
    }, destroy() {},
  };
  const service = createInsightGraphService({ table: "t", evidenceDir: "/tmp/insight-comparison-test", connect: async () => connection, logger: { log() {}, error() {} } });
  const graph = await service.graph(range);
  assert.ok(graph.comparison, "非全月必须有明确的可比平日元数据");
  assert.equal(graph.comparison.title, "七夕相对可比平日的变化");
  assert.ok(graph.summary.every((line) => line.length <= 140), "默认结论保持简短，精确金额留在节点依据");
  assert.ok(graph.kpis.every((kpi) => !kpi.comparison || kpi.comparison.current.length < 20), "KPI对照用可读的金额和件数单位");
  assert.equal(graph.comparison.coverage.storeDays, 120 * 7);
  assert.equal(graph.comparison.rollout, "20250822");
  assert.match(graph.summary.join(""), /无法单独拆出七夕净效果/);
  assert.ok(!graph.nodes.some((n) => ["qixi", "weekday", "threshold", "tradein", "shift"].includes(n.id)));
  for (const edge of graph.edges) {
    assert.ok(graph.nodes.some((n) => n.id === edge.from));
    assert.ok(graph.nodes.some((n) => n.id === edge.to));
    assert.equal(edge.score, undefined);
    assert.ok(["change", "observed"].includes(edge.strength));
  }
});

test("比较详情概览展示主题，不出现旧解释度排名；旧URL节点回到概览", async (t) => {
  const { fakeComparisonGraph } = await import("./helpers/insight-fixture.ts");
  const graph = fakeComparisonGraph();
  const { InsightSidePanel } = await loadReactComponent(t, "app/components/insight/insight-side-panel.tsx");
  const render = (selection: unknown) => renderToStaticMarkup(createElement(InsightSidePanel, { graph, selection, onSelect() {}, onAsk() {} }));
  assert.match(render(null), /七夕相对可比平日的变化/);
  assert.doesNotMatch(render(null), /解释度最高的关系/);
  assert.match(render({ kind: "node", id: "qixi" }), /七夕相对可比平日的变化/);
  assert.equal(highlightOf(graph, { kind: "node", id: "qixi" }), null, "已删除的节点不让整张图变暗");
});

test("比较图所有节点有有效且非负的位置，图例只区分拆解与观察，专用节点可通过URL恢复", async (t) => {
  const { fakeComparisonGraph } = await import("./helpers/insight-fixture.ts");
  const graph = fakeComparisonGraph();
  const { InsightGraphView } = await loadReactComponent(t, "app/components/insight/insight-graph-view.tsx");
  const markup = renderToStaticMarkup(createElement(InsightGraphView, { graph, selection: null, marked: [], onSelect() {} }));
  const positions = [...markup.matchAll(/data-node="([^"]+)"[^>]*style="([^"]+)"/g)];
  assert.equal(positions.length, graph.nodes.length);
  for (const [, id, style] of positions) {
    assert.doesNotMatch(style, /NaN|Infinity/);
    assert.ok(Number(/top:([^;]+)px/.exec(style)?.[1]) >= 26, id);
    assert.ok(Number(/left:([\d.]+)(?:px)?(?:;|$)/.exec(style)?.[1]) >= 0, id);
  }
  assert.match(markup, /变化拆解/); assert.match(markup, /同期观察/); assert.doesNotMatch(markup, /≥10 强|解释度/);
  for (const id of ["itemsPerOrder", "revEx"] as const) {
    assert.deepEqual(parseUrlSelection(selectionSearch({ kind: "node", id })), { kind: "node", id });
  }
});

test("分组只保留至少九家可比门店并比较各组自身基准，零毛利基准不产生变化率", () => {
  const all = fakeResults();
  const panel: RawPanel[] = [];
  for (let i = 0; i < 17; i++) {
    const sales = i % 2 ? 100 : 1000;
    panel.push(row(`S${i}`, "20250802", sales, { gp: 0 }), row(`S${i}`, "20250809", sales, { gp: 0 }), row(`S${i}`, "20250823", sales * 1.2, { gp: 0 }));
  }
  const data = toDriverData({ ...all, panel }, "v");
  const result = comparePeriods(data.panel, data.daily, smallRange, data.stores);
  assert.equal(result.metrics.sales!.rate, 20);
  assert.equal(result.metrics.gp!.rate, null);
  assert.ok(result.groups.length > 0);
  assert.ok(result.groups.every((group) => group.stores >= 9 && group.sales.rate === 20));
  assert.ok(result.groupNotes.some((note) => /不足 9/.test(note)));
  assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity/);
});

test("全范围聚合毛利缺失时，顶卡、节点与问图明确资料不全，不宣称实际零元", () => {
  const raw = fakeResults();
  const panel = raw.panel.map((p) => p.d >= range.from && p.d <= range.to ? { ...p, gp: null } : p);
  const ranged = toDriverData({ ...raw, panel: panel.filter((p) => p.d >= range.from && p.d <= range.to), ptype: raw.ptype.map((p) => ({ ...p, gp: null })) }, "v", range);
  const graph = buildComparisonGraph(ranged, toDriverData({ ...raw, panel }, "v").panel);
  assert.equal(graph.comparison!.coverage.invalidTargetDays, 840);
  assert.equal(graph.comparison!.targetTotals.gpCents, null);
  assert.equal(graph.comparison!.status, "unavailable");
  assert.equal(graph.kpis.find((kpi) => kpi.id === "gp")!.value, "暂无数据");
  const node = graph.nodes.find((item) => item.id === "gp")!;
  assert.match(node.card.say, /毛利[\s\S]*资料不全|毛利[\s\S]*暂无数据/);
  assert.doesNotMatch([node.subtitle, node.card.say, ...node.paragraphs, ...graph.summary].join(""), /毛利本期全范围实际 0|本期全范围实际 0元/);
  assert.match(askContext(graph, { kind: "node", id: "gp" }), /毛利 暂无数据/);
  assert.doesNotMatch(askContext(graph, { kind: "node", id: "gp" }), /毛利 0元|毛利本期全范围实际 0元/);
  assert.equal(ranged.ptype[0].gp, 0, "保留旧全月缺值转零的数值合同，范围另查原始有效性");
});

test("全范围任一货类字段缺失就不报伪完整总量，不改用门店日样本替代", () => {
  const raw = fakeResultsIn(range);
  const fullPanel = toDriverData(fakeResults(), "v").panel;
  for (const [field, id] of [["gp", "gp"], ["items", "qty"], ["sales", "sales"]] as const) {
    const graph = buildComparisonGraph(toDriverData({ ...raw, ptype: raw.ptype.map((p, index) => index === 0 ? { ...p, [field]: null } : p) }, "v", range), fullPanel);
    assert.equal(graph.comparison!.status, "available", "可比门店日样本仍可有值");
    assert.equal(graph.kpis.find((kpi) => kpi.id === id)!.value, "暂无数据", `${field} 的全范围总量不能用样本值或其余货类之和代替`);
    assert.match(graph.kpis.find((kpi) => kpi.id === id)!.detail, /资料不全/);
  }
});

test("全范围毛利合法零和负值照常保留，空聚合及非有限字段不补零", () => {
  const raw = fakeResultsIn(range); const fullPanel = toDriverData(fakeResults(), "v").panel;
  for (const gp of [0, -10]) {
    const graph = buildComparisonGraph(toDriverData({ ...raw, ptype: raw.ptype.map((p) => ({ ...p, gp })) }, "v", range), fullPanel);
    const kpi = graph.kpis.find((item) => item.id === "gp")!;
    assert.equal(kpi.value, String(gp * raw.ptype.length));
    assert.equal(kpi.unit, "元");
    assert.equal(kpi.detail, "本期全范围实际值");
  }
  for (const gp of [undefined, "", " ", Infinity, "不是数字"]) {
    const graph = buildComparisonGraph(toDriverData({ ...raw, ptype: raw.ptype.map((p) => ({ ...p, gp })) }, "v", range), fullPanel);
    assert.equal(graph.kpis.find((kpi) => kpi.id === "gp")!.value, "暂无数据");
  }
  const empty = buildComparisonGraph(toDriverData({ ...raw, ptype: [] }, "v", range), fullPanel);
  assert.ok(empty.kpis.every((kpi) => kpi.value === "暂无数据"));
});

function graphFromPartialDetails(field: "零售毛利" | "rsv" | "销售单号", value: number | string | null, changedDay = "20250823") {
  const db = new DatabaseSync(":memory:");
  try {
    db.function("regexp", (pattern, input) => new RegExp(String(pattern)).test(String(input)) ? 1 : 0);
    db.exec("CREATE TABLE t (`实体分店店号` TEXT, `交易日期wid` TEXT, `实际销售金额` REAL, `零售毛利` REAL, rsv REAL, `销售件数` REAL, `销售单号` TEXT, `材料种类描述` TEXT, `优惠小类` TEXT, `销售金重` REAL)");
    const insert = db.prepare("INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const day of ["20250809", "20250816", "20250823"]) for (const item of [1, 2]) {
      const changed = day === changedDay && item === 2;
      insert.run("S0", day, 100, changed && field === "零售毛利" ? value : 20, changed && field === "rsv" ? value : 113, 1, changed && field === "销售单号" ? value : `${day}-${item}`, "足金", "一般開單", 1);
    }
    // 直接执行产品聚合 SQL，覆盖 SUM / COUNT 忽略部分 NULL 的真实行为。
    const panel = db.prepare(insightQueries("t").panel).all();
    const ptype = db.prepare(insightQueries("t", true).ptype).all(range.from, range.to);
    const data = toDriverData({ ...fakeResults(), panel, ptype }, "partial-details", range);
    return buildComparisonGraph(data, data.panel);
  } finally { db.close(); }
}

for (const field of ["零售毛利", "rsv", "销售单号"] as const) test(`门店日内部分${field}缺失时退出比较，不能把部分聚合当完整数值`, () => {
  const graph = graphFromPartialDetails(field, null);
  assert.equal(graph.comparison!.coverage.invalidTargetDays, 1);
  assert.equal(graph.comparison!.status, "unavailable");
  assert.equal(graph.comparison!.metrics.gp, null);
  if (field === "零售毛利") {
    assert.equal(graph.kpis.find((kpi) => kpi.id === "gp")!.value, "暂无数据");
    assert.match(graph.kpis.find((kpi) => kpi.id === "gp")!.detail, /资料不全/);
  }
});

test("历史门店日内部分毛利缺失不能充当第二个有效基准日", () => {
  const graph = graphFromPartialDetails("零售毛利", null, "20250816");
  assert.equal(graph.comparison!.coverage.invalidTargetDays, 0);
  assert.equal(graph.comparison!.coverage.insufficientHistoryDays, 1);
  assert.equal(graph.comparison!.status, "unavailable");
});

test("明细毛利零或负数不属于缺失，聚合为零和负值仍保留", () => {
  for (const gp of [0, -20, -30]) {
    const graph = graphFromPartialDetails("零售毛利", gp);
    assert.equal(graph.comparison!.coverage.invalidTargetDays, 0);
    assert.equal(graph.comparison!.status, "available");
    assert.equal(graph.comparison!.metrics.gp!.current, (20 + gp) * 100);
    assert.equal(graph.kpis.find((kpi) => kpi.id === "gp")!.value, String(20 + gp));
  }
});
