import assert from "node:assert/strict";
import test from "node:test";
import { bindClaims } from "../app/lib/analytics/plan/bind.ts";
import type { NodeResult, NodeRole, NodeRow, PlanExecution } from "../app/lib/analytics/plan/execute.ts";
import type { PlanNode, PlanScope } from "../app/lib/analytics/plan/types.ts";
import type { AnalysisFact } from "../app/lib/analytics/analysis-v2-types.ts";

const scope: PlanScope = { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} };
const fact = (id: string, value: number | null, unit: string): AnalysisFact => ({ id, frameId: "f", metricId: "amount_per_day", label: id, value, unit, definition: "", objectIds: [], operationId: "op", limitations: [] });
const row = (factId: string, role: NodeRole, key: Record<string, string> = {}): NodeRow => ({ key, metric: "amount_per_day", factId, role });
const result = (node: PlanNode, rows: NodeRow[], extra: Partial<NodeResult> = {}): NodeResult => ({ node, status: "completed", operationIds: [], rows, ...extra });

// 构造：contrast c（总体 delta=50、change=100）、drill d（两组偏离 +30/−20）、robust r（of c，kept=false）。
function execution(): PlanExecution {
  const facts = [fact("fd", 50, "人民币/日"), fact("fc", 100, "%"), fact("fs", 30, "人民币/日"), fact("fe", -20, "人民币/日"), fact("fn", null, "人民币/日"), fact("fv", 200, "人民币/日")];
  const c: PlanNode = { id: "c", op: "contrast", target: scope, reference: scope, metrics: ["amount_per_day"] };
  const d: PlanNode = { id: "d", op: "drill", of: "c", path: ["district"] };
  const r: PlanNode = { id: "r", op: "robust", of: "c", checks: ["halves"] };
  const results = new Map<string, NodeResult>([
    ["c", result(c, [row("fd", "delta"), row("fc", "change")])],
    ["d", result(d, [row("fs", "deviation", { district: "南区/B区" }), row("fe", "deviation", { district: "东区/A区" }), row("fn", "deviation", { district: "空区" })])],
    ["m", result({ id: "m", op: "measure", scope, metrics: ["amount_per_day"] } as PlanNode, [row("fv", "value"), row("fd", "delta")])],
    ["r", result(r, [], { robust: [{ check: "halves", metric: "amount_per_day", kept: false, detail: "" }] })],
  ]);
  return { results, evidence: { frames: [], objects: [], methods: [], facts } };
}

test("数字由代码填入，方向一致才保留", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "七夕日均实收比平日高 {delta}（{change}）" }, claims: [{ node: "c", metric: "amount_per_day", assert: "down", text: "七夕日均实收下降" }], actions: [{ text: "按七夕节奏备货", claim: 0 }], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.headline!.rendered, "七夕日均实收比平日高 +50.00元/日（+100.00%）");
  assert.deepEqual(bound.headline!.factIds, ["fd", "fc"]);
  assert.equal(bound.claims.length, 0); assert.match(bound.dropped[0].reason, /方向/);
  assert.equal(bound.actions.length, 0);
});

test("措辞里写数字的结论被丢弃（含全角数字）", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "高了 50 元" }, claims: [{ node: "c", metric: "amount_per_day", assert: "up", text: "高了５０元" }, { node: "c", metric: "amount_per_day", assert: "up", text: "前三名里高了 {delta}" }], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.dropped.length, 2); assert.match(bound.dropped[0].reason, /数字/); assert.match(bound.dropped[1].reason, /数字/);
  assert.equal(bound.headline!.rendered, "前三名里高了 +50.00元/日");
});

test("select 定位分组；largest 校验排序", () => {
  const bound = bindClaims({ headline: { node: "d", select: { district: "南区/B区" }, metric: "amount_per_day", assert: "largest", text: "南区B区偏离最大，{value}" }, claims: [{ node: "d", select: { district: "东区/A区" }, metric: "amount_per_day", assert: "largest", text: "东区A区偏离最大" }, { node: "d", select: { district: "东区/A区" }, metric: "amount_per_day", assert: "smallest", text: "东区A区偏离最小，{value}" }], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.ok(bound.headline); assert.equal(bound.headline!.rendered, "南区B区偏离最大，+30.00元/日");
  assert.equal(bound.claims.length, 1); assert.equal(bound.claims[0].rendered, "东区A区偏离最小，-20.00元/日");
  assert.equal(bound.dropped.length, 1);
});

test("可信度来自指向同一节点的稳健性检查", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "上升 {delta}" }, claims: [{ node: "d", select: { district: "南区/B区" }, metric: "amount_per_day", assert: "higher", text: "南区B区更高" }], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.headline!.confidence, "flipped"); assert.equal(bound.claims[0].confidence, "unchecked");
});

test("headline 被丢弃时提升第一条有效结论", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "down", text: "下降" }, claims: [{ node: "c", metric: "amount_per_day", assert: "up", text: "上升 {delta}" }], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.headline!.text, "上升 {delta}"); assert.equal(bound.claims.length, 0);
});

test("没有任何有效结论时 headline 为空", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "down", text: "下降" }, claims: [], actions: [], cannotConclude: ["缺少门店口径"], questions: ["要看哪个区？"] }, execution());
  assert.equal(bound.headline, undefined); assert.deepEqual(bound.cannotConclude, ["缺少门店口径"]); assert.deepEqual(bound.questions, ["要看哪个区？"]);
});

test("节点不存在、没有匹配行、值为空都有明确原因", () => {
  const base = { metric: "amount_per_day", assert: "up" as const, text: "上升" };
  const bound = bindClaims({ headline: { ...base, node: "zzz" }, claims: [{ ...base, node: "d", select: { district: "无此区" } }, { ...base, node: "d", select: { district: "空区" }, assert: "unavailable", text: "暂缺" }, { ...base, node: "c", text: "上升 {target}" }, { ...base, node: "r" }], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.match(bound.dropped[0].reason, /节点.*不存在/);
  assert.match(bound.dropped[1].reason, /没有匹配的数据行/);
  assert.equal(bound.headline!.text, "暂缺");
  assert.match(bound.dropped[2].reason, /\{target\}/);
  assert.match(bound.dropped[3].reason, /未完成|没有数据行|没有匹配/);
});

test("flat 看变化幅度；行动随结论重新编号；数量有上限", () => {
  const e = execution();
  const flat = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "flat", text: "基本持平" }, claims: [], actions: [], cannotConclude: [], questions: [] }, e);
  assert.equal(flat.headline, undefined); assert.match(flat.dropped[0].reason, /方向/);
  const ok = { node: "c", metric: "amount_per_day", assert: "up" as const, text: "上升" };
  const bad = { ...ok, assert: "down" as const };
  // 发现绑变化率那一行，和主结论（差额）不是同一个数，不触发去重。
  const other = { ...ok, role: "change" as const };
  const many = bindClaims({ headline: ok, claims: [bad, other, other, other, other, other, other], actions: [{ text: "A", claim: 0 }, { text: "B", claim: 2 }, { text: "C", claim: 4 }, { text: "D", claim: 3 }], cannotConclude: ["一", "二", "三", "四", "五", "六", "1"].map((x) => `缺${x}`), questions: [] }, e);
  assert.equal(many.claims.length, 4); // 前 5 条里去掉被丢弃的一条，行动序号随之重排
  assert.deepEqual(many.actions, [{ text: "B", claim: 1 }, { text: "C", claim: 3 }, { text: "D", claim: 2 }]);
  assert.equal(many.cannotConclude.length, 5);
  assert.deepEqual(many.cannotConclude, ["缺一", "缺二", "缺三", "缺四", "缺五"]);
  const dropped = many.droppedText.filter((item) => item.kind === "cannotConclude");
  assert.deepEqual(dropped.map((item) => item.text), ["缺1"]);
  assert.match(dropped[0].reason, /^措辞中不能直接写算出来的数字，请用占位符：「1」不能直接写/);
  assert.deepEqual(many.droppedText.filter((item) => item.kind === "action").map((item) => item.text), ["A"]); // 指向被丢弃结论的行动
});

// 自定义执行结果：一个 contrast 节点 x，行与事实由调用方给出；robust 节点 rb 指向 x。
function custom(facts: AnalysisFact[], rows: NodeRow[], robust: Array<boolean | null> = []): PlanExecution {
  const x: PlanNode = { id: "x", op: "contrast", target: scope, reference: scope, metrics: ["amount_per_day"] };
  const results = new Map<string, NodeResult>([["x", result(x, rows)]]);
  if (robust.length) results.set("rb", result({ id: "rb", op: "robust", of: "x", checks: ["halves"] }, [], { robust: robust.map((kept, index) => ({ check: `k${index}`, metric: "amount_per_day", kept, detail: "" })) }));
  return { results, evidence: { frames: [], objects: [], methods: [], facts } };
}
const draftOf = (claim: Partial<Parameters<typeof bindClaims>[0]["headline"]> & { assert: Parameters<typeof bindClaims>[0]["headline"]["assert"] }, node = "x") => ({ headline: { node, metric: "amount_per_day", text: "结论", ...claim }, claims: [], actions: [], cannotConclude: [], questions: [] });

test("空 select 只选总体行，不会选到某个分组", () => {
  const e = execution();
  const overall = bindClaims(draftOf({ select: {}, assert: "up", text: "高了 {delta}" }, "c"), e);
  assert.equal(overall.headline!.rendered, "高了 +50.00元/日");
  const drill = bindClaims(draftOf({ select: {}, assert: "higher", text: "偏离 {value}" }, "d"), e);
  assert.equal(drill.headline, undefined); assert.match(drill.dropped[0].reason, /找不到对应分组/);
  const undef = bindClaims(draftOf({ assert: "higher", text: "偏离" }, "d"), e);
  assert.match(undef.dropped[0].reason, /找不到对应分组/);
});

test("select 必须键集合和取值完全一致；重复行视为分组不唯一", () => {
  const facts = [fact("a", 5, "人民币/日"), fact("b", 6, "人民币/日")];
  const rows = [row("a", "deviation", { district: "A", channel: "x" }), row("b", "deviation", { district: "A", channel: "y" })];
  const partial = bindClaims(draftOf({ select: { district: "A" }, role: "deviation", assert: "higher" }), custom(facts, rows));
  assert.match(partial.dropped[0].reason, /找不到对应分组/); // 部分键不算匹配
  const dup = bindClaims(draftOf({ select: { district: "A", channel: "x" }, role: "deviation", assert: "higher" }), custom(facts, [...rows, row("b", "deviation", { district: "A", channel: "x" })]));
  assert.equal(dup.headline, undefined); assert.match(dup.dropped[0].reason, /分组不唯一，请补全分组条件/);
  const exact = bindClaims(draftOf({ select: { channel: "y", district: "A" }, role: "deviation", assert: "higher", text: "{value}" }), custom(facts, rows));
  assert.equal(exact.headline!.rendered, "+6.00元/日");
});

test("flat：有变化行看变化行；变化行为空则丢弃", () => {
  const ok = bindClaims(draftOf({ assert: "flat", text: "基本持平 {change}" }), custom([fact("d", 3, "人民币/日"), fact("c", 0.5, "%")], [row("d", "delta"), row("c", "change")]));
  assert.equal(ok.headline!.rendered, "基本持平 +0.50%"); assert.deepEqual(ok.headline!.factIds, ["d", "c"]);
  const nullChange = bindClaims(draftOf({ assert: "flat" }), custom([fact("d", 0.2, "%"), fact("c", null, "%")], [row("d", "delta"), row("c", "change")]));
  assert.equal(nullChange.headline, undefined); assert.equal(nullChange.dropped[0].reason, "变化率无法计算");
});

test("flat：没有变化行时，只有偏离行或百分比单位才回退到自身值", () => {
  const dev = bindClaims(draftOf({ assert: "flat", role: "deviation", text: "偏离很小 {value}" }), custom([fact("v", 0.4, "人民币/日")], [row("v", "deviation")]));
  assert.equal(dev.headline!.rendered, "偏离很小 +0.40元/日");
  const pct = bindClaims(draftOf({ assert: "flat", role: "value", text: "占比不变 {value}" }), custom([fact("v", 0.4, "%")], [row("v", "value")]));
  assert.equal(pct.headline!.rendered, "占比不变 0.40%");
  const pp = bindClaims(draftOf({ assert: "flat", role: "value" }), custom([fact("v", 0.4, "个百分点")], [row("v", "value")]));
  assert.ok(pp.headline);
  const money = bindClaims(draftOf({ assert: "flat", role: "value" }), custom([fact("v", 0.4, "人民币/日")], [row("v", "value")]));
  assert.equal(money.headline, undefined); assert.equal(money.dropped[0].reason, "缺少变化率，无法判断持平");
  const big = bindClaims(draftOf({ assert: "flat", role: "value" }), custom([fact("v", 5, "%")], [row("v", "value")]));
  assert.match(big.dropped[0].reason, /方向/);
});

test("可信度：全部通过才是 kept，含空值是 unchecked，任一失败是 flipped", () => {
  const facts = [fact("d", 5, "人民币/日")]; const rows = [row("d", "delta")];
  const conf = (checks: Array<boolean | null>) => bindClaims(draftOf({ assert: "up" }), custom(facts, rows, checks)).headline!.confidence;
  assert.equal(conf([true, true]), "kept");
  assert.equal(conf([true, null]), "unchecked");
  assert.equal(conf([null]), "unchecked");
  assert.equal(conf([]), "unchecked");
  assert.equal(conf([true, false, null]), "flipped");
});

test("lower、{reference}、unavailable 与方向依据的兄弟事实", () => {
  const e = execution();
  const lowerBad = bindClaims(draftOf({ assert: "lower" }, "c"), e);
  assert.match(lowerBad.dropped[0].reason, /方向/);
  const lowerOk = bindClaims(draftOf({ select: { district: "东区/A区" }, assert: "lower", text: "东区A区更低 {value}" }, "d"), e);
  assert.equal(lowerOk.headline!.rendered, "东区A区更低 -20.00元/日");
  const noRef = bindClaims(draftOf({ assert: "up", text: "对照 {reference}" }, "c"), e);
  assert.match(noRef.dropped[0].reason, /\{reference\}/);
  const unavailable = bindClaims(draftOf({ assert: "unavailable", text: "暂缺" }, "c"), e);
  assert.equal(unavailable.headline, undefined); assert.match(unavailable.dropped[0].reason, /方向与事实不符.*可以计算/);
  // value 角色的方向依据来自同分组的 delta 兄弟行，其事实也要进 factIds
  const viaSibling = bindClaims(draftOf({ assert: "up", text: "日均 {value}" }, "m"), e);
  assert.equal(viaSibling.headline!.rendered, "日均 200.00元/日");
  assert.deepEqual(viaSibling.headline!.factIds, ["fv", "fd"]);
});

test("claims 只取前 5 条，第 6 条起不绑定也不能被行动引用", () => {
  const ok = { node: "c", metric: "amount_per_day", assert: "up" as const, text: "上升" };
  const other = { ...ok, role: "change" as const };
  const bound = bindClaims({ headline: ok, claims: [other, other, other, other, other, { ...other, text: "第六条" }], actions: [{ text: "指向第六条", claim: 5 }], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.claims.length, 5); assert.equal(bound.claims.some((item) => item.text === "第六条"), false);
  assert.equal(bound.dropped.length, 0); assert.equal(bound.actions.length, 0);
});

test("headline 被提升后，指向它的行动被丢弃，其余行动重新编号", () => {
  const up = { node: "c", metric: "amount_per_day", assert: "up" as const };
  const bound = bindClaims({ headline: { ...up, assert: "down", text: "下降" }, claims: [{ ...up, text: "第一" }, { ...up, text: "第二" }], actions: [{ text: "指向被提升的", claim: 0 }, { text: "指向第二", claim: 1 }], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.headline!.text, "第一");
  assert.deepEqual(bound.actions, [{ text: "指向第二", claim: 0 }]);
  assert.deepEqual(bound.droppedText.map((item) => [item.kind, item.text]), [["action", "指向被提升的"]]);
});

test("行动和追问里写数字同样被剔除并记录", () => {
  const up = { node: "c", metric: "amount_per_day", assert: "up" as const, text: "上升" };
  const bound = bindClaims({ headline: up, claims: [], actions: [{ text: "备货50件", claim: 0 }], cannotConclude: [], questions: ["看前3名吗？", "要看哪个区？"] }, execution());
  assert.equal(bound.actions.length, 0); assert.deepEqual(bound.questions, ["要看哪个区？"]);
  assert.deepEqual(bound.droppedText.map((item) => item.kind), ["action", "question"]);
});

test("措辞数字只允许来自原话与业务名称", async () => {
  const { digitGuard } = await import("../app/lib/analytics/plan/bind.ts");
  const forbidden = digitGuard(["帮我复盘一下2025年七夕（8月23日到29日这7天）的销售表现，和8月其他日子比"], ["H-克减30元", "H-克减50元", "东区/B区"]);
  for (const ok of ["七夕7天日均高出", "8月其他日子", "H-克减30元档和H-克减50元档", "克减30元档的件数更多", "50档比30档卖得多", "东区/B区表现最好", "2025年七夕", "前三名"]) assert.deepEqual(forbidden(ok), [], ok);
  for (const bad of ["高了50元", "增长了35%", "约三倍，即3.2倍", "日均订单为21650单", "高了30元", "9月", "70档"]) assert.ok(forbidden(bad).length > 0, bad);
  assert.deepEqual(forbidden("毛利率16.02%，比30档高"), ["16.02%"]);
});

test("执行结果里的分组取值和计划筛选值也算业务名称", () => {
  const bound = bindClaims({ headline: { node: "d", select: { district: "南区/B区" }, metric: "amount_per_day", assert: "largest", text: "南区/B区偏离最大，{value}" }, claims: [], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.ok(bound.headline, JSON.stringify(bound.dropped));
});

test("稳健性检查只影响同指标的结论；别的指标仍是未检查", () => {
  const exec = execution();
  exec.results.set("r", result({ id: "r", op: "robust", of: "c", checks: ["halves"] }, [], { robust: [{ check: "halves", metric: "orders_per_day", kept: false, detail: "" }] }));
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "日均实收高 {delta}" }, claims: [], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.equal(bound.headline!.confidence, "unchecked");
});

test("同一个数在一条结论里写两遍时退回，提示一条只说一个指标", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "日均高 {change}，件均也高 {change}" }, claims: [], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.headline, undefined);
  assert.match(bound.dropped[0].reason, /出现了两次/);
});

test("百分比指标的差额写成个百分点", async () => {
  const { formatRoleValue } = await import("../app/lib/analytics/plan/bind.ts");
  assert.equal(formatRoleValue(fact("x", 0.97, "%"), "delta"), "+0.97个百分点");
  assert.equal(formatRoleValue(fact("x", 35.1, "%"), "change"), "+35.10%");
  assert.equal(formatRoleValue(fact("x", 47642.428571, "单/日"), "value"), "47,642.43单/日");
});

test("建议里原样留下的占位符被剔除并说明原因", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "日均高 {delta}" }, claims: [{ node: "c", metric: "amount_per_day", role: "change", assert: "up", text: "变化 {change}" }], actions: [{ text: "钻石日均成交{change}，加大陈列", claim: 0 }, { text: "加大钻石陈列", claim: 0 }], cannotConclude: ["缺 {value} 的拆分"], questions: [] }, execution());
  assert.deepEqual(bound.actions.map((action) => action.text), ["加大钻石陈列"]);
  assert.deepEqual(bound.cannotConclude, []);
  assert.ok(bound.droppedText.every((item) => /占位符/.test(item.reason)));
});

test("选了变化行时 {value} 填目标值，可以和 {change} 同时写", () => {
  const facts = [fact("t", 300, "人民币/日"), fact("r", 150, "人民币/日"), fact("d", 150, "人民币/日"), fact("ch", 100, "%")];
  const c: PlanNode = { id: "c", op: "contrast", target: scope, reference: scope, metrics: ["amount_per_day"] };
  const exec: PlanExecution = { results: new Map([["c", result(c, [row("t", "target"), row("r", "reference"), row("d", "delta"), row("ch", "change")])]]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", role: "change", assert: "up", text: "日均从{reference}到{value}，变化{change}" }, claims: [], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.equal(bound.headline!.rendered, "日均从150.00元/日到300.00元/日，变化+100.00%");
});

test("业务名称的简称（克减50档）不算算出来的数字", () => {
  const exec = execution();
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "克减50档比克减30档日均高 {delta}" }, claims: [{ node: "c", metric: "amount_per_day", role: "change", assert: "up", text: "高出50元，{delta}" }], actions: [], cannotConclude: [], questions: [] }, exec, ["「H-克减30元」和「H-克减50元」"]);
  assert.ok(bound.headline);
  assert.equal(bound.claims.length, 0); assert.match(bound.dropped[0].reason, /数字/);
});

test("档位简称（50元档）和大小写不同的价位段名称不算算出来的数字", () => {
  const exec = execution();
  exec.results.get("d")!.rows.push(row("fs", "deviation", { priceBand: "30K-50K" }));
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "50元档比30元档日均高 {delta}，30k-50k 价位段贡献最大" }, claims: [{ node: "c", metric: "amount_per_day", role: "change", assert: "up", text: "50元档高出30元，{delta}" }], actions: [], cannotConclude: [], questions: [] }, exec, ["「H-克减30元」和「H-克减50元」"]);
  assert.ok(bound.headline, JSON.stringify(bound.dropped));
  assert.equal(bound.claims.length, 0); assert.match(bound.dropped[0].reason, /数字/);
});

test("下钻行可以写 {target}、{reference} 和 {deviation}；{value} 不与具名占位重复", () => {
  const facts = [fact("t", 300, "人民币/日"), fact("r", 150, "人民币/日"), fact("dv", 12.5, "个百分点")];
  const d: PlanNode = { id: "d", op: "drill", of: "c", path: ["district"] };
  const key = { district: "南区/N区" };
  const exec: PlanExecution = { results: new Map([["d", result(d, [row("dv", "deviation", key), row("t", "target", key), row("r", "reference", key)])]]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "d", select: key, metric: "amount_per_day", assert: "higher", text: "南区/N区七夕日均{target}，基线{reference}，相对整体偏离{deviation}" }, claims: [{ node: "d", select: key, metric: "amount_per_day", role: "target", assert: "higher", text: "南区/N区日均{value}，偏离{deviation}" }], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.equal(bound.headline!.rendered, "南区/N区七夕日均300.00元/日，基线150.00元/日，相对整体偏离+12.50个百分点");
  assert.equal(bound.claims[0].rendered, "南区/N区日均300.00元/日，偏离+12.50个百分点");
});

test("拆解贡献可以判断正负方向；汇总分组判高低时提示改用排名或对比节点", () => {
  const facts = [fact("p", -850949.28, "人民币"), fact("v", 1946665.8, "人民币/家")];
  const exec: PlanExecution = { results: new Map([
    ["dc", result({ id: "dc", op: "decompose", of: "c" }, [{ key: {}, metric: "amount.price_contribution", factId: "p", role: "contribution" }])],
    ["m", result({ id: "m", op: "measure", scope, metrics: ["amount_per_store"] } as PlanNode, [row("v", "value", { cityTier: "一线城市" })])],
  ]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "dc", metric: "amount.price_contribution", role: "contribution", assert: "down", text: "价格贡献为{value}" }, claims: [{ node: "m", select: { cityTier: "一线城市" }, metric: "amount_per_day", role: "value", assert: "higher", text: "一线城市每店{value}" }], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.equal(bound.headline!.rendered, "价格贡献为-850,949.28元");
  assert.match(bound.dropped[0].reason, /largest\/smallest|找不到/);
});

test("天数不同的两段不能比合计值，日均可以；同样长度的两段可以比合计", () => {
  const facts = [fact("t", 300, "人民币"), fact("r", 900, "人民币"), fact("d", -600, "人民币"), fact("ch", -66.67, "%")];
  const rows = [row("t", "target"), row("r", "reference"), row("d", "delta"), row("ch", "change")].map((item) => ({ ...item, metric: "amount" }));
  const make = (target: PlanScope, reference: PlanScope): PlanExecution => ({ results: new Map([["c", result({ id: "c", op: "contrast", target, reference, metrics: ["amount"] }, rows)]]), evidence: { frames: [], objects: [], methods: [], facts } });
  const week = { ...scope, period: { start: "2025-08-23", end: "2025-08-29" } };
  const draft = { headline: { node: "c", metric: "amount", assert: "down" as const, text: "实收少 {change}" }, claims: [], actions: [], cannotConclude: [], questions: [] };
  const unequal = bindClaims(draft, make(week, scope));
  assert.equal(unequal.headline, undefined); assert.match(unequal.dropped[0].reason, /日均/);
  const festival = bindClaims(draft, make({ ...scope, filters: { festivals: ["七夕节"] } }, { ...scope, filters: { festivals: ["非节庆"] } }));
  assert.equal(festival.headline, undefined);
  const lastYear = { ...scope, period: { start: "2024-08-01", end: "2024-08-31" } };
  assert.ok(bindClaims(draft, make(scope, lastYear)).headline);
});

test("主结论不能是只占样本不到 1% 的个案，改由有代表性的发现顶上", () => {
  const facts = [fact("big", 30, "个百分点"), fact("small", 1300, "个百分点")];
  const s: PlanNode = { id: "s", op: "scan", of: "c" };
  const exec: PlanExecution = { results: new Map([["s", result(s, [{ ...row("small", "deviation", { mallGroup: "某商场" }), sampleRows: 600 }, { ...row("big", "deviation", { mallGroup: "大集团" }), sampleRows: 99400 }])]]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "s", select: { mallGroup: "某商场" }, metric: "amount_per_day", assert: "largest", text: "某商场偏离{value}" }, claims: [{ node: "s", select: { mallGroup: "大集团" }, metric: "amount_per_day", assert: "higher", text: "大集团偏离{value}" }], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.equal(bound.headline!.rendered, "大集团偏离+30.00个百分点");
  assert.match(bound.dropped[0].reason, /个案/);
});

test("assert value：只陈述数值（如活动个数），不做方向判断；值为空时丢弃", () => {
  const facts = [fact("n", 442, "个"), fact("e", null, "个")];
  const m: PlanNode = { id: "m", op: "measure", scope, by: ["offer"], metrics: ["amount"] };
  const exec: PlanExecution = { results: new Map([["m", result(m, [{ key: {}, metric: "distinct_count", factId: "n", role: "value" }])], ["e", result({ ...m, id: "e" }, [{ key: {}, metric: "distinct_count", factId: "e", role: "value" }])]]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "m", metric: "distinct_count", assert: "value", text: "有成交的活动共{value}" }, claims: [{ node: "e", metric: "distinct_count", assert: "value", text: "共{value}" }], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.ok(bound.headline, JSON.stringify(bound.dropped)); assert.equal(bound.headline!.rendered, "有成交的活动共442个");
  assert.equal(bound.claims.length, 0); assert.match(bound.dropped[0].reason, /暂无可计算值/);
});

test("占位符后又写了单位时只保留一个", () => {
  const facts = [fact("n", 442, "个"), fact("r", 510750, "条")];
  const m: PlanNode = { id: "m", op: "measure", scope, by: ["offer"], metrics: ["rows"] };
  const exec: PlanExecution = { results: new Map([["m", result(m, [{ key: {}, metric: "distinct_count", factId: "n", role: "value" }, { key: { offer: "一般開單" }, metric: "rows", factId: "r", role: "value" }])]]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "m", metric: "distinct_count", assert: "value", text: "共{value}个活动" }, claims: [{ node: "m", select: { offer: "一般開單" }, metric: "rows", assert: "value", text: "一般開單（{value}条）" }], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.equal(bound.headline!.rendered, "共442个活动");
  assert.equal(bound.claims[0].rendered, "一般開單（510,750条）");
});

test("主结论记下第一个占位的数值作为重点数字；和主结论绑同一行的发现被去掉", () => {
  const facts = [fact("n", 442, "个"), fact("r", 510750, "条")];
  const m: PlanNode = { id: "m", op: "measure", scope, by: ["offer"], metrics: ["rows"] };
  const exec: PlanExecution = { results: new Map([["m", result(m, [{ key: {}, metric: "distinct_count", factId: "n", role: "value" }, { key: { offer: "一般開單" }, metric: "rows", factId: "r", role: "value" }])]]), evidence: { frames: [], objects: [], methods: [], facts } };
  const bound = bindClaims({ headline: { node: "m", metric: "distinct_count", assert: "value", text: "共有{value}活动" }, claims: [{ node: "m", metric: "distinct_count", assert: "value", text: "活动共{value}" }, { node: "m", select: { offer: "一般開單" }, metric: "rows", assert: "value", text: "一般開單{value}" }], actions: [], cannotConclude: [], questions: [] }, exec);
  assert.deepEqual(bound.headline!.keyFigure, { value: "442个", factId: "n" });
  assert.deepEqual(bound.claims.map((claim) => claim.rendered), ["一般開單510,750条"]);
  assert.match(bound.dropped[0].reason, /重复/);
});

test("措辞里有好几个数时不设重点数字", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "高 {delta}，即 {change}" }, claims: [], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.equal(bound.headline!.keyFigure, undefined);
  const one = bindClaims({ headline: { node: "c", metric: "amount_per_day", role: "change", assert: "up", text: "日均高 {change}" }, claims: [], actions: [], cannotConclude: [], questions: [] }, execution());
  assert.deepEqual(one.headline!.keyFigure, { value: "+100.00%", factId: "fc" });
});
