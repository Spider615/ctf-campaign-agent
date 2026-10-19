import assert from "node:assert/strict";
import test from "node:test";
import { resolveBody } from "../app/lib/analytics/plan/refs.ts";
import type { BodyBlock } from "../app/lib/analytics/plan/refs.ts";
import type { NodeResult, NodeRole, NodeRow, PlanExecution } from "../app/lib/analytics/plan/execute.ts";
import type { PlanNode, PlanScope } from "../app/lib/analytics/plan/types.ts";
import type { AnalysisFact } from "../app/lib/analytics/analysis-v2-types.ts";

const scope: PlanScope = { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} };
const fact = (id: string, value: number | null, unit: string): AnalysisFact => ({ id, frameId: "f", metricId: "m", label: id, value, unit, definition: "", objectIds: [], operationId: "op", limitations: [] });
const row = (factId: string, role: NodeRole, key: Record<string, string> = {}, metric = "amount_per_day"): NodeRow => ({ key, metric, factId, role });
const result = (node: PlanNode, rows: NodeRow[], extra: Partial<NodeResult> = {}): NodeResult => ({ node, status: "completed", operationIds: [], rows, ...extra });
const labels = { metric: (id: string) => ({ amount_per_day: "日均实收", orders: "订单数", amount: "实收金额" } as Record<string, string>)[id] ?? id, dimension: (id: string) => ({ district: "区域", product: "货品" } as Record<string, string>)[id] ?? id };

// m：measure 按区域分组（总体 + 三个区，订单数）；c：同长度 contrast；d：drill 偏离；w：不同天数的 contrast；f：失败节点。
function execution(): PlanExecution {
  const facts = [
    fact("mv", 1000, "人民币/日"), fact("mo", 30, "单"),
    fact("ma", 300, "人民币/日"), fact("mb", 500, "人民币/日"), fact("mc", 200, "人民币/日"),
    fact("moa", 10, "单"), fact("mob", 12, "单"), fact("moc", 8, "单"),
    fact("ct", 150, "人民币/日"), fact("cr", 100, "人民币/日"), fact("cd", 50, "人民币/日"), fact("cc", 50, "%"),
    fact("cta", 80, "人民币/日"), fact("cra", 60, "人民币/日"), fact("cda", 20, "人民币/日"),
    fact("ctb", 70, "人民币/日"), fact("crb", 40, "人民币/日"), fact("cdb", 30, "人民币/日"),
    fact("ds", 30, "人民币/日"), fact("de", -20, "人民币/日"), fact("dn", null, "人民币/日"), fact("dx", 5, "人民币/日"), fact("dy", 6, "人民币/日"),
    fact("wd", 999, "人民币"), fact("wpd", 12, "人民币/日"),
  ];
  const m: PlanNode = { id: "m", op: "measure", scope, metrics: ["amount_per_day", "orders"], by: ["district"] };
  const c: PlanNode = { id: "c", op: "contrast", target: scope, reference: scope, metrics: ["amount_per_day"], by: ["district"] };
  const d: PlanNode = { id: "d", op: "drill", of: "c", path: ["district", "product"] };
  const w: PlanNode = { id: "w", op: "contrast", target: scope, reference: { ...scope, period: { start: "2025-07-01", end: "2025-07-10" } }, metrics: ["amount", "amount_per_day"] };
  const results = new Map<string, NodeResult>([
    ["m", result(m, [row("mv", "value"), row("mo", "value", {}, "orders"),
      row("ma", "value", { district: "东区/A区" }), row("mb", "value", { district: "南区/B区" }), row("mc", "value", { district: "西区" }),
      row("moa", "value", { district: "东区/A区" }, "orders"), row("mob", "value", { district: "南区/B区" }, "orders"), row("moc", "value", { district: "西区" }, "orders")])],
    ["c", result(c, [row("ct", "target"), row("cr", "reference"), row("cd", "delta"), row("cc", "change"),
      row("cta", "target", { district: "东区/A区" }), row("cra", "reference", { district: "东区/A区" }), row("cda", "delta", { district: "东区/A区" }),
      row("ctb", "target", { district: "南区/B区" }), row("crb", "reference", { district: "南区/B区" }), row("cdb", "delta", { district: "南区/B区" })])],
    ["d", result(d, [row("ds", "deviation", { district: "南区/B区" }), row("de", "deviation", { district: "东区/A区" }), row("dn", "deviation", { district: "空区" }),
      row("dx", "deviation", { district: "西区", product: "金条" }), row("dy", "deviation", { district: "西区", product: "手镯" })])],
    ["w", result(w, [row("wd", "delta", {}, "amount"), row("wpd", "delta")])],
    ["f", result({ id: "f", op: "measure", scope, metrics: ["amount"] }, [], { status: "failed" })],
  ]);
  return { results, evidence: { frames: [], objects: [], methods: [], facts } };
}
const markdown = (blocks: BodyBlock[]) => blocks.filter((block): block is Extract<BodyBlock, { kind: "markdown" }> => block.kind === "markdown");
const refTexts = (block: Extract<BodyBlock, { kind: "markdown" }>) => block.refs.map((ref) => block.text.slice(ref.start, ref.end));

test("总体引用：默认角色为 value，单位去重，位置正确", () => {
  const out = resolveBody("八月日均实收 {{m.amount_per_day}}，订单 {{m.orders}}单。", execution(), [], labels);
  const [block] = markdown(out.blocks);
  assert.equal(block.text, "八月日均实收 1,000.00元/日，订单 30单。");
  assert.deepEqual(refTexts(block), ["1,000.00元/日", "30单"]);
  assert.deepEqual(block.refs.map((ref) => ref.factIds), [["mv"], ["mo"]]);
  assert.deepEqual(out.issues, []); assert.deepEqual(out.factIds, ["mv", "mo"]);
});

test("带分组引用和显式角色；对比默认 delta、下钻默认 deviation", () => {
  const out = resolveBody("南区B区 {{m.amount_per_day|district=南区/B区}}。对比上升 {{c.amount_per_day}}（{{c.amount_per_day.change}}），目标 {{c.amount_per_day.target}}。东区偏离 {{d.amount_per_day|district=东区/A区}}。", execution(), [], labels);
  const [block] = markdown(out.blocks);
  assert.deepEqual(refTexts(block), ["500.00元/日", "+50.00元/日", "+50.00%", "150.00元/日", "-20.00元/日"]);
  assert.deepEqual(out.issues, []);
});

test("未知节点、未完成节点、未知指标、分组不唯一、空值：删句并记原因", () => {
  const body = "开头一句。未知 {{zzz.amount}}。失败 {{f.amount}}。指标 {{m.nope}}。西区 {{d.amount_per_day|district=西区}}。空区 {{d.amount_per_day|district=空区}}。没有 {{m.amount_per_day|district=北区}}。结尾一句。";
  const out = resolveBody(body, execution(), [], labels);
  assert.equal(markdown(out.blocks)[0].text, "开头一句。结尾一句。");
  const reasons = out.issues.map((issue) => issue.reason);
  assert.match(reasons[0], /节点「zzz」不存在/);
  assert.match(reasons[1], /未完成（失败）/);
  assert.match(reasons[2], /没有指标 nope/);
  assert.match(reasons[3], /分组不唯一/);
  assert.match(reasons[4], /暂无可计算值/);
  assert.match(reasons[5], /找不到对应分组/);
  assert.equal(out.issues[0].text, "未知 {{zzz.amount}}。");
});

test("未写分组但节点只有分组行，提示补全", () => {
  const out = resolveBody("偏离 {{d.amount_per_day}}。", execution(), [], labels);
  assert.equal(out.blocks.length, 0); assert.match(out.issues[0].reason, /分组不唯一，请补全/);
});

test("写死数字的句子被删；业务名称和原话里的日期保留", () => {
  const out = resolveBody("高了 50 元。南区/B区 是 {{m.amount_per_day|district=南区/B区}}。2025年8月 七夕。", execution(), ["2025年8月七夕怎么样"], labels);
  assert.equal(markdown(out.blocks)[0].text, "南区/B区 是 500.00元/日。2025年8月 七夕。");
  assert.equal(out.issues.length, 1); assert.match(out.issues[0].reason, /「50 元」|「50元」|50/);
});

test("含乱码字符的句子退回并删掉，其他句子保留", () => {
  const out = resolveBody("不能当作\uFFFD\uFFFD动的因果证明。日均实收 {{m.amount_per_day}}。", execution(), [], labels);
  assert.equal(markdown(out.blocks)[0].text, "日均实收 1,000.00元/日。");
  assert.equal(out.issues.length, 1); assert.match(out.issues[0].reason, /乱码/);
});

test("删句后位置重算；跨行、列表前缀和空白收拢", () => {
  const body = "第一句写死 30%。第二句 {{c.amount_per_day}}。\n\n- 坏的 {{zzz.x}}。\n- 东区 {{m.amount_per_day|district=东区/A区}}。 多余 99 个。  末句。";
  const out = resolveBody(body, execution(), [], labels);
  const [block] = markdown(out.blocks);
  assert.equal(block.text, "第二句 +50.00元/日。\n\n- 东区 300.00元/日。 末句。");
  assert.deepEqual(refTexts(block), ["+50.00元/日", "300.00元/日"]);
  assert.equal(out.issues.length, 3);
});

test("两段天数不同时引用合计类指标删句，日均可用", () => {
  const out = resolveBody("合计差 {{w.amount}}。日均差 {{w.amount_per_day}}。", execution(), [], labels);
  assert.equal(markdown(out.blocks)[0].text, "日均差 +12.00元/日。");
  assert.match(out.issues[0].reason, /两段时间天数不同/);
});

test("table：按 by 分组、第一个指标降序、取 top", () => {
  const out = resolveBody("看表：\n::: table m amount_per_day,orders by district top 2\n说明。", execution(), [], labels);
  assert.deepEqual(out.blocks.map((block) => block.kind), ["markdown", "table", "markdown"]);
  const table = out.blocks[1] as Extract<BodyBlock, { kind: "table" }>;
  assert.equal(table.title, "各区域的日均实收、订单数");
  assert.deepEqual(table.columns, ["区域", "日均实收", "订单数"]);
  assert.deepEqual(table.rows.map((item) => item.cells), [["南区/B区", "500.00元/日", "12单"], ["东区/A区", "300.00元/日", "10单"]]);
  assert.deepEqual(table.rows[0].factIds, ["mb", "mob"]);
  assert.ok(out.factIds.includes("mb") && out.factIds.includes("moa"));
});

test("table：top 默认 6、上限 8；对比节点四列只取第一个指标", () => {
  const all = resolveBody("::: table m amount_per_day by district top 20", execution(), [], labels);
  assert.equal((all.blocks[0] as Extract<BodyBlock, { kind: "table" }>).rows.length, 3);
  const out = resolveBody("::: table c amount_per_day,orders by district", execution(), [], labels);
  const table = out.blocks[0] as Extract<BodyBlock, { kind: "table" }>;
  assert.deepEqual(table.columns, ["分组", "目标", "参照", "变化"]);
  assert.equal(table.title, "各区域的日均实收");
  assert.deepEqual(table.rows.map((item) => item.cells), [["南区/B区", "70.00元/日", "40.00元/日", "+30.00元/日"], ["东区/A区", "80.00元/日", "60.00元/日", "+20.00元/日"]]);
  const total = resolveBody("::: table c amount_per_day", execution(), [], labels).blocks[0] as Extract<BodyBlock, { kind: "table" }>;
  assert.equal(total.title, "日均实收对比");
  assert.deepEqual(total.rows[0].cells, ["总体", "150.00元/日", "100.00元/日", "+50.00元/日（+50.00%）"]);
});

test("table：节点或指标不存在时丢弃并记 issue", () => {
  const out = resolveBody("::: table zzz amount\n::: table m nope by district", execution(), [], labels);
  assert.equal(out.blocks.length, 0);
  assert.match(out.issues[0].reason, /不存在/); assert.match(out.issues[1].reason, /没有指标 nope/);
});

// 下钻行带上样本行数，过得了默认 200 行的门槛。
function sampled(): PlanExecution {
  const exec = execution(); const d = exec.results.get("d")!;
  exec.results.set("d", { ...d, rows: d.rows.map((item) => ({ ...item, sampleRows: 500 })) });
  return exec;
}

test("chart：校验节点和指标，参数原样保留", () => {
  const out = resolveBody("::: chart d amount_per_day by district top 4\n::: chart zzz amount\n::: chart m nope", sampled(), [], labels);
  assert.deepEqual(out.blocks, [{ kind: "chart", node: "d", metric: "amount_per_day", by: "district", top: 4 }]);
  assert.equal(out.issues.length, 2);
  const plain = resolveBody("::: chart m amount_per_day", execution(), [], labels);
  assert.deepEqual(plain.blocks, [{ kind: "chart", node: "m", metric: "amount_per_day", top: 6 }]);
});

test("chart：画不出来的图记 issue 并丢弃块，原因写清楚", () => {
  const reasonOf = (line: string, exec = execution()) => {
    const out = resolveBody(`说明一句。\n${line}`, exec, [], labels);
    assert.deepEqual(out.blocks.map((block) => block.kind), ["markdown"], line);
    assert.equal(out.issues.length, 1, line); assert.equal(out.issues[0].text, line);
    return out.issues[0].reason;
  };
  assert.match(reasonOf("::: chart c amount_per_day by district"), /节点「c」是对比节点，不能按维度分组出图/);
  assert.match(reasonOf("::: chart c amount_per_day"), /3 种以上对齐方式/);
  // 下钻行没有样本行数，过不了门槛。
  assert.match(reasonOf("::: chart d amount_per_day by district"), /分组样本不足，至少要 2 组（现在 0 组）/);
  assert.match(reasonOf("::: chart d amount_per_day by store", sampled()), /没有按store分组的日均实收偏离数据/);
  assert.match(reasonOf("::: chart m amount_per_day top 1"), /至少要 2 组/);
  assert.match(reasonOf("::: chart m amount_per_day by product"), /没有恰好按货品（product）分组的日均实收数据/);
  assert.match(reasonOf("::: chart w amount_per_day"), /对比节点/);
});

test("keyFigure：第一段恰好一个引用时取它，多个引用时没有", () => {
  const one = resolveBody("八月日均实收 {{m.amount_per_day}}。\n\n其中订单 {{m.orders}}。", execution(), [], labels);
  assert.deepEqual(one.keyFigure, { value: "1,000.00元/日", factId: "mv" });
  const many = resolveBody("日均 {{m.amount_per_day}}，订单 {{m.orders}}。", execution(), [], labels);
  assert.equal(many.keyFigure, undefined);
});

test("正文超过 1200 字符在最后一个完整句子处截断", () => {
  const sentence = "这是一句用来凑长度的说明文字没有数字。"; // 19 字
  const body = `${"日均 {{m.amount_per_day}}。"}${sentence.repeat(80)}`;
  const out = resolveBody(body, execution(), [], labels);
  const [block] = markdown(out.blocks);
  assert.ok(block.text.length <= 1200);
  assert.ok(block.text.endsWith("。"));
  assert.equal(block.refs.length, 1);
  assert.ok(out.issues.some((issue) => issue.reason === "正文过长，已截断"));
});

test("重复单位只去掉紧跟在引用值后面的那一个", async () => {
  const { dropRepeatedUnit } = await import("../app/lib/analytics/plan/refs.ts");
  assert.equal("442个" + dropRepeatedUnit("442个", "个活动"), "442个活动");
  assert.equal("510,750条" + dropRepeatedUnit("510,750条", "条明细"), "510,750条明细");
  // 有意的取舍：提示词会要求引用后不写单位，这里只是兜底；「单均」这种词被吃掉一个字可以接受。
  assert.equal("30单" + dropRepeatedUnit("30单", "单均不变"), "30单均不变");
  assert.equal("1,000.00元/日" + dropRepeatedUnit("1,000.00元/日", "元/日"), "1,000.00元/日");
  // 后面不是同一个单位：不动。
  assert.equal("1,000.00元/日" + dropRepeatedUnit("1,000.00元/日", "日均持平"), "1,000.00元/日日均持平");
});

test("引用后的正文不被全局去重改坏", () => {
  // 只处理紧跟引用值的重复单位；不紧邻引用的「个个区都涨」保持不变。
  const out = resolveBody("活动 {{m.orders}}单。个个区都涨，日均 {{m.amount_per_day}}元/日。八月 {{m.amount_per_day}}日均持平。", execution(), [], labels);
  const [block] = markdown(out.blocks);
  assert.equal(block.text, "活动 30单。个个区都涨，日均 1,000.00元/日。八月 1,000.00元/日日均持平。");
  assert.deepEqual(refTexts(block), ["30单", "1,000.00元/日", "1,000.00元/日"]);
});

test("分号不是句子边界：同一句里分号前后一起删", () => {
  const out = resolveBody("前半 {{m.orders}}；后半写死 50 元。保留。", execution(), [], labels);
  assert.equal(markdown(out.blocks)[0].text, "保留。");
  assert.equal(out.issues.length, 1);
});

test("标题下面的段落被删光时标题一起删", () => {
  const out = resolveBody("## 结论\n日均 {{m.amount_per_day}}。\n\n## 坏段\n写死 50 元。\n\n## 尾段\n收尾。", execution(), [], labels);
  assert.equal(markdown(out.blocks)[0].text, "## 结论\n日均 1,000.00元/日。\n\n## 尾段\n收尾。");
});

test("1200 字内没有句末时硬截，不切断引用数字", () => {
  const filler = "长".repeat(1190);
  const out = resolveBody(`${filler}日均 {{m.amount_per_day}}后面还有很多字没有标点`, execution(), [], labels);
  const [block] = markdown(out.blocks);
  assert.ok(block.text.length <= 1200);
  assert.equal(block.text, `${filler}日均`);
  assert.equal(block.refs.length, 0);
  assert.ok(out.issues.some((issue) => issue.reason === "正文过长，已截断"));
  const plain = resolveBody("字".repeat(1500), execution(), [], labels);
  assert.equal(markdown(plain.blocks)[0].text.length, 1200);
});

// 分组取值带分隔符：真实优惠名称里有逗号、全角逗号等，取值要加双引号。
const OFFERS = ["M-2月慶典（滿4,000 92折）", "M區8月R類，RU類活動申請", "A|B 套餐", "滿=減", "\"特\"惠{1}"];
function offerExecution(): PlanExecution {
  const m: PlanNode = { id: "m1", op: "measure", scope, metrics: ["rows"], by: ["offer"] };
  const facts = OFFERS.map((_, index) => fact(`o${index}`, (index + 1) * 100, "条"));
  return { results: new Map([["m1", result(m, OFFERS.map((offer, index) => row(`o${index}`, "value", { offer }, "rows")))]]), evidence: { frames: [], objects: [], methods: [], facts } };
}

test("带引号的分组取值：逗号、全角逗号、竖线、等号、引号都能对上", async () => {
  const { quoteRefValue } = await import("../app/lib/analytics/plan/refs.ts");
  const exec = offerExecution();
  const written = ['"M-2月慶典（滿4,000 92折）"', '"M區8月R類，RU類活動申請"', '"A|B 套餐"', '"滿=減"', '"\\"特\\"惠{1}"'];
  OFFERS.forEach((offer, index) => {
    assert.equal(quoteRefValue(offer), written[index], offer);
    const resolved = resolveBody(`这一档明细共 {{m1.rows|offer=${written[index]}}}。`, exec, [], labels);
    assert.deepEqual(resolved.issues, [], offer);
    assert.deepEqual(refTexts(markdown(resolved.blocks)[0]), [`${(index + 1) * 100}条`], offer);
  });
});

test("不带引号的旧写法照常可用；引号没闭合时记格式问题", async () => {
  const { quoteRefValue } = await import("../app/lib/analytics/plan/refs.ts");
  assert.equal(quoteRefValue("东区/A区"), "东区/A区");
  const ok = resolveBody("东区订单 {{m.orders|district=东区/A区}}。", execution(), [], labels);
  assert.deepEqual(ok.issues, []); assert.deepEqual(refTexts(markdown(ok.blocks)[0]), ["10单"]);
  const bad = resolveBody('这一档 {{m1.rows|offer="M-2月慶典}}。', offerExecution(), [], labels);
  assert.equal(bad.issues.length, 1); assert.match(bad.issues[0].reason, /引号没有闭合/);
  // 正常引用之外的文字里有引号，不算引号没闭合。
  const quoted = resolveBody('东区订单 {{m.orders|district=东区/A区}}，俗称"东大区"。', execution(), [], labels);
  assert.deepEqual(quoted.issues, []);
});

test("执行结果摘要里的引用照抄进正文能原样解析（真实名称 M-2月慶典（滿4,000 92折））", async () => {
  const { executionSummary } = await import("../agent/analysis-plan-run-turn.ts");
  const exec = offerExecution();
  const summary = executionSummary(exec);
  const line = summary.split("\n").find((item) => item.includes("M-2月慶典"))!;
  const ref = line.match(/^`(\{\{.*\}\})` = /)![1];
  assert.equal(ref, '{{m1.rows.value|offer="M-2月慶典（滿4,000 92折）"}}');
  const resolved = resolveBody(`慶典档明细 ${ref}。`, exec, [], labels);
  assert.deepEqual(resolved.issues, []);
  assert.deepEqual(refTexts(markdown(resolved.blocks)[0]), ["100条"]);
  // 含竖线的取值同样加引号。
  assert.ok(summary.includes("{{m1.rows.value|offer=\"A|B 套餐\"}}"));
});

test("正文可以写计划范围对应的年月（2025年8月）", () => {
  const resolved = resolveBody("2025年8月共有 {{m.orders}}。9月没有数据。", execution(), [], labels);
  // 8 月在计划范围内可以写；9 月不在范围内，仍按写死的数字删句。
  assert.deepEqual(resolved.issues.map((item) => item.text), ["9月没有数据。"]);
});

test("方向词和引用值的正负相反时记 issue（「高 -20」「下降 +50」）；中性说法照常通过", () => {
  const bad = resolveBody("北区比南区高 {{d.amount_per_day|district=东区/A区}}。", execution(), [], labels);
  assert.equal(bad.issues.length, 1); assert.match(bad.issues[0].reason, /正负|方向/);
  const bad2 = resolveBody("日均实收下降 {{c.amount_per_day.change}}。", execution(), [], labels);
  assert.equal(bad2.issues.length, 1);
  const neutral = resolveBody("北区变化 {{d.amount_per_day|district=东区/A区}}，日均实收比平日 {{c.amount_per_day.change}}。", execution(), [], labels);
  assert.deepEqual(neutral.issues, []);
  const agree = resolveBody("日均实收增长 {{c.amount_per_day.change}}。", execution(), [], labels);
  assert.deepEqual(agree.issues, []);
});

test("引用后隔一个空格又写单位也去重；表格把角色写成指标时提示可用指标", () => {
  const spaced = resolveBody("共有 {{m.orders}} 单。", execution(), [], labels);
  assert.equal(markdown(spaced.blocks)[0].text, "共有 30单。");
  const bad = resolveBody("各组如下：\n\n::: table m value by district", execution(), [], labels);
  assert.match(bad.issues[0].reason, /value 是角色不是指标/);
  assert.match(bad.issues[0].reason, /可用指标：/);
});

test("拆解节点默认取贡献：引用不写角色、表格列出各项贡献都能取到", () => {
  const exec = execution();
  exec.results.set("k", { node: { id: "k", op: "decompose", of: "c" }, status: "completed", operationIds: [], rows: [
    { key: {}, metric: "amount.quantity_contribution", factId: "kq", role: "contribution" },
    { key: {}, metric: "amount.price_contribution", factId: "kp", role: "contribution" },
  ] });
  exec.evidence.facts.push(fact("kq", -1439306267.89, "人民币"), fact("kp", -66285374.84, "人民币"));
  const ref = resolveBody("量的贡献 {{k.amount.quantity_contribution}}。", exec, [], labels);
  assert.deepEqual(ref.issues, []);
  const table = resolveBody("拆解如下：\n\n::: table k amount.quantity_contribution,amount.price_contribution", exec, [], labels);
  assert.deepEqual(table.issues, []);
  const block = table.blocks.find((item) => item.kind === "table");
  assert.ok(block && block.kind === "table" && block.rows.length === 1 && block.rows[0].cells.length === 3);
});

test("方向词判断：「降幅最高」「偏离最多」不误删；「下降了」「高于参照」后接相反符号要拦", () => {
  // c 的变化是 +50%，d 东区偏离是 -20。
  const keep = resolveBody("东区偏离最多 {{d.amount_per_day|district=东区/A区}}。降幅最高 {{d.amount_per_day|district=东区/A区}}。", execution(), [], labels);
  assert.deepEqual(keep.issues, []);
  const drop1 = resolveBody("日均实收下降了 {{c.amount_per_day.change}}。", execution(), [], labels);
  assert.equal(drop1.issues.length, 1);
  const drop2 = resolveBody("东区高于整体 {{d.amount_per_day|district=东区/A区}}。", execution(), [], labels);
  assert.equal(drop2.issues.length, 0, "「高于整体」后隔了别的字，不在紧挨范围内");
  const drop3 = resolveBody("东区高于 {{d.amount_per_day|district=东区/A区}}。", execution(), [], labels);
  assert.equal(drop3.issues.length, 1);
});

test("「1、」开头的中文列表项不会被当成写死的数字删掉", () => {
  const resolved = resolveBody("1、日均变化 {{c.amount_per_day.change}}\n2、订单 {{m.orders}}", execution(), [], labels);
  assert.deepEqual(resolved.issues, []);
});
