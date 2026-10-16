import type { AnalyticsDataset, SalesRow } from "../../app/lib/analytics/types.ts";
import type { AnalysisAnswer, AnalysisMethod } from "../../app/lib/analytics/analysis-v2-types.ts";

// 人工构造的已知经营关系，独立于模型评分；不包含客户真实经营数据。
export type AnalyticsBenchmark = { id: string; family: string; question: string; context?: string[]; dataset: AnalyticsDataset; expectation: string; check(answer: AnalysisAnswer): string[] };
const makeRow = (id: number, day: string, store: string, category: string, amount: number, quantity: number, offer: string, cost: number | null = amount * 0.7): SalesRow => ({ lineId: `line-${id}`, date: day, store, category, netSales: amount, quantity, orderId: `order-${id}`, region: "模拟大区", city: "模拟城市", sku: category === "金饰" ? "模拟金饰" : "模拟镶嵌", memberId: null, memberSegment: null, campaignId: offer, cost, weightGrams: category === "金饰" ? Math.abs(quantity) * 2 : null });
function fixture(kind: "drivers" | "local" | "large" | "concurrent" | "missing", renamed = false): AnalyticsDataset {
  const rows: SalesRow[] = [];
  for (const stage of [0, 1]) for (let day = 1; day <= 7; day++) {
    const date = `2026-${stage ? "09" : "08"}-${String(day).padStart(2, "0")}`;
    for (const [index, store] of (renamed ? ["海棠店", "松柏店", "玉兰店"] : ["甲店", "乙店", "丙店"]).entries()) {
      if (kind === "drivers") {
        rows.push(makeRow(rows.length, date, store, "金饰", stage ? 2200 : 1000, stage ? 20 : 10, "模拟常规"));
        rows.push(makeRow(rows.length, date, store, "镶嵌", stage ? 1000 : 2000, stage ? 5 : 10, "模拟常规"));
        if (stage && day === 7) rows.push(makeRow(rows.length, date, store, "镶嵌", -500, -1, "模拟常规"));
      } else if (kind === "concurrent") {
        if (stage) continue;
        // 活动甲总额大来自大店构成；同店成交部分均额乙更高，不能推因果。
        for (const offer of [renamed ? "模拟联动方案" : "模拟活动甲", renamed ? "模拟组合方案" : "模拟活动乙"]) {
          const first = offer.endsWith("甲") || offer.endsWith("联动方案");
          const n = first ? (index === 0 ? 6 : 1) : (index === 0 ? 1 : 3);
          for (let order = 0; order < n; order++) rows.push(makeRow(rows.length, date, store, "金饰", (index === 0 ? 900 : 100) * (first ? 1 : 1.2), 1, offer));
        }
      } else {
        const before = [1000, 100, 50][index];
        const after = kind === "large" ? [1600, 80, 40][index] : [1000, 80, 100][index];
        rows.push(makeRow(rows.length, date, store, "金饰", stage ? after : before, 10, "模拟常规", kind === "missing" ? null : undefined));
      }
    }
  }
  const dates = rows.map((row) => row.date).sort();
  return { schema: "analytics-dataset/v1", id: `synthetic-${kind}`, version: `synthetic-${kind}-${renamed ? "renamed" : "original"}`, name: "通用分析评估合成数据", provenance: "sample", currency: "CNY", createdAt: "2026-10-13", minDate: dates[0], maxDate: dates.at(-1)!, rows, rules: [], warnings: ["人工合成数据，仅用于评估"], sourceFiles: [], mappings: { sales: {}, campaigns: {} } };
}
const methods = (answer: AnalysisAnswer) => answer.evidence.methods.filter((method) => method.status === "completed").map((method) => method.method);
const contains = (method: AnalysisMethod) => (answer: AnalysisAnswer) => methods(answer).includes(method) ? [] : [`缺少实际完成的${method}方法`];
const completed = (answer: AnalysisAnswer) => answer.status === "incomplete" ? ["问题尚未回答"] : [];
const both = (...checks: Array<(answer: AnalysisAnswer) => string[]>) => (answer: AnalysisAnswer) => checks.flatMap((check) => check(answer));
const noCausality = (answer: AnalysisAnswer) => answer.conclusions.some((conclusion) => /证明.*活动有效|活动导致.*增长|保证.*增长/.test(conclusion.judgement)) ? ["把观察差异写成活动因果或增长保证"] : [];
const factValue = (answer: AnalysisAnswer, metric: string, value: number, store?: string) => answer.evidence.facts.some((fact) => {
  if (fact.metricId !== metric || fact.value === null || Math.abs(fact.value - value) >= 0.00001) return false;
  if (!store) return true;
  const scope = answer.evidence.frames.find((frame) => frame.id === fact.frameId)?.scope;
  return scope?.filters.stores?.length === 1 && scope.filters.stores[0] === store || fact.objectIds.some((id) => answer.evidence.objects.some((object) => object.id === id && object.dimension === "store" && object.value === store));
});
// 以下关系是由合成行手工推导的期望，不从被测分析方法生成。
const driversOracle = (answer: AnalysisAnswer) => {
  const expected = [["amount.sales_contribution", 4200], ["amount.returns_contribution", -1500], ["amount.quantity_contribution", 15750], ["amount.price_contribution", 4200], ["amount.mix_contribution", -15750]] as const;
  return expected.filter(([metric, value]) => !factValue(answer, metric, value)).map(([metric, value]) => `未计算已知经营关系：${metric}应为${value}`);
};
const localRelationships = [["丙店", 350], ["乙店", -140]] as const;
const localDirection = (answer: AnalysisAnswer) => localRelationships.filter(([store, value]) => !factValue(answer, "amount.delta", value, store)).map(([store]) => `未比较${store}的真实跨期变化`);
// 评估方法裁决：局部分歧可由实际全分组扫描或全门店对照回答，不强制重复调用某个工具名。
const fullLocalComparison = (answer: AnalysisAnswer) => {
  const stores = ["甲店", "乙店", "丙店"];
  const objects = new Map(answer.evidence.objects.map((object) => [object.id, object]));
  const coversPopulation = answer.evidence.methods.some((method) => {
    if (method.status !== "completed" || !["scan", "compare"].includes(method.method) || method.groupCount < stores.length) return false;
    const frames = answer.evidence.frames.filter((frame) => method.frameIds.includes(frame.id));
    if (!frames.length || frames.some((frame) => frame.scope.filters.stores?.length && !stores.every((store) => frame.scope.filters.stores!.includes(store)))) return false;
    const actual = new Set(answer.evidence.facts.filter((fact) => fact.operationId === method.operationId).flatMap((fact) => fact.objectIds).map((id) => objects.get(id)).filter((object) => object?.dimension === "store").map((object) => object!.value));
    return actual.has("乙店") && actual.has("丙店");
  });
  const allObjects = stores.every((store) => answer.evidence.objects.some((object) => object.dimension === "store" && object.value === store));
  const anchorPeriods = new Set(answer.evidence.facts.filter((fact) => fact.metricId === "amount" && fact.value === 7000 && (answer.evidence.frames.find((frame) => frame.id === fact.frameId)?.scope.filters.stores?.includes("甲店") || fact.objectIds.some((id) => objects.get(id)?.dimension === "store" && objects.get(id)?.value === "甲店"))).map((fact) => answer.evidence.frames.find((frame) => frame.id === fact.frameId)?.scope.period.start).filter(Boolean));
  const anchorStable = factValue(answer, "amount.delta", 0, "甲店") || anchorPeriods.size >= 2;
  return coversPopulation && allObjects && anchorStable && factValue(answer, "amount.delta", 210) ? [] : ["未证明实际覆盖全部门店并核对整体微增与主店持平方向，不能用少数子样本替代总体"];
};
const comparableDirection = (betterOffer: string, worseOffer: string) => (answer: AnalysisAnswer) => {
  const hasDirection = answer.evidence.facts.some((fact) => {
    if (!/^(amount_per_order|amount_per_gram)\.(standardized_)?delta$/.test(fact.metricId) || fact.value === null || !["within_stratum", "standardized"].includes(fact.comparisonRole ?? "")) return false;
    const frame = answer.evidence.frames.find((item) => item.id === fact.frameId);
    const target = frame?.scope.filters.offers?.length === 1 ? frame.scope.filters.offers[0] : undefined;
    return target === betterOffer && fact.value > 0 || target === worseOffer && fact.value < 0;
  });
  return hasDirection ? [] : ["未计算同店同货类内更优方案的真实方向，不能用活动总额或未控制均额替代"];
};
const largeOracle = (answer: AnalysisAnswer) => factValue(answer, "amount.delta", -210) && answer.evidence.methods.some((method) => method.status === "completed" && method.method === "robustness" && method.checks.some((check) => check.status === "performed" && check.name === "全局最大门店")) ? [] : ["未实际识别去最大店后其余门店下降的反转"];

export const analyticsBenchmarks: AnalyticsBenchmark[] = [
  { id: "lookup", family: "明确查数", dataset: fixture("local"), question: "按门店给出九月观察窗口的净销售额。", expectation: "只回答所问指标，甲店七千元、乙店五百六十元、丙店七百元；不附加策略任务。", check: both(completed, contains("aggregate"), (answer) => [7000, 560, 700].every((value) => answer.evidence.facts.some((fact) => fact.metricId === "amount" && fact.value === value)) ? [] : ["未返回全部门店实际净额"]) },
  { id: "drivers", family: "数量价格结构与退货", dataset: fixture("drivers"), question: "九月相对八月的净销售变化，主要是数量、价格还是品类结构造成？退货是否掩盖了增长，应该怎么调整？", expectation: "金饰数量翻倍且单价提高，镶嵌量下降，结构向较低单件价品类转移；销售量贡献为正、结构抵消，价格贡献形成销售正金额增量，退货再抵消部分增量；不能只报总额。", check: both(completed, contains("decompose"), driversOracle, noCausality) },
  { id: "overall_local", family: "整体与局部分组分歧", dataset: fixture("local"), question: "九月整体变化不大，是否有表现特别好的门店？也看下有没有变差的，为什么值得单独关注？", expectation: "整体微增、甲店持平、丙店向上、乙店向下；必须覆盖全部门店的实际扫描或对照，解释规模与结构限制。", check: both(completed, fullLocalComparison, localDirection) },
  { id: "strategy", family: "可比策略建议", dataset: fixture("concurrent"), question: "两个活动哪个值得继续做，是否可以针对表现更好的门店单独设计？请结合现有数据给建议。", expectation: "同窗按共同观察门店、同货类比较；活动甲总额更高，但活动乙每家店的订单成交部分均额更高，应优先验证乙；相关性不证明活动有效，不能把大店额高直接当单店机会。", check: both(completed, contains("compare"), comparableDirection("模拟活动乙", "模拟活动甲"), noCausality, (answer) => answer.conclusions.some((conclusion) => conclusion.action && conclusion.validation) ? [] : ["没有与证据关联的行动和验证"]) },
  { id: "large", family: "最大门店伪信号", dataset: fixture("large"), question: "九月销售增长看起来很好，能直接推广当前策略吗？请排除大店或大单带动的假象后判断。", expectation: "整体增长主要来自甲店；去最大店后其余门店下降，不能直接全面推广。", check: both(completed, contains("robustness"), largeOracle, noCausality) },
  { id: "one_window", family: "单窗同期对照", dataset: fixture("concurrent"), question: "只有当前观察窗口，也能判断两个活动哪个更值得小范围试验吗？不要因为没有前期就停止分析。", expectation: "使用同期共同店/同货类的对照，结合订单成交部分均额与分布；活动乙同店均额更高，有条件建议而非因果优劣。", check: both(completed, contains("compare"), comparableDirection("模拟活动乙", "模拟活动甲"), noCausality) },
  { id: "missing", family: "缺会员成本库存规则", dataset: fixture("missing"), question: "哪个方案能提高复购和毛利？库存能否支持推广，折扣应该设多少？先用现有数据给可行建议。", expectation: "明确无复购、成本、库存及规则证据，不能补零或猜折扣；仍建议验证与所需业务条件。", check: both(completed, (answer) => answer.status === "conditional" && answer.review.verdict === "accept_conditional" ? [] : ["已确认的能力缺口未用有条件判断表达"], (answer) => answer.trialParameters.some((parameter) => !["store_count", "duration_days"].includes(parameter.kind)) ? ["擅自设置折扣或收益参数"] : []) },
  { id: "paraphrase", family: "同义问法与名称变化", dataset: fixture("concurrent", true), question: "联动方案与组合方案，留哪种更合适？找出值得专门试试的店，并说明依据与下一步。", context: ["这次仅分析金饰；所有对照也保持该货类。"], expectation: "更换对象名称与问法仍识别组合方案同店均额更高；持续金饰约束保留，没有活动名专属逻辑。", check: both(completed, contains("compare"), comparableDirection("模拟组合方案", "模拟联动方案"), (answer) => answer.evidence.frames.filter((frame) => frame.mode !== "historical").every((frame) => frame.scope.filters.categories?.includes("金饰")) ? [] : ["后续比较未保留持续货类范围"]) },
];
