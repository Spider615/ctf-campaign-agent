import type { AnalysisAnswer, AnalysisCapabilities, AnalysisConclusion, AnalysisDraft, AnalysisEvidence, AnalysisReviewIssue, FactExpression } from "../app/lib/analytics/analysis-v2-types.ts";
import { formatAnalysisNodes } from "../app/lib/analytics/analysis-v2-format.ts";
import { resolveAnalysisVisualization, visualizationText } from "../app/lib/analytics/visualization.ts";
import { analysisEvidencePage, analysisFactSummary, summarizeAnalysisMethod } from "./analytics-evidence-context.ts";

const rules = [
  "日历天数由实际起止日期确定；无记录不证明完整覆盖或每天为零。另一期金额相等不能使原来的不等长比较自动可比。",
  "每个贡献保留符号，必须结合完整重构及抵消项解释；纯数值接近、主要驱动或基本相等均需核对真实差距，不设通用近似门槛。",
  "排除最大对象与替代窗口检验的是敏感性；结果变化不能单独证明该对象、活动或优惠造成变化。",
  "能力声明及真实unsupported检查是边界，不能扩大；货类相同不代表材料相同，不要求手算绕过缺字段或控制限制。",
  "审阅覆盖实际发布的每项正文、建议、限制、拟议条件和追问，不能只检查结论摘要。hypothesis标签或结尾限制不豁免正文的确定性断言。",
  "排除某种解释需要该解释的可测证据；成交件数或订单不等于客流、曝光、库存或复购。没有记录只说明所读范围，不证明现实因素不存在。",
  "事实与方法的对象范围要对应当前主张；总体敏感性不能自动迁移给单店。已有工具能完成的历史核查继续计算，未来持续性或未连接业务事实才追问。",
  "代理指标不能替换原目标；每项建议及试点验证要回到用户要求的指标。成本或已定义的毛利数据用于毛利，牌价或原价用于折扣，二者不能互为替代输入。",
  "先从原问题检查开头是否直接回答方向、推荐与条件；复述用户、列总额、解释数据缺口或只有通用试点方案，都不等于回答了决定。",
  "同口径总体份额只提示选样范围，不设通用样本占比门槛；小样本可以支持局部判断，不能靠尾部限制把不同货品、日期或门店的单次总额比较推广为稳定规律。",
  "建议须说明实际对象、依据、改变什么、预计解决的经营矛盾和可证伪的验收条件；可计算的保本或风险边界先计算。未计算样本波动或未结合活动周期时，不套用固定试点天数。",
  "含assumption的数字及其派生结果属于条件测算；检查基线、参数、保持不变的条件与单位，不能当作销量响应、历史业绩、用户已确认事实或今年现状。",
  "完整优惠情景核对逐行或订单成交部分的实际计算规则、按分舍入、实收下限、缺失和覆盖；总克重乘优惠不能替代已受封顶影响的完整损失。订单门槛只对当前筛选内成交部分生效，不证明完整订单资格或在营状态。",
  "净成交量变化相对不调整方案，须排除跨活动、货品、门店和日期的成交挪动；固定结构情景不估计需求响应。检查收入持平分母为追加让利后的余额，余额归零时不存在有限持平增量；收入不能替代利润或现金。情景图数值横轴不得冒充实际日期趋势。",
];

type DecisionCheck = { status: "supported" | "revise" | "not_applicable"; reason: string };
export type DecisionQuality = { directAnswer: DecisionCheck; evidenceFit: DecisionCheck; actionValue: DecisionCheck };
export function validateDecisionQuality(input: { mode?: "analysis" | "lookup"; draft: AnalysisDraft; verdict: string; issues: AnalysisReviewIssue[]; decisionQuality?: DecisionQuality }): string | undefined {
  if (input.mode !== "analysis") return;
  const quality = input.decisionQuality;
  if (!quality || quality.directAnswer.status === "not_applicable" || quality.evidenceFit.status === "not_applicable") return "分析复核必须单独提交decisionQuality，检查直接回答、证据适用性与行动价值，不能只核对数字";
  if ((input.draft.conclusions.some((item) => item.action) || input.draft.trialParameters.length) && quality.actionValue.status === "not_applicable") return "本稿包含行动建议或试点条件，不能跳过行动价值复核";
  const failed = Object.values(quality).some((check) => check.status === "revise");
  if (failed && (input.verdict !== "revise" || !input.issues.length)) return "决策交付复核未通过时必须revise退回，并指出具体需补的依据或判断";
}

export type AnalysisReviewClaim = {
  id: string;
  kind: "judgement" | "action" | "validation" | "limitation" | "body" | "heading" | "question" | "trial_condition" | "coverage" | "visualization";
  source: string;
  text: string;
  context: string;
  conclusionId?: string;
  needIds: string[];
  factIds: string[];
  objectIds: string[];
};
export type AnalysisReviewClaimCheck = { claimId: string; status: "supported" | "revise" | "not_applicable"; reason: string };
type SubmittedClaimCheck = Omit<AnalysisReviewClaimCheck, "status"> & { status: "supported" | "revise" };
const reviewClaimContextKey = (claim: AnalysisReviewClaim) => JSON.stringify({ source: claim.kind === "body" ? claim.source.replace(/:part:\d+$/u, "") : claim.source, kind: claim.kind, context: claim.context, conclusionId: claim.conclusionId, needIds: claim.needIds, factIds: claim.factIds, objectIds: claim.objectIds });

// 传输共享原段落与引用，内部来源仍逐句保存；上下文编号仅在当前支持包内定位。
export function packAnalysisReviewClaims(claims: readonly AnalysisReviewClaim[]) {
  const contexts: Array<{ id: string; context: string; factIds: string[]; objectIds: string[] }> = [];
  const keys = new Map<string, string>();
  const packed = claims.map((source) => {
    const { context, factIds, objectIds, ...claim } = source;
    const key = reviewClaimContextKey(source); let contextId = keys.get(key);
    if (!contextId) { contextId = `context-${contexts.length + 1}`; keys.set(key, contextId); contexts.push({ id: contextId, context, factIds: [...factIds], objectIds: [...objectIds] }); }
    return { ...claim, contextId };
  });
  return { claims: packed, contexts };
}

// 模型明确列出已逐句核对的来源；只共享适用于同一支持上下文的理由，不自动推断其他项已通过。
export function expandReviewClaimGroups(claims: readonly AnalysisReviewClaim[], checks: readonly SubmittedClaimCheck[], groups: readonly { claimIds: string[]; reason: string }[]): SubmittedClaimCheck[] {
  const actual = new Map(claims.map((claim) => [claim.id, claim])); const seen = new Set(checks.map((check) => check.claimId));
  const result = checks.map((check) => ({ ...check }));
  for (const group of groups) {
    if (!group.claimIds.length || !group.reason.trim()) throw new Error("正面分组须提供非空真实来源与适用理由");
    let key: string | undefined;
    for (const claimId of group.claimIds) {
      const claim = actual.get(claimId); if (!claim) throw new Error("正面分组必须来自本稿真实原句来源");
      if (seen.has(claimId)) throw new Error("审阅项引用不能重复，包括单项与分组记录");
      seen.add(claimId); const nextKey = reviewClaimContextKey(claim);
      if (key !== undefined && key !== nextKey) throw new Error("正面分组只能共享相同支持上下文的理由，其他来源须分别核对");
      key = nextKey; result.push({ claimId, status: "supported", reason: group.reason });
    }
  }
  return result;
}

// 来源单元由代码枚举，模型不能省略不利的正文或把总结核对当作全部内容已审阅。
export function analysisReviewClaims(draft: AnalysisDraft, evidence: AnalysisEvidence, taskNeedIds: readonly string[] = []): AnalysisReviewClaim[] {
  const claims: AnalysisReviewClaim[] = [];
  const allNeedIds = [...new Set([...taskNeedIds, ...draft.conclusions.flatMap((conclusion) => conclusion.needIds), ...(draft.coverage?.map((item) => item.needId) ?? [])])];
  const add = (kind: AnalysisReviewClaim["kind"], source: string, text: string, conclusion?: AnalysisConclusion, context = text, factIds = conclusion?.factIds ?? [], objectIds = conclusion?.objectIds ?? [], needIds = conclusion?.needIds ?? allNeedIds) => {
    if (!text.trim()) return;
    claims.push({ id: `claim-${claims.length + 1}`, kind, source, text, context, ...(conclusion ? { conclusionId: conclusion.id } : {}), needIds: [...needIds], factIds: [...factIds], objectIds: [...objectIds] });
  };
  for (const conclusion of draft.conclusions) {
    add("judgement", `conclusion:${conclusion.id}:judgement`, conclusion.judgement, conclusion);
    if (conclusion.action) add("action", `conclusion:${conclusion.id}:action`, conclusion.action, conclusion);
    if (conclusion.validation) add("validation", `conclusion:${conclusion.id}:validation`, conclusion.validation, conclusion);
    conclusion.limitations.forEach((text, index) => add("limitation", `conclusion:${conclusion.id}:limitation:${index}`, text, conclusion));
  }
  const display = { ...draft, evidence } as AnalysisAnswer;
  draft.blocks.forEach((block, index) => {
    const text = formatAnalysisNodes(block.nodes, display).join("");
    const conclusion = draft.conclusions.find((item) => item.id === block.conclusionId);
    const factIds = [...new Set(block.nodes.flatMap((node) => node.kind === "fact_ref" ? [node.factId] : []))];
    const objectIds = [...new Set(block.nodes.flatMap((node) => node.kind === "object_ref" ? [node.objectId] : []))];
    if (block.kind === "heading") add("heading", `block:${index}`, text, conclusion, text, factIds, objectIds);
    else (text.match(/[^。；！？]+[。；！？]?/gu) ?? []).forEach((part, partIndex) => add("body", `block:${index}:part:${partIndex}`, part, conclusion, text, factIds, objectIds));
  });
  for (const spec of draft.visualizations?.items ?? []) {
    const chart = resolveAnalysisVisualization(spec, evidence);
    const conclusion = draft.conclusions.find((item) => item.id === spec.conclusionId);
    const context = `${visualizationText(chart)}\n定义：${chart.definition}\n限制：${chart.limitations.join("；")}\n正文位置：${spec.afterBlockIndex}；图形：${spec.kind}；选择规则：${JSON.stringify(spec.selection)}`;
    add("visualization", `visualization:${spec.id}`, chart.title, conclusion, context, chart.factIds, chart.objectIds);
  }
  draft.questions.forEach((text, index) => add("question", `question:${index}`, text));
  draft.trialParameters.forEach((parameter) => parameter.conditions.forEach((text, index) => add("trial_condition", `trial:${parameter.id}:condition:${index}`, text, undefined, text, [], parameter.objectIds)));
  draft.coverage?.forEach((item) => add("coverage", `coverage:${item.needId}`, item.reason, undefined, item.reason, [], [], [item.needId]));
  return claims;
}

export function validateReviewClaimChecks(claims: readonly AnalysisReviewClaim[], checks: readonly AnalysisReviewClaimCheck[], inspected: ReadonlySet<string>): string | undefined {
  const actual = new Map(claims.map((claim) => [claim.id, claim]));
  if (checks.some((check) => !actual.has(check.claimId))) return "审阅项引用必须来自本稿真实正文来源";
  if (new Set(checks.map((check) => check.claimId)).size !== checks.length) return "审阅项引用不能重复";
  if (checks.length !== claims.length || claims.some((claim) => !checks.some((check) => check.claimId === claim.id))) return "必须完整核对每项实际正文、建议、条件和追问，不能遗漏或只提交摘要检查";
  if (checks.some((check) => !inspected.has(check.claimId))) return "每项审阅来源必须先实际读取支持包";
  if (checks.some((check) => check.status === "not_applicable")) return "每项公开正文、标题、建议、条件和追问都必须明确支持或退回，不能用不适用跳过；纯标题可说明不包含经营断言";
  return undefined;
}

export function inspectAnalysisGlobalSupport(draft: AnalysisDraft, evidence: AnalysisEvidence, capabilities: AnalysisCapabilities, taskNeedIds: readonly string[] = []) {
  const claims = analysisReviewClaims(draft, evidence, taskNeedIds).filter((claim) => !claim.conclusionId);
  const periods = draft.blocks.filter((block) => !block.conclusionId).flatMap((block) => block.nodes.flatMap((node) => node.kind === "period_ref" ? [node.frameId] : []));
  return { scope: "global" as const, claims, cited: analysisEvidencePage(evidence, { ids: [...new Set([...claims.flatMap((claim) => [...claim.factIds, ...claim.objectIds]), ...periods])] }), capabilities, rules };
}

// 这些结果只供复核已有证据的含义，不注册为可发布的经营事实，也不访问数据源。
export function compareReviewFacts(evidence: AnalysisEvidence, leftFactId: string, rightFactId: string) {
  const left = evidence.facts.find((fact) => fact.id === leftFactId); const right = evidence.facts.find((fact) => fact.id === rightFactId);
  if (!left || !right) throw new Error("复核只能计算已登记事实之间的关系");
  if (left.unit !== right.unit) throw new Error("单位不同，不能计算差距或份额");
  const leftFrame = evidence.frames.find((frame) => frame.id === left.frameId); const rightFrame = evidence.frames.find((frame) => frame.id === right.frameId);
  if (!leftFrame || !rightFrame || leftFrame.scope.population === "unknown" || rightFrame.scope.population === "unknown" || leftFrame.currency !== rightFrame.currency || leftFrame.snapshotId !== rightFrame.snapshotId) throw new Error("来源口径未确认，不能将关系当作当前可比事实");
  const present = left.value !== null && right.value !== null;
  return { left: analysisFactSummary(left), right: analysisFactSummary(right), leftFrame, rightFrame, difference: present ? left.value! - right.value! : null, ratio: present && right.value !== 0 ? left.value! / right.value! : null, purpose: "仅核对已登记数值之间的算术关系，不产生新的经营事实或可比性证明" };
}

function terms(expression: FactExpression, sign = 1): Array<{ factId: string; sign: number }> {
  if ("factId" in expression) return [{ factId: expression.factId, sign }];
  if (!("op" in expression) || !["add", "subtract"].includes(expression.op)) return [];
  return expression.args.flatMap((item, index) => terms(item, expression.op === "subtract" && index > 0 ? -sign : sign));
}

export function inspectAnalysisSupport(conclusion: AnalysisConclusion, draft: AnalysisDraft, evidence: AnalysisEvidence, capabilities: AnalysisCapabilities, taskNeedIds: readonly string[] = []) {
  const methodIds = new Set(conclusion.methodIds); const operationIds = new Set(evidence.facts.filter((fact) => conclusion.factIds.includes(fact.id)).map((fact) => fact.operationId));
  const methods = evidence.methods.filter((method) => methodIds.has(method.id) || operationIds.has(method.operationId));
  methods.forEach((method) => operationIds.add(method.operationId));
  const frameIds = new Set([...methods.flatMap((method) => method.frameIds), ...evidence.facts.filter((fact) => operationIds.has(fact.operationId)).map((fact) => fact.frameId)]);
  const balances = evidence.facts.filter((fact) => operationIds.has(fact.operationId) && fact.metricId.endsWith(".decomposed_change") && fact.derivation).map((total) => {
    const entries = terms(total.derivation!).map((entry) => {
      const fact = evidence.facts.find((item) => item.id === entry.factId)!;
      return { factId: fact.id, metricId: fact.metricId, label: fact.label, frameId: fact.frameId, value: fact.value, sign: entry.sign, signedValue: fact.value === null ? null : entry.sign * fact.value };
    });
    const sum = entries.some((entry) => entry.signedValue === null) ? null : entries.reduce((value, entry) => value + entry.signedValue!, 0);
    return { totalFactId: total.id, frameId: total.frameId, total: total.value, unit: total.unit, terms: entries, residual: total.value === null || sum === null ? null : total.value - sum };
  });
  const framesById = new Map(evidence.frames.map((frame) => [frame.id, frame]));
  const measuredAmounts = evidence.facts.filter((fact) => fact.metricId === "amount" && !fact.derivation && !fact.assumption && !fact.objectIds.length && fact.value !== null);
  const citedFrames = new Set(conclusion.factIds.flatMap((id) => { const fact = evidence.facts.find((item) => item.id === id); return fact ? [fact.frameId] : []; }));
  const selectionContext = measuredAmounts.filter((fact) => citedFrames.has(fact.frameId)).flatMap((selected) => {
    const selectedFrame = framesById.get(selected.frameId)!;
    const candidates = measuredAmounts.filter((wider) => {
      const widerFrame = framesById.get(wider.frameId)!;
      if (wider.id === selected.id || wider.unit !== selected.unit || wider.definition !== selected.definition || widerFrame.snapshotId !== selectedFrame.snapshotId || widerFrame.datasetVersion !== selectedFrame.datasetVersion || widerFrame.currency !== selectedFrame.currency || widerFrame.grain !== selectedFrame.grain || widerFrame.scope.population !== selectedFrame.scope.population || widerFrame.scope.period.start !== selectedFrame.scope.period.start || widerFrame.scope.period.end !== selectedFrame.scope.period.end) return false;
      const wide = widerFrame.scope.filters, narrow = selectedFrame.scope.filters;
      return Object.entries(wide).every(([key, values]) => narrow[key as keyof typeof narrow]?.every((value) => values!.includes(value))) && Object.entries(narrow).some(([key, values]) => !wide[key as keyof typeof wide] || wide[key as keyof typeof wide]!.length > values!.length);
    }).sort((a, b) => Object.keys(framesById.get(b.frameId)!.scope.filters).length - Object.keys(framesById.get(a.frameId)!.scope.filters).length);
    const wider = candidates[0];
    return wider ? [{ selectedFactId: selected.id, widerFactId: wider.id, selectedScope: selectedFrame.scope, widerScope: framesById.get(wider.frameId)!.scope, sharePct: wider.value === 0 ? null : 100 * selected.value! / wider.value!, purpose: "仅供复核选样与结论范围；份额不证明代表性或因果，不产生新的可发布事实" }] : [];
  });
  return {
    conclusionId: conclusion.id, judgement: conclusion.judgement, body: draft.blocks.filter((block) => block.conclusionId === conclusion.id),
    claims: analysisReviewClaims(draft, evidence, taskNeedIds).filter((claim) => !claim.conclusionId || claim.conclusionId === conclusion.id),
    cited: analysisEvidencePage(evidence, { ids: [...conclusion.factIds, ...conclusion.methodIds, ...conclusion.objectIds] }),
    frames: evidence.frames.filter((frame) => frameIds.has(frame.id)).map((frame) => ({ ...frame, calendarDays: Math.round((Date.parse(frame.scope.period.end) - Date.parse(frame.scope.period.start)) / 86400000) + 1 })),
    methods: methods.map(summarizeAnalysisMethod), balances, capabilities, selectionContext,
    scenarios: evidence.facts.filter((fact) => operationIds.has(fact.operationId) && (fact.scenario || fact.metricId === "scenario.break_even_pct")).map((fact) => ({ id: fact.id, metricId: fact.metricId, value: fact.value, unit: fact.unit, scenario: fact.scenario, limitations: fact.limitations })),
    unavailable: evidence.methods.filter((method) => method.status === "unsupported" || method.checks.some((check) => check.status === "unavailable")).map(summarizeAnalysisMethod), rules,
  };
}
