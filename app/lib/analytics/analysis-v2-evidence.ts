import { ANALYSIS_ANSWER_SCHEMA, ANALYSIS_DIMENSIONS, ANALYSIS_METHODS } from "./analysis-v2-types.ts";
import type { AnalysisAnswer, AnalysisAnswerBlock, AnalysisAnswerNode, AnalysisConclusion, AnalysisConstraints, AnalysisDraft, AnalysisEvidence, AnalysisFact, AnalysisFilters, AnalysisFrame, AnalysisMethodReport, AnalysisObject, AnalysisOperationResult, AnalysisReviewIssue, AnalysisSemanticReview, AnalysisTask, AnalysisTrialParameter, AnalysisUserCondition, DraftValidation, EvidenceRegistry, FactExpression } from "./analysis-v2-types.ts";
import { isToolTrace } from "../tool-trace.ts";
import type { Period } from "./types.ts";
import type { ToolTrace } from "../tool-trace.ts";
import { parseVisualizations, resolveAnalysisVisualization } from "./visualization.ts";
import { throwIfTurnCancelled } from "../cancellation.ts";
import { analysisFactParents } from "./analysis-v2-fact-links.ts";
import { scenarioCents, scenarioRevenue } from "./scenario-decimal.ts";
export { analysisAnswerText, formatAnalysisNode, formatAnalysisNodes } from "./analysis-v2-format.ts";

type IssueKind = AnalysisReviewIssue["kind"];
const FILTERS = ["stores", "regions", "districts", "categories", "materials", "offers", "memberFlags", "storeTypes", "skus", "memberSegments"] as const;
const CONTROL_FILTERS = { store: "stores", region: "regions", district: "districts", category: "categories", material: "materials", offer: "offers", memberFlag: "memberFlags", storeType: "storeTypes", sku: "skus", memberSegment: "memberSegments" } as const;
const POPULATIONS = ["sales", "net", "recovery", "returns", "zero_sales"] as const;
const GRAINS = ["line", "selected_order", "group", "unknown"] as const;
const ISSUE_KINDS = ["task_coverage", "missing_evidence", "invalid_comparison", "unsupported_explanation", "unclear_action", "expression"] as const;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function fail(message: string): never { throw new Error(message); }
function object(value: unknown, path: string): Record<string, unknown> { return record(value) ? value : fail(`${path}格式不正确`); }
function text(value: unknown, path: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) fail(`${path}必须是${empty ? "" : "非空"}文字`);
  return value;
}
function list<T>(value: unknown, parser: (item: unknown, path: string) => T, path: string): T[] {
  if (!Array.isArray(value)) fail(`${path}必须是数组`);
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}
function strings(value: unknown, path: string): string[] { return list(value, (item, at) => text(item, at), path); }
function ids(value: unknown, path: string): string[] {
  const values = strings(value, path);
  if (new Set(values).size !== values.length) fail(`${path}有重复编号`);
  return values;
}
function choice<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail(`${path}取值不正确`);
  return value as T[number];
}
function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}必须是有限数值`);
  return value;
}
function count(value: unknown, path: string): number {
  const number = finite(value, path);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${path}必须是非负整数`);
  return number;
}
function period(value: unknown, path: string): Period {
  const item = object(value, path);
  const start = text(item.start, `${path}开始日期`), end = text(item.end, `${path}结束日期`);
  for (const date of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${path}日期格式不正确`);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail(`${path}日期不存在`);
  }
  if (start > end) fail(`${path}周期起止顺序不正确`);
  return { start, end };
}
function filters(value: unknown, path: string): AnalysisFilters {
  const item = object(value, path); const result: AnalysisFilters = {};
  for (const key of Object.keys(item)) if (!FILTERS.includes(key as typeof FILTERS[number])) fail(`${path}包含未支持的筛选字段：${key}`);
  for (const key of FILTERS) if (item[key] !== undefined) {
    result[key] = ids(item[key], `${path}.${key}`);
    if (!result[key]?.length) fail(`${path}.${key}不能用空列表解除筛选`);
  }
  return result;
}
function constraints(value: unknown, path: string): AnalysisConstraints {
  const item = object(value, path);
  return { filters: filters(item.filters, `${path}筛选`), ...(item.period === undefined ? {} : { period: period(item.period, `${path}周期`) }) };
}
function parseTask(value: unknown): AnalysisTask {
  const item = object(value, "分析任务");
  const result: AnalysisTask = {
    ...(item.mode === undefined ? {} : { mode: choice(item.mode, ["lookup", "analysis"] as const, "任务类型") }),
    runId: text(item.runId, "运行编号"), question: text(item.question, "原始问题"), context: strings(item.context, "持续要求"),
    needs: list(item.needs, (raw, path) => { const need = object(raw, path); return { id: text(need.id, `${path}编号`), userQuote: text(need.userQuote, `${path}用户原话`), judgement: text(need.judgement, `${path}待答判断`), status: choice(need.status, ["open", "supported", "conditional", "needs_business_input"] as const, `${path}状态`), conclusionIds: ids(need.conclusionIds, `${path}结论编号`) }; }, "待答事项"),
    hardScope: constraints(item.hardScope, "用户硬范围"), assumptions: strings(item.assumptions, "分析假设"),
    ...(item.focus === undefined ? {} : { focus: filters(item.focus, "焦点对象") }), ...(item.goal === undefined ? {} : { goal: text(item.goal, "业务目标") }),
  };
  unique(result.needs, "待答事项");
  if (!result.needs.length) fail("分析任务至少需要一个待答事项");
  for (const need of result.needs) if (![result.question, ...result.context].some((quote) => quote.includes(need.userQuote))) fail(`待答事项 ${need.id} 的原话不是用户真实子串`);
  return result;
}
function expression(value: unknown, path: string, depth = 0): FactExpression {
  if (depth > 64) fail(`${path}派生表达式层级过深`);
  const item = object(value, path);
  if ("factId" in item && Object.keys(item).length === 1) return { factId: text(item.factId, `${path}父事实编号`) };
  if ("constant" in item && Object.keys(item).length === 1) return { constant: finite(item.constant, `${path}常量`) };
  if (Object.keys(item).some((key) => key !== "op" && key !== "args")) fail(`${path}包含不允许的派生字段`);
  const op = choice(item.op, ["add", "subtract", "multiply", "divide"] as const, `${path}派生运算`);
  const args = list(item.args, (raw, at) => expression(raw, at, depth + 1), `${path}运算项`);
  if ((op === "subtract" || op === "divide") ? args.length !== 2 : args.length < 1) fail(`${path}派生运算项数量不正确`);
  return { op, args };
}
function parseFrame(value: unknown, path: string): AnalysisFrame {
  const item = object(value, path), scope = object(item.scope, `${path}范围`);
  return {
    id: text(item.id, `${path}编号`), snapshotId: text(item.snapshotId, `${path}快照编号`), datasetVersion: text(item.datasetVersion, `${path}数据版本`), mode: choice(item.mode, ["database", "snapshot", "historical"] as const, `${path}模式`), provenance: choice(item.provenance, ["sample", "imported"] as const, `${path}来源`),
    scope: { period: period(scope.period, `${path}周期`), population: choice(scope.population, [...POPULATIONS, "unknown"] as const, `${path}人口口径`), filters: filters(scope.filters, `${path}筛选`) },
    currency: text(item.currency, `${path}币种`), grain: choice(item.grain, GRAINS, `${path}粒度`), controls: list(item.controls, (raw, at) => choice(raw, ANALYSIS_DIMENSIONS, at), `${path}控制维度`), limitations: strings(item.limitations, `${path}限制`), ...(item.recordId === undefined ? {} : { recordId: text(item.recordId, `${path}记录编号`) }),
  };
}
function parseFact(value: unknown, path: string): AnalysisFact {
  const item = object(value, path);
  const assumption = item.assumption === undefined ? undefined : { reason: text(object(item.assumption, `${path}情景假设`).reason, `${path}假设依据`) };
  const rawScenario = item.scenario === undefined ? undefined : object(item.scenario, `${path}情景依赖`);
  const scenario: AnalysisFact["scenario"] = rawScenario === undefined ? undefined : rawScenario.kind === "static_loss" ? { kind: "static_loss", baselineFactId: text(rawScenario.baselineFactId, `${path}情景基线`), parameterFactIds: ids(rawScenario.parameterFactIds, `${path}情景参数`) } : rawScenario.kind === "revenue" ? { kind: "revenue", baselineFactId: text(rawScenario.baselineFactId, `${path}情景基线`), lossFactId: text(rawScenario.lossFactId, `${path}情景损失`), rateFactId: text(rawScenario.rateFactId, `${path}净增参数`), netChange: text(rawScenario.netChange, `${path}净增比例`) } : fail(`${path}情景依赖类型不正确`);
  const comparisonControls = item.comparisonControls === undefined ? undefined : list(item.comparisonControls, (raw, at) => choice(raw, ANALYSIS_DIMENSIONS, at), `${path}事实比较控制`);
  if (comparisonControls && new Set(comparisonControls).size !== comparisonControls.length) fail(`${path}事实比较控制有重复维度`);
  const comparisonValues: AnalysisFact["comparisonValues"] = item.comparisonValues === undefined ? undefined : {};
  if (comparisonValues) for (const [key, value] of Object.entries(object(item.comparisonValues, `${path}实际控制值`))) {
    const dimension = choice(key, ANALYSIS_DIMENSIONS, `${path}实际控制维度`); comparisonValues[dimension] = text(value, `${path}实际控制值.${dimension}`);
  }
  return { id: text(item.id, `${path}编号`), frameId: text(item.frameId, `${path}数据范围编号`), metricId: text(item.metricId, `${path}指标编号`), label: text(item.label, `${path}名称`), value: item.value === null ? null : finite(item.value, `${path}事实值`), unit: text(item.unit, `${path}单位`, true), definition: text(item.definition, `${path}口径`), objectIds: ids(item.objectIds, `${path}对象编号`), operationId: text(item.operationId, `${path}操作编号`), limitations: strings(item.limitations, `${path}限制`), ...(assumption ? { assumption } : {}), ...(scenario ? { scenario } : {}), ...(item.derivation === undefined ? {} : { derivation: expression(item.derivation, `${path}派生关系`) }), ...(item.comparisonRole === undefined ? {} : { comparisonRole: choice(item.comparisonRole, ["descriptive", "within_stratum", "standardized"] as const, `${path}事实比较角色`) }), ...(comparisonControls === undefined ? {} : { comparisonControls }), ...(item.comparisonKey === undefined ? {} : { comparisonKey: text(item.comparisonKey, `${path}实际比较身份`) }), ...(comparisonValues === undefined ? {} : { comparisonValues }) };
}
function parseObject(value: unknown, path: string): AnalysisObject {
  const item = object(value, path);
  return { id: text(item.id, `${path}编号`), frameId: text(item.frameId, `${path}数据范围编号`), dimension: choice(item.dimension, ANALYSIS_DIMENSIONS, `${path}维度`), value: text(item.value, `${path}业务标识`, true), label: text(item.label, `${path}名称`) };
}
function parseMethod(value: unknown, path: string): AnalysisMethodReport {
  const item = object(value, path);
  return { id: text(item.id, `${path}编号`), operationId: text(item.operationId, `${path}操作编号`), status: choice(item.status, ["completed", "unsupported"] as const, `${path}整体执行状态`), method: choice(item.method, ANALYSIS_METHODS, `${path}方法`), frameIds: ids(item.frameIds, `${path}范围编号`), controls: list(item.controls, (raw, at) => choice(raw, ANALYSIS_DIMENSIONS, at), `${path}控制维度`), checks: list(item.checks, (raw, at) => { const check = object(raw, at); return { name: text(check.name, `${at}检查`), status: choice(check.status, ["performed", "unavailable"] as const, `${at}检查状态`), result: text(check.result, `${at}结果`) }; }, `${path}实际检查`), sampleRows: count(item.sampleRows, `${path}行数`), groupCount: count(item.groupCount, `${path}分组数`), limitations: strings(item.limitations, `${path}限制`) };
}
function unique(items: { id: string }[], name: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(`${name}有重复编号`);
}
function parseEvidence(value: unknown): AnalysisEvidence {
  const item = object(value, "证据");
  const result: AnalysisEvidence = { frames: list(item.frames, parseFrame, "证据范围"), facts: list(item.facts, parseFact, "事实"), objects: list(item.objects, parseObject, "业务对象"), methods: list(item.methods, parseMethod, "实际方法") };
  for (const [name, values] of Object.entries(result)) unique(values, `证据 ${name}`);
  return result;
}
function parseNode(value: unknown, path: string): AnalysisAnswerNode {
  const item = object(value, path);
  const kind = choice(item.kind, ["text", "fact_ref", "object_ref", "period_ref", "user_condition_ref", "trial_parameter_ref"] as const, `${path}节点类型`);
  const key = { text: "text", fact_ref: "factId", object_ref: "objectId", period_ref: "frameId", user_condition_ref: "conditionId", trial_parameter_ref: "parameterId" }[kind];
  if (Object.keys(item).some((field) => field !== "kind" && field !== key)) fail(`${path}不能覆盖引用的真实值或追加字段`);
  const content = text(item[key], `${path}.${key}`, kind === "text");
  return { kind, [key]: content } as AnalysisAnswerNode;
}
function parseConclusion(value: unknown, path: string): AnalysisConclusion {
  const item = object(value, path);
  return { id: text(item.id, `${path}编号`), needIds: ids(item.needIds, `${path}事项编号`), level: choice(item.level, ["observed", "comparison_supported", "hypothesis"] as const, `${path}证据级别`), judgement: text(item.judgement, `${path}判断`), factIds: ids(item.factIds, `${path}事实编号`), objectIds: ids(item.objectIds, `${path}对象编号`), methodIds: ids(item.methodIds, `${path}方法编号`), limitations: strings(item.limitations, `${path}限制`), ...(item.action === undefined ? {} : { action: text(item.action, `${path}建议`) }), ...(item.validation === undefined ? {} : { validation: text(item.validation, `${path}验证方式`) }) };
}
function parseDraft(value: unknown): AnalysisDraft {
  const item = object(value, "回答草稿");
  const userConditions = list<AnalysisUserCondition>(item.userConditions, (raw, at) => { const condition = object(raw, at); return { id: text(condition.id, `${at}编号`), quote: text(condition.quote, `${at}原话`) }; }, "用户条件");
  const trialParameters = list<AnalysisTrialParameter>(item.trialParameters, (raw, at) => {
    const parameter = object(raw, at);
    return { id: text(parameter.id, `${at}编号`), kind: choice(parameter.kind, ["store_count", "duration_days"] as const, `${at}计划类型`), value: count(parameter.value, `${at}拟议值`), objectIds: ids(parameter.objectIds, `${at}候选编号`), conditions: strings(parameter.conditions, `${at}条件`), status: choice(parameter.status, ["proposed"] as const, `${at}计划状态`) };
  }, "试点计划");
  const conclusions = list(item.conclusions, parseConclusion, "结论");
  const blocks = list<AnalysisAnswerBlock>(item.blocks, (raw, at) => { const block = object(raw, at); return { kind: choice(block.kind, ["paragraph", "bullet", "heading"] as const, `${at}段落类型`), nodes: list(block.nodes, parseNode, `${at}正文节点`), ...(block.conclusionId === undefined ? {} : { conclusionId: text(block.conclusionId, `${at}结论编号`) }) }; }, "回答正文");
  unique(conclusions, "结论"); unique(userConditions, "用户条件"); unique(trialParameters, "试点计划");
  const coverage = item.coverage === undefined ? undefined : list<NonNullable<AnalysisDraft["coverage"]>[number]>(item.coverage, (raw, at) => {
    const entry = object(raw, at);
    return { needId: text(entry.needId, `${at}事项编号`), status: choice(entry.status, ["open", "supported", "conditional", "needs_business_input"] as const, `${at}事项状态`), reason: text(entry.reason, `${at}状态依据`) };
  }, "逐事项覆盖");
  const visualizations = parseVisualizations(item.visualizations, blocks.length);
  return { status: choice(item.status, ["answered", "conditional", "incomplete"] as const, "回答状态"), conclusions, blocks, questions: strings(item.questions, "业务追问"), userConditions, trialParameters, ...(coverage === undefined ? {} : { coverage }), ...(visualizations ? { visualizations } : {}) };
}
function same(value: unknown, other: unknown): boolean {
  function canonical(raw: unknown): unknown {
    if (Array.isArray(raw)) return raw.map(canonical);
    if (record(raw)) return Object.fromEntries(Object.keys(raw).sort().map((key) => [key, canonical(raw[key])]));
    return raw;
  }
  return JSON.stringify(canonical(value)) === JSON.stringify(canonical(other));
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function parents(expression: FactExpression): string[] {
  if ("factId" in expression) return [expression.factId];
  if ("constant" in expression) return [];
  return expression.args.flatMap(parents);
}
function currency(value: string): string {
  return /^(CNY|人民币|RMB)$/.test(value) ? "CNY" : value === "美元" ? "USD" : value === "港元" ? "HKD" : value === "欧元" ? "EUR" : value === "日元" ? "JPY" : value === "英镑" ? "GBP" : value;
}
function knownCurrency(value: string): boolean { return /^(?:[A-Z]{3}|人民币|美元|港元|欧元|日元|英镑)$/.test(value) && value !== "XXX"; }
function unitSignature(unit: string): Record<string, number> {
  if (!unit || ["%", "％", "百分比", "个百分点", "百分点"].includes(unit)) return {};
  const parts = unit.replace("每", "/").split("/");
  const result = Object.create(null) as Record<string, number>;
  parts.forEach((part, index) => { const atom = part === "元" ? "CNY" : part === "天" ? "日" : currency(part); result[atom] = (result[atom] ?? 0) + (index ? -1 : 1); });
  return result;
}

const EVIDENCE_BATCH_SIZE = 8192;
function* checkEvidenceSteps(evidence: AnalysisEvidence): Generator<void, AnalysisReviewIssue[]> {
  const issues: AnalysisReviewIssue[] = [];
  const add = (kind: IssueKind, requirement: string) => issues.push({ kind, requirement, needIds: [], conclusionIds: [] });
  function* index<T extends { id: string }>(items: T[]): Generator<void, Map<string, T>> {
    const result = new Map<string, T>(); let handled = 0;
    for (const item of items) { result.set(item.id, item); if (++handled % EVIDENCE_BATCH_SIZE === 0) yield; }
    return result;
  }
  const frames = yield* index(evidence.frames);
  const facts = yield* index(evidence.facts);
  const objects = yield* index(evidence.objects);
  const methods = new Map<string, AnalysisMethodReport[]>();
  for (const method of evidence.methods) {
    methods.set(method.operationId, [...(methods.get(method.operationId) ?? []), method]);
    for (const id of method.frameIds) if (!frames.has(id)) add("missing_evidence", `实际方法 ${method.id} 引用了不存在的数据范围 ${id}`);
    if (!method.frameIds.length && (method.status === "completed" || method.checks.some((check) => check.status === "performed"))) add("missing_evidence", `实际方法 ${method.id} 没有关联真实数据范围`);
    if (method.status === "completed" && !method.checks.some((check) => check.status === "performed")) add("missing_evidence", `实际方法 ${method.id} 标为完成却没有实际执行的检查`);
  }
  const active = evidence.frames.filter((frame) => frame.mode !== "historical");
  if (new Set(active.map((frame) => `${frame.snapshotId}\u0000${frame.datasetVersion}`)).size > 1) add("missing_evidence", "本轮混入不同实时快照或数据版本，必须重算当前判断依赖的事实");
  if (new Set(active.map((frame) => `${frame.mode}\u0000${frame.provenance}\u0000${currency(frame.currency)}`)).size > 1) add("missing_evidence", "同一实时快照的数据模式、来源或币种不一致，不能改写来源元数据");
  let handled = 0;
  for (const item of evidence.objects) {
    if (!frames.has(item.frameId)) add("missing_evidence", `对象 ${item.id} 引用了不存在的数据范围 ${item.frameId}`);
    if (++handled % EVIDENCE_BATCH_SIZE === 0) yield;
  }
  for (const fact of evidence.facts) {
    if (++handled % EVIDENCE_BATCH_SIZE === 0) yield;
    if (!frames.has(fact.frameId)) add("missing_evidence", `事实 ${fact.id} 引用了不存在的数据范围 ${fact.frameId}`);
    const reports = methods.get(fact.operationId) ?? [];
    if (!reports.some((method) => method.frameIds.includes(fact.frameId))) add("missing_evidence", `事实 ${fact.id} 没有匹配的实际方法和操作记录 ${fact.operationId}`);
    for (const id of fact.objectIds) {
      const ref = objects.get(id);
      if (!ref) add("missing_evidence", `事实 ${fact.id} 引用了未读取的对象 ${id}`);
      else if (ref.frameId !== fact.frameId) add("missing_evidence", `事实 ${fact.id} 的对象 ${id} 不属于同一数据范围`);
    }
    if (fact.comparisonRole === "within_stratum" && fact.comparisonValues) for (const dimension of fact.comparisonControls ?? []) {
      const value = fact.comparisonValues[dimension];
      if (!value) add("invalid_comparison", `事实 ${fact.id} 缺少控制维度 ${dimension} 的实际值`);
      for (const id of fact.objectIds) {
        const object = objects.get(id); if (object?.dimension === dimension && object.value !== value) add("invalid_comparison", `事实 ${fact.id} 的实际控制值与对象 ${id} 不一致`);
      }
      const key = CONTROL_FILTERS[dimension as keyof typeof CONTROL_FILTERS];
      const selected = key ? frames.get(fact.frameId)?.scope.filters[key] : undefined;
      if (selected?.length === 1 && selected[0] !== value) add("invalid_comparison", `事实 ${fact.id} 的实际控制值与数据范围筛选不一致`);
    }
  }
  const states = new Map<string, "visiting" | "done">();
  function inspect(id: string): void {
    if (states.get(id) === "done") return;
    if (states.get(id) === "visiting") { add("missing_evidence", `派生事实 ${id} 存在循环引用`); return; }
    const fact = facts.get(id);
    if (!fact) return;
    states.set(id, "visiting");
    if (fact.scenario) {
      const scenario = fact.scenario; const base = facts.get(scenario.baselineFactId);
      const references = analysisFactParents(fact);
      for (const parentId of references) {
        const parent = facts.get(parentId);
        if (!parent || parent.frameId !== fact.frameId || !same(parent.objectIds, fact.objectIds)) add("missing_evidence", `情景事实 ${id} 的完整依赖缺失或不属于同一范围对象`);
        else inspect(parentId);
      }
      if (!fact.assumption || !base || base.metricId !== "amount" || base.assumption || base.derivation || base.value === null || base.value <= 0 || frames.get(fact.frameId)?.scope.population !== "sales" || !same(unitSignature(base.unit), unitSignature(fact.unit))) add("missing_evidence", `情景事实 ${id} 未绑定真实销售基线、同单位及假设身份`);
      if (!(methods.get(fact.operationId) ?? []).some((method) => method.status === "completed" && method.checks.some((check) => check.name === "完整情景计算" && check.status === "performed"))) add("missing_evidence", `情景事实 ${id} 缺少实际完成的完整规则计算`);
      if (scenario.kind === "static_loss") {
        if (fact.metricId !== "scenario.static_loss" || fact.value === null || fact.value < 0 || fact.value > (base?.value ?? 0) || !scenario.parameterFactIds.length || scenario.parameterFactIds.some((key) => !facts.get(key)?.assumption || facts.get(key)?.operationId !== fact.operationId)) add("missing_evidence", `情景损失 ${id} 缺少有效参数或超出基线`);
      } else {
        const loss = facts.get(scenario.lossFactId), rate = facts.get(scenario.rateFactId);
        try {
          if (!/^-?\d{1,7}(?:\.\d{1,12})?$/.test(scenario.netChange) || !loss || loss.value === null || loss.operationId !== fact.operationId || loss.scenario?.kind !== "static_loss" || loss.scenario.baselineFactId !== scenario.baselineFactId || !rate?.assumption || rate.operationId !== fact.operationId || rate.unit !== "%" || rate.metricId !== "assumption.net_volume_change" || rate.value !== Number(scenario.netChange) * 100 || base?.value === null || base?.value === undefined) throw new Error("依赖不一致");
          const expected = scenarioRevenue(Number(scenarioCents(base.value)), Number(scenarioCents(loss.value)), scenario.netChange);
          const value = fact.metricId === "scenario.revenue_after" ? expected.afterCents : fact.metricId === "scenario.revenue_change" ? expected.changeCents : undefined;
          if (value === undefined || fact.value !== value / 100) throw new Error("金额不一致");
        } catch { add("missing_evidence", `情景事实 ${id} 的比例、基线、损失或逐分计算结果不一致`); }
      }
    }
    if (fact.derivation) {
      const references = parents(fact.derivation);
      if (!references.length) add("missing_evidence", `派生事实 ${id} 没有父事实，常量不能伪装成测量`);
      for (const parentId of references) {
        const parent = facts.get(parentId);
        if (!parent) { add("missing_evidence", `派生事实 ${id} 缺少父事实 ${parentId}`); continue; }
        inspect(parentId);
        const childFrame = frames.get(fact.frameId), parentFrame = frames.get(parent.frameId);
        if (childFrame && parentFrame) {
          if (!knownCurrency(childFrame.currency) || !knownCurrency(parentFrame.currency) || currency(childFrame.currency) !== currency(parentFrame.currency)) add("invalid_comparison", `派生事实 ${id} 与父事实 ${parentId} 币种不同或尚未核对`);
          if (childFrame.grain !== parentFrame.grain || childFrame.grain === "unknown") add("invalid_comparison", `派生事实 ${id} 与父事实 ${parentId} 粒度不可比`);
          const reports = methods.get(fact.operationId) ?? [];
          if (childFrame.scope.population === "unknown" || parentFrame.scope.population === "unknown") add("invalid_comparison", `派生事实 ${id} 的人口口径尚未核对，不能参与派生混合`);
          if (childFrame.scope.population !== parentFrame.scope.population && !reports.some((method) => method.method === "decompose" && method.checks.some((check) => check.status === "performed"))) add("invalid_comparison", `派生事实 ${id} 跨人口口径，必须使用实际执行的拆解方法`);
          if ((childFrame.snapshotId !== parentFrame.snapshotId || childFrame.datasetVersion !== parentFrame.datasetVersion) && !reports.some((method) => ["compare", "scan", "robustness"].includes(method.method) && method.frameIds.includes(childFrame.id) && method.frameIds.includes(parentFrame.id) && method.checks.some((check) => check.status === "performed"))) add("invalid_comparison", `派生事实 ${id} 跨数据版本但没有显式可比方法`);
        }
      }
      const baseDefinitions = new Map<string, { frames: Set<string>; definitions: Set<string> }>();
      for (const parentId of references) {
        const parent = facts.get(parentId); if (!parent || parent.derivation) continue;
        const definition = baseDefinitions.get(parent.metricId) ?? { frames: new Set<string>(), definitions: new Set<string>() };
        definition.frames.add(parent.frameId); definition.definitions.add(parent.definition); baseDefinitions.set(parent.metricId, definition);
      }
      for (const [metric, definition] of baseDefinitions) if (definition.frames.size > 1 && definition.definitions.size > 1) add("invalid_comparison", `派生事实 ${id} 的同名基础指标 ${metric} 定义不同，不能直接比较`);
      function signature(exp: FactExpression): Record<string, number> | undefined {
        if ("factId" in exp) { const parent = facts.get(exp.factId); return parent ? unitSignature(parent.unit) : undefined; }
        if ("constant" in exp) return {};
        const values = exp.args.map(signature);
        if (values.some((value) => value === undefined)) return undefined;
        const dimensions = values as Record<string, number>[];
        if (exp.op === "add" || exp.op === "subtract") {
          if (dimensions.some((value) => !same(value, dimensions[0]))) add("invalid_comparison", `派生事实 ${id} 加减了不同单位的表达式`);
          return dimensions[0];
        }
        const combined = Object.create(null) as Record<string, number>;
        dimensions.forEach((value, index) => { for (const [atom, power] of Object.entries(value)) combined[atom] = (combined[atom] ?? 0) + power * (exp.op === "divide" && index ? -1 : 1); });
        for (const atom of Object.keys(combined)) if (combined[atom] === 0) delete combined[atom];
        return combined;
      }
      const derivedUnit = signature(fact.derivation);
      if (derivedUnit && !same(derivedUnit, unitSignature(fact.unit))) add("invalid_comparison", `派生事实 ${id} 的结果单位与实际运算单位不一致`);
      function evaluate(exp: FactExpression): number | null | undefined {
        if ("factId" in exp) return facts.get(exp.factId)?.value;
        if ("constant" in exp) return exp.constant;
        const values = exp.args.map(evaluate);
        if (values.some((value) => value === undefined)) return undefined;
        if (values.some((value) => value === null)) return null;
        const numbers = values as number[];
        const result = exp.op === "add" ? numbers.reduce((sum, value) => sum + value, 0) : exp.op === "subtract" ? numbers[0] - numbers[1] : exp.op === "multiply" ? numbers.reduce((product, value) => product * value, 1) : numbers[1] === 0 ? null : numbers[0] / numbers[1];
        if (result !== null && !Number.isFinite(result)) { add("missing_evidence", `派生事实 ${id} 的计算结果不是有限值`); return undefined; }
        return result;
      }
      const expected = evaluate(fact.derivation);
      if (expected !== undefined && (expected === null || fact.value === null ? expected !== fact.value : Math.abs(expected - fact.value) > 1e-12 + Number.EPSILON * 16 * Math.max(1, Math.abs(expected), Math.abs(fact.value)))) add("missing_evidence", `派生事实 ${id} 的实际值与父事实运算结果不一致，缺失与零不能互换`);
    }
    states.set(id, "done");
  }
  for (const fact of evidence.facts) { inspect(fact.id); if (++handled % EVIDENCE_BATCH_SIZE === 0) yield; }
  return issues;
}

function finishSteps<T>(steps: Generator<void, T>): T {
  while (true) { const next = steps.next(); if (next.done) return next.value; }
}
function checkEvidence(evidence: AnalysisEvidence): AnalysisReviewIssue[] { return finishSteps(checkEvidenceSteps(evidence)); }

export function validateAnalysisEvidence(value: unknown): AnalysisEvidence {
  const evidence = parseEvidence(value); const issues = checkEvidence(evidence);
  if (issues.length) fail(issues.map((issue) => issue.requirement).join("；"));
  return evidence;
}

function freezeEvidence<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeEvidence(child);
  return Object.freeze(value);
}

// 仅登记本模块逐项解析且深冻结的数组；外部自行 freeze 不能跳过输入隔离。
const sealedEvidenceArrays = new WeakMap<object, keyof AnalysisEvidence>();
async function yieldEvidenceWork() {
  await new Promise<void>((resolve) => {
    if ("setImmediate" in globalThis && typeof globalThis.setImmediate === "function") globalThis.setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

// 接管尚未交付的计算结果，逐项替换为规范的只读记录；不同时构造第二份百万事实图。
export async function sealOwnedAnalysisOperation(result: AnalysisOperationResult, signal?: AbortSignal): Promise<AnalysisOperationResult> {
  throwIfTurnCancelled(signal);
  const needIds = ids(result.needIds, "操作事项编号"), limitations = strings(result.limitations, "操作限制");
  const parsers = { frames: parseFrame, facts: parseFact, objects: parseObject, methods: parseMethod };
  let handled = 0;
  for (const key of ["frames", "facts", "objects", "methods"] as const) {
    const values = result[key]; if (!Array.isArray(values)) fail("分析证据必须是数组");
    for (let index = 0; index < values.length; index++) {
      const item = parsers[key](values[index], `分析证据 ${key}[${index}]`);
      (values as Array<AnalysisFrame | AnalysisFact | AnalysisObject | AnalysisMethodReport>)[index] = freezeEvidence(item);
      if (++handled % EVIDENCE_BATCH_SIZE === 0) { await yieldEvidenceWork(); throwIfTurnCancelled(signal); }
    }
    Object.freeze(values); sealedEvidenceArrays.set(values, key);
  }
  throwIfTurnCancelled(signal); Object.freeze(needIds); Object.freeze(limitations);
  return Object.freeze({ ...result, needIds, limitations });
}

export function createEvidenceRegistry(): EvidenceRegistry {
  let evidence: AnalysisEvidence = freezeEvidence({ frames: [], facts: [], objects: [], methods: [] });
  type OperationContent = AnalysisEvidence & { method: AnalysisOperationResult["method"]; status: AnalysisOperationResult["status"]; limitations: string[] };
  let operations = new Map<string, OperationContent>();
  const keys = ["frames", "facts", "objects", "methods"] as const;
  type EvidenceItem = AnalysisFrame | AnalysisFact | AnalysisObject | AnalysisMethodReport;
  function* ingestSteps(result: AnalysisOperationResult): Generator<void, void> {
      const previous = evidence, previousOperations = operations;
      const raw = object(result, "分析操作结果");
      const operationId = text(raw.operationId, "操作编号"), method = choice(raw.method, ANALYSIS_METHODS, "操作方法"), status = choice(raw.status, ["completed", "unsupported"] as const, "操作状态");
      ids(raw.needIds, "操作事项编号"); text(raw.purpose, "操作目的"); const limitations = strings(raw.limitations, "操作限制");
      const incoming: AnalysisEvidence = { frames: [], facts: [], objects: [], methods: [] };
      const parsers = { frames: parseFrame, facts: parseFact, objects: parseObject, methods: parseMethod };
      const names = { frames: "证据范围", facts: "事实", objects: "业务对象", methods: "实际方法" };
      let handled = 0;
      for (const key of keys) {
        const values = raw[key]; if (!Array.isArray(values)) fail(`${names[key]}必须是数组`);
        const uniqueIds = new Set<string>();
        for (let index = 0; index < values.length; index++) {
          const item = sealedEvidenceArrays.get(values) === key ? values[index] as EvidenceItem : parsers[key](values[index], `${names[key]}[${index}]`);
          if (uniqueIds.has(item.id)) fail(`证据 ${key}有重复编号`);
          uniqueIds.add(item.id); (incoming[key] as EvidenceItem[]).push(item);
          if (++handled % EVIDENCE_BATCH_SIZE === 0) yield;
        }
      }
      if (!incoming.methods.length) fail(`操作 ${operationId} 没有真实方法记录`);
      for (const report of incoming.methods) if (report.operationId !== operationId || report.method !== method || report.status !== status) fail(`实际方法 ${report.id} 与操作编号、方法或整体执行状态不一致`);
      const content = { method, status, limitations, ...incoming };
      const priorContent = previousOperations.get(operationId);
      if (priorContent) {
        if (!same({ method: priorContent.method, status: priorContent.status, limitations: priorContent.limitations }, { method, status, limitations })) fail(`操作编号 ${operationId} 已注册，不能覆盖不同内容`);
        for (const key of keys) {
          if (priorContent[key].length !== incoming[key].length) fail(`操作编号 ${operationId} 已注册，不能覆盖不同内容`);
          for (let index = 0; index < incoming[key].length; index++) {
            if (!same(priorContent[key][index], incoming[key][index])) fail(`操作编号 ${operationId} 已注册，不能覆盖不同内容`);
            if (++handled % EVIDENCE_BATCH_SIZE === 0) yield;
          }
        }
      }
      const merged: AnalysisEvidence = { frames: [], facts: [], objects: [], methods: [] };
      for (const key of keys) {
        const combined = new Map<string, EvidenceItem>();
        for (const item of previous[key]) { combined.set(item.id, item); if (++handled % EVIDENCE_BATCH_SIZE === 0) yield; }
        for (const item of incoming[key]) {
          const prior = combined.get(item.id);
          if (prior && !same(prior, item)) fail(`证据编号 ${item.id} 已存在且内容不同，不能覆盖真实值`);
          if (key === "facts" && (item as AnalysisFact).operationId !== operationId && !prior) fail(`事实 ${item.id} 不是本操作生成或已经读取的事实`);
          combined.set(item.id, item);
          if (++handled % EVIDENCE_BATCH_SIZE === 0) yield;
        }
        // 大结果逐项加入，避免把全量事实展开成函数参数后超过运行时栈限制。
        for (const item of combined.values()) { (merged[key] as EvidenceItem[]).push(item); if (++handled % EVIDENCE_BATCH_SIZE === 0) yield; }
      }
      const issues = yield* checkEvidenceSteps(merged);
      if (issues.length) fail(issues.map((issue) => issue.requirement).join("；"));
      // 逐项解析已隔离入参；冻结记录后内部可直接只读，分页不再重复深拷贝百万事实。
      for (const key of keys) {
        for (const item of merged[key]) { freezeEvidence(item); if (++handled % EVIDENCE_BATCH_SIZE === 0) yield; }
        Object.freeze(merged[key]);
      }
      if (evidence !== previous || operations !== previousOperations) fail("证据登记期间当前视图已改变，请重新登记");
      evidence = Object.freeze(merged); operations.set(operationId, content);
  }
  return {
    ingest(result: AnalysisOperationResult): void { finishSteps(ingestSteps(result)); },
    async ingestAsync(result: AnalysisOperationResult, signal?: AbortSignal): Promise<void> {
      const steps = ingestSteps(result);
      try {
        while (true) {
          if (signal?.aborted) throw new DOMException("分析已取消", "AbortError");
          const next = steps.next(); if (next.done) return;
          // 分批让出主线程；校验和冻结完成前始终保留旧视图，取消不会留下半份证据。
          await yieldEvidenceWork();
        }
      } finally { steps.return(); }
    },
    bundle: () => clone(evidence),
    view: () => evidence,
    clear: () => { evidence = freezeEvidence({ frames: [], facts: [], objects: [], methods: [] }); operations = new Map(); },
  };
}

// 完成回答仅传其依赖的事实；未完成时保留已捕获依据，方便用户展开核对。
export function selectAnalysisEvidence(draft: AnalysisDraft, evidence: AnalysisEvidence): AnalysisEvidence {
  if (draft.status === "incomplete") return clone(evidence);
  const facts = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const objects = new Map(evidence.objects.map((object) => [object.id, object]));
  const factIds = new Set(draft.conclusions.flatMap((conclusion) => conclusion.factIds));
  const objectIds = new Set([...draft.conclusions.flatMap((conclusion) => conclusion.objectIds), ...draft.trialParameters.flatMap((parameter) => parameter.objectIds)]);
  const methodIds = new Set(draft.conclusions.flatMap((conclusion) => conclusion.methodIds));
  const frameIds = new Set<string>();
  for (const spec of draft.visualizations?.items ?? []) {
    const chart = resolveAnalysisVisualization(spec, evidence);
    chart.factIds.forEach((id) => factIds.add(id)); chart.objectIds.forEach((id) => objectIds.add(id));
  }
  for (const block of draft.blocks) for (const node of block.nodes) {
    if (node.kind === "fact_ref") factIds.add(node.factId);
    if (node.kind === "object_ref") objectIds.add(node.objectId);
    if (node.kind === "period_ref") frameIds.add(node.frameId);
  }
  // Set 迭代会包含中新加入的父引用，不递归展开长事实链。
  const operationIds = new Set<string>();
  for (const id of factIds) {
    const fact = facts.get(id); if (!fact) fail(`最终证据投影缺少事实 ${id}`);
    frameIds.add(fact.frameId); operationIds.add(fact.operationId); fact.objectIds.forEach((objectId) => objectIds.add(objectId));
    analysisFactParents(fact).forEach((parentId) => factIds.add(parentId));
  }
  for (const id of objectIds) {
    const object = objects.get(id); if (!object) fail(`最终证据投影缺少对象 ${id}`);
    frameIds.add(object.frameId);
  }
  for (const method of evidence.methods) if (operationIds.has(method.operationId) || methodIds.has(method.id)) {
    methodIds.add(method.id); method.frameIds.forEach((id) => frameIds.add(id));
  }
  for (const id of methodIds) if (!evidence.methods.some((method) => method.id === id)) fail(`最终证据投影缺少方法 ${id}`);
  for (const id of frameIds) if (!evidence.frames.some((frame) => frame.id === id)) fail(`最终证据投影缺少数据范围 ${id}`);
  return clone({ frames: evidence.frames.filter((frame) => frameIds.has(frame.id)), facts: evidence.facts.filter((fact) => factIds.has(fact.id)), objects: evidence.objects.filter((object) => objectIds.has(object.id)), methods: evidence.methods.filter((method) => methodIds.has(method.id)) });
}

// 时间指代不声明成交次数；除此之外保留数值守卫，活动或门店名称仍须用对象引用。
function numberExpressions(value: string): string[] {
  // 只豁免句首或标点后可独立识别的时间指代；嵌在动词补语内的“一次”仍声明数量。
  const content = value.replace(/(?<![\p{L}\p{N}])(?:上|下|这|那)一次/gu, (text) => " ".repeat(text.length));
  const expressions = [
    /\p{N}+(?:[.,]\p{N}+)*/gu,
    /百分之\s*(?:[零〇一二两三四五六七八九十百千万亿半][零〇一二两三四五六七八九十百千万亿点半]*|点[零〇一二两三四五六七八九十百千万亿]+)/g,
    /[零〇一二两三四五六七八九十百千万亿]+分之[零〇一二两三四五六七八九十百千万亿]+|一半|半数|半价|过半/g,
    /[零〇一二两三四五六七八九十百千万亿半][零〇一二两三四五六七八九十百千万亿点半]*\s*(?:个百分点|百分比|家|个|间|天|周|个月|月|年|日|元|块|分(?:钱|钟)|成|折|件|单|克|人|次|名|倍|%|％)/g,
    /(?:第|前|后|排名|排行|TOP)\s*[零〇一二两三四五六七八九十百千万亿]+/gi,
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million)\s+(?:percent|stores?|days?|weeks?|months?|years?|orders?|grams?|yuan|dollars?|times)\b/gi,
  ].flatMap((pattern) => [...content.matchAll(pattern)].map((match) => match[0]));
  expressions.push(...(content.match(/[零〇一二两三四五六七八九十百千万亿]+/g) ?? []).filter((number) => number.length > 1 && /[十百千万亿]/.test(number)));
  return [...new Set(expressions)];
}
const containsNumber = (value: string) => numberExpressions(value).length > 0;

export function validateAnalysisDraft(task: AnalysisTask, draft: unknown, evidence: AnalysisEvidence): DraftValidation {
  const issues: AnalysisReviewIssue[] = [];
  const add = (kind: IssueKind, requirement: string, conclusion?: AnalysisConclusion, needIds: string[] = []) => issues.push({ kind, requirement, needIds: conclusion?.needIds ?? needIds, conclusionIds: conclusion ? [conclusion.id] : [] });
  let t: AnalysisTask, d: AnalysisDraft, e: AnalysisEvidence;
  try { t = parseTask(task); } catch (error) { add("task_coverage", error instanceof Error ? error.message : "分析任务格式不正确"); return { valid: false, issues }; }
  try { e = parseEvidence(evidence); } catch (error) { add("missing_evidence", error instanceof Error ? error.message : "证据格式不正确"); return { valid: false, issues }; }
  try { d = parseDraft(draft); } catch (error) { add("expression", error instanceof Error ? error.message : "回答草稿格式不正确"); return { valid: false, issues }; }
  issues.push(...checkEvidence(e));
  const frames = new Map(e.frames.map((entry) => [entry.id, entry])), facts = new Map(e.facts.map((entry) => [entry.id, entry])), objects = new Map(e.objects.map((entry) => [entry.id, entry])), methods = new Map(e.methods.map((entry) => [entry.id, entry]));
  const conclusions = new Map(d.conclusions.map((entry) => [entry.id, entry]));
  for (const spec of d.visualizations?.items ?? []) {
    try {
      if (spec.conclusionId && !conclusions.has(spec.conclusionId)) fail("图表关联的结论引用不存在");
      resolveAnalysisVisualization(spec, e);
    } catch (error) { add("expression", error instanceof Error ? error.message : "图表未通过核验"); }
  }
  const needs = new Map(t.needs.map((entry) => [entry.id, entry]));
  const sourceLimits = new Set([...e.frames.flatMap((entry) => entry.limitations), ...e.facts.flatMap((entry) => entry.limitations), ...e.methods.flatMap((entry) => entry.limitations)]);
  function qualitative(value: string, path: string, conclusion?: AnalysisConclusion): void {
    const numbers = numberExpressions(value);
    if (numbers.length) add("expression", `${path}含有未绑定证据的数值（${numbers.slice(0, 5).map((number) => `“${number}”`).join("、")}）；请使用事实、对象、周期、用户条件或计划引用`, conclusion);
  }
  const conditionMap = new Map(d.userConditions.map((entry) => [entry.id, entry]));
  for (const condition of d.userConditions) if (![t.question, ...t.context].some((quote) => quote.includes(condition.quote))) add("expression", `用户条件 ${condition.id} 不是本轮问题或持续要求的真实子串`);
  const parameterMap = new Map(d.trialParameters.map((entry) => [entry.id, entry]));
  for (const parameter of d.trialParameters) {
    if (parameter.value <= 0) add("expression", `计划 ${parameter.id} 只能是拟议正整数`);
    if (!parameter.conditions.length) add("unclear_action", `计划 ${parameter.id} 必须说明尚需确认的业务条件`);
    parameter.conditions.forEach((condition) => qualitative(condition, `计划 ${parameter.id} 的条件`));
    for (const id of parameter.objectIds) if (!objects.has(id) || objects.get(id)?.dimension !== "store") add("missing_evidence", `计划 ${parameter.id} 的候选 ${id} 不是实际读取的门店对象`);
    if (parameter.kind === "store_count") {
      const selected = parameter.objectIds.map((id) => objects.get(id));
      const count = new Set(selected.map((item) => item?.value).filter(Boolean)).size;
      if (!parameter.objectIds.length || count !== parameter.objectIds.length || parameter.value !== count) add("expression", `计划 ${parameter.id} 的门店数量必须等于不同真实候选的引用数量，不能从门店编号推算或重复计数`);
    }
  }
  for (const frame of e.frames) {
    if (t.hardScope.period && (frame.scope.period.start < t.hardScope.period.start || frame.scope.period.end > t.hardScope.period.end)) add("missing_evidence", `数据范围 ${frame.id} 的周期超出用户硬范围`);
    for (const key of FILTERS) {
      const allowed = t.hardScope.filters[key];
      if (allowed && (!frame.scope.filters[key]?.length || frame.scope.filters[key]?.some((value) => !allowed.includes(value)))) add("missing_evidence", `数据范围 ${frame.id} 的 ${key} 超出或解除了用户硬筛选`);
    }
  }
  function ancestry(ids: string[]): Set<string> {
    const result = new Set<string>();
    const walk = (id: string) => { if (result.has(id)) return; result.add(id); const fact = facts.get(id); if (fact) analysisFactParents(fact).forEach(walk); };
    ids.forEach(walk); return result;
  }
  if (d.coverage) {
    const seen = new Set<string>();
    for (const entry of d.coverage) {
      if (!needs.has(entry.needId)) add("task_coverage", `逐事项覆盖引用了未知事项 ${entry.needId}`);
      if (seen.has(entry.needId)) add("task_coverage", `逐事项覆盖重复声明事项 ${entry.needId}`, undefined, [entry.needId]);
      seen.add(entry.needId);
      if (containsNumber(entry.reason)) add("expression", `事项 ${entry.needId} 的状态依据包含未绑定证据的数值，请用定性说明`, undefined, [entry.needId]);
      if (d.status === "answered" && entry.status !== "supported" || d.status === "conditional" && entry.status === "open") add("task_coverage", `事项 ${entry.needId} 的逐项状态与整体回答状态不一致`, undefined, [entry.needId]);
      if (entry.status !== "open" && !d.conclusions.some((conclusion) => conclusion.needIds.includes(entry.needId))) add("task_coverage", `事项 ${entry.needId} 声称已处理但没有相关结论`, undefined, [entry.needId]);
      if ((entry.status === "conditional" || entry.status === "needs_business_input") && !d.conclusions.some((conclusion) => conclusion.needIds.includes(entry.needId) && conclusion.limitations.length && conclusion.validation)) add("unclear_action", `事项 ${entry.needId} 的有条件判断必须说明限制与验证方式`, undefined, [entry.needId]);
    }
    for (const need of t.needs) if (!seen.has(need.id)) add("task_coverage", `逐事项覆盖遗漏事项 ${need.id}`, undefined, [need.id]);
    if (d.status === "conditional" && !d.coverage.some((entry) => entry.status === "conditional" || entry.status === "needs_business_input")) add("task_coverage", "有条件回答必须声明具体有条件事项，不能把已支持事项一起降级");
  }
  for (const conclusion of d.conclusions) {
    if (!conclusion.needIds.length) add("task_coverage", `结论 ${conclusion.id} 没有关联待答事项`, conclusion);
    for (const id of conclusion.needIds) if (!needs.has(id)) add("task_coverage", `结论 ${conclusion.id} 引用了未知待答事项 ${id}`, conclusion);
    qualitative(conclusion.judgement, `结论 ${conclusion.id} 的判断`, conclusion);
    if (conclusion.action) qualitative(conclusion.action, `结论 ${conclusion.id} 的建议`, conclusion);
    if (conclusion.validation) qualitative(conclusion.validation, `结论 ${conclusion.id} 的验证方式`, conclusion);
    for (const limit of conclusion.limitations) if (!sourceLimits.has(limit)) qualitative(limit, `结论 ${conclusion.id} 的限制`, conclusion);
    for (const id of conclusion.factIds) if (!facts.has(id)) add("missing_evidence", `结论 ${conclusion.id} 引用了未读取的事实 ${id}`, conclusion);
    for (const id of conclusion.objectIds) if (!objects.has(id)) add("missing_evidence", `结论 ${conclusion.id} 引用了未读取的对象 ${id}`, conclusion);
    for (const id of conclusion.methodIds) if (!methods.has(id)) add("missing_evidence", `结论 ${conclusion.id} 引用了未知方法 ${id}`, conclusion);
    if (conclusion.level !== "hypothesis" && !conclusion.factIds.length) add("missing_evidence", `结论 ${conclusion.id} 的已观察判断需要真实事实`, conclusion);
    if (conclusion.level === "hypothesis" && !conclusion.limitations.length) add("unsupported_explanation", `结论 ${conclusion.id} 的假设必须说明未验证的限制`, conclusion);
    if (conclusion.level !== "hypothesis" && [...ancestry(conclusion.factIds)].some((id) => facts.get(id)?.assumption)) add("unsupported_explanation", `结论 ${conclusion.id} 含情景假设或其派生结果，不能标为真实观察或历史比较`, conclusion);
    if (conclusion.action && conclusion.level === "hypothesis" && !conclusion.validation) add("unclear_action", `结论 ${conclusion.id} 的假设建议需要验证办法`, conclusion);
    if (conclusion.level === "comparison_supported") {
      const closure = ancestry(conclusion.factIds), usedFrames = new Set([...closure].map((id) => facts.get(id)?.frameId).filter((id): id is string => Boolean(id)));
      const anchorMembers = new Map<string, Set<string>>();
      // 实际比较派生必须关联同一代码配对的两个端点；基础比率的分子分母不是比较端点。
      for (const id of closure) {
        const anchor = facts.get(id); if (!anchor?.comparisonKey || !anchor.derivation || !["within_stratum", "standardized"].includes(anchor.comparisonRole ?? "")) continue;
        const members = [...ancestry([id])].map((parentId) => facts.get(parentId)).filter((parent): parent is AnalysisFact => Boolean(parent && parent.comparisonKey === anchor.comparisonKey && parent.operationId === anchor.operationId));
        const endpoints = members.filter((member) => member.id !== id && ![...ancestry([member.id])].some((parentId) => parentId !== member.id && facts.get(parentId)?.comparisonKey === anchor.comparisonKey));
        if (endpoints.length < 2 || endpoints.some((endpoint) => endpoint.comparisonRole !== anchor.comparisonRole)) continue;
        const controls = anchor.comparisonControls;
        if (!controls || members.some((member) => !same([...(member.comparisonControls ?? [])].sort(), [...controls].sort()))) continue;
        if (anchor.comparisonRole === "within_stratum" && members.some((member) => controls.some((dimension) => !anchor.comparisonValues?.[dimension] || member.comparisonValues?.[dimension] !== anchor.comparisonValues[dimension]))) {
          add("invalid_comparison", `结论 ${conclusion.id} 的比较配对 ${anchor.comparisonKey} 混入不同或未知实际控制值`, conclusion); continue;
        }
        anchorMembers.set(anchor.comparisonKey, new Set(members.map((member) => member.id)));
      }
      for (const id of conclusion.factIds) {
        const fact = facts.get(id); if (!fact) continue;
        const ratioFamilies = new Set([...ancestry([id])].map((parentId) => facts.get(parentId)?.metricId.split(".")[0]).filter((metric) => metric === "amount_per_gram" || metric === "gap_per_gram" || metric === "amount_per_order"));
        if (!ratioFamilies.size) continue;
        const required = ratioFamilies.has("amount_per_gram") || ratioFamilies.has("gap_per_gram") ? ["category", "material"] as const : [];
        if (fact.comparisonRole !== "within_stratum" && fact.comparisonRole !== "standardized") add("invalid_comparison", `结论 ${conclusion.id} 的比率依据 ${id} 是原始描述或未核对比较角色；必须引用实际同层或标准化事实，不能借用方法的控制记录`, conclusion);
        else if (!fact.comparisonControls || required.some((dimension) => !fact.comparisonControls?.includes(dimension))) add("invalid_comparison", `结论 ${conclusion.id} 的比率依据 ${id} 缺少真实货类与材料控制，不能声称受控比较`, conclusion);
        else {
          const related = fact.comparisonKey ? anchorMembers.get(fact.comparisonKey)?.has(id) : [...ancestry([id])].some((parentId) => { const parent = facts.get(parentId); return Boolean(parent?.comparisonKey && anchorMembers.get(parent.comparisonKey)?.has(parentId)); });
          if (!related) add("invalid_comparison", `结论 ${conclusion.id} 的比率依据 ${id} 未关联本结论引用的代码实际比较派生；请引用真实配对的差额、变化或标准化比较，不要拼接不同分层原值`, conclusion);
          if (fact.comparisonRole === "within_stratum" && fact.comparisonControls.some((dimension) => !fact.comparisonValues?.[dimension])) add("invalid_comparison", `结论 ${conclusion.id} 的同层比率 ${id} 缺少完整实际控制值，不能仅凭维度名称比较`, conclusion);
        }
      }
      const candidates = conclusion.methodIds.map((id) => methods.get(id)).filter((report): report is AnalysisMethodReport => Boolean(report));
      const performed = candidates.filter((report) => report.status === "completed" && report.checks.some((check) => check.status === "performed") && [...closure].some((id) => facts.get(id)?.operationId === report.operationId));
      const comparable = performed.filter((report) => ["compare", "scan", "robustness"].includes(report.method) || report.method === "decompose" && new Set(report.frameIds.map((id) => frames.get(id)).filter(Boolean).map((frame) => `${frame?.scope.period.start}/${frame?.scope.period.end}`)).size > 1);
      if (!comparable.length) add("invalid_comparison", `结论 ${conclusion.id} 需要引用与事实匹配、实际 performed 的比较、扫描、稳健性或跨期拆解方法`, conclusion);
      for (const report of comparable) {
        const refs = report.frameIds.filter((id) => usedFrames.has(id)).map((id) => frames.get(id)).filter((ref): ref is AnalysisFrame => Boolean(ref));
        const netComposition = report.method === "decompose" && refs.some((ref) => ref.scope.population === "net") && refs.every((ref) => ["net", "sales", "zero_sales", "returns"].includes(ref.scope.population)) && conclusion.factIds.some((id) => {
          const fact = facts.get(id); return fact?.operationId === report.operationId && frames.get(fact.frameId)?.scope.population === "net";
        });
        if (new Set(refs.map((ref) => currency(ref.currency))).size > 1 || refs.some((ref) => !knownCurrency(ref.currency)) || new Set(refs.map((ref) => ref.grain)).size > 1 || refs.some((ref) => ref.grain === "unknown" || ref.scope.population === "unknown") || !netComposition && new Set(refs.map((ref) => ref.scope.population)).size > 1) add("invalid_comparison", `结论 ${conclusion.id} 的比较币种、粒度或人口口径不一致或尚未核对`, conclusion);
        const definitions = new Map<string, { frames: Set<string>; definitions: Set<string>; units: Set<string> }>();
        for (const id of closure) {
          const fact = facts.get(id); if (!fact || fact.derivation || !report.frameIds.includes(fact.frameId)) continue;
          const definition = definitions.get(fact.metricId) ?? { frames: new Set<string>(), definitions: new Set<string>(), units: new Set<string>() };
          definition.frames.add(fact.frameId); definition.definitions.add(fact.definition); definition.units.add(JSON.stringify(Object.entries(unitSignature(fact.unit)).sort())); definitions.set(fact.metricId, definition);
        }
        for (const [metric, definition] of definitions) if (definition.frames.size > 1 && (definition.definitions.size > 1 || definition.units.size > 1)) add("invalid_comparison", `结论 ${conclusion.id} 的基础指标 ${metric} 定义或单位不同，不能以标签相同认定可比`, conclusion);
      }
    }
    if (!d.blocks.some((block) => block.conclusionId === conclusion.id && block.nodes.some((node) => node.kind !== "text" || node.text.trim()))) add("task_coverage", `结论 ${conclusion.id} 没有出现在正文中`, conclusion);
  }
  for (const need of t.needs) if (!d.conclusions.some((conclusion) => conclusion.needIds.includes(need.id)) && d.status !== "incomplete") add("task_coverage", `待答事项 ${need.id} 尚无相关结论：${need.judgement}`, undefined, [need.id]);
  if (!d.blocks.length || !d.blocks.some((block) => block.nodes.some((node) => node.kind !== "text" || node.text.trim()))) add("expression", "回答正文为空，不能作为完成结果");
  for (const [blockIndex, block] of d.blocks.entries()) {
    const conclusion = block.conclusionId ? conclusions.get(block.conclusionId) : undefined;
    if (block.conclusionId && !conclusion) add("task_coverage", `段落 ${blockIndex} 引用了未知结论 ${block.conclusionId}`);
    const allowedFacts = conclusion ? ancestry(conclusion.factIds) : undefined;
    const allowedObjects = conclusion ? new Set([...conclusion.objectIds, ...[...(allowedFacts ?? [])].flatMap((id) => facts.get(id)?.objectIds ?? [])]) : undefined;
    let textRun = "";
    for (const node of block.nodes) {
      if (node.kind === "text") textRun += node.text;
      else { if (textRun) qualitative(textRun, `段落 ${blockIndex} 的连续文字`, conclusion); textRun = ""; }
    }
    if (textRun) qualitative(textRun, `段落 ${blockIndex} 的连续文字`, conclusion);
    for (const [nodeIndex, node] of block.nodes.entries()) {
      const at = `段落 ${blockIndex} 节点 ${nodeIndex}`;
      if (node.kind === "text") continue;
      else if (node.kind === "fact_ref") {
        if (!facts.has(node.factId)) add("missing_evidence", `${at}引用了未读取的事实 ${node.factId}`, conclusion);
        else if (allowedFacts && !allowedFacts.has(node.factId)) add("missing_evidence", `${at}的事实 ${node.factId} 没有登记为该结论依据`, conclusion);
      } else if (node.kind === "object_ref") {
        if (!objects.has(node.objectId)) add("missing_evidence", `${at}引用了未读取的对象 ${node.objectId}`, conclusion);
        else if (allowedObjects && !allowedObjects.has(node.objectId)) add("missing_evidence", `${at}的对象 ${node.objectId} 没有登记为该结论对象`, conclusion);
        let following = "";
        for (const next of block.nodes.slice(nodeIndex + 1)) { if (next.kind !== "text") break; following += next.text; }
        const suffix = /^\s*(个百分点|家|个|间|天|周|月|年|元|件|单|克|人|次|倍|%|％)/.exec(following);
        const metricWord = suffix && (/^(件|单|克|人)$/.test(suffix[1]) && /^(数|量|价|额|重|均)/.test(following.slice(suffix[0].length)) || suffix[1] === "单" && /^日(?:实收|销售|成交|金额|毛利|订单|件数|克重)/.test(following.slice(suffix[0].length)));
        if (suffix && !metricWord) add("expression", `${at}把对象名称或编号当作经营数量；数量必须引用事实或试点计划`, conclusion);
      } else if (node.kind === "period_ref") { if (!frames.has(node.frameId)) add("missing_evidence", `${at}引用了不存在的周期 ${node.frameId}`, conclusion); }
      else if (node.kind === "user_condition_ref") { if (!conditionMap.has(node.conditionId)) add("expression", `${at}引用了未知用户条件 ${node.conditionId}`, conclusion); }
      else {
        if (!parameterMap.has(node.parameterId)) add("expression", `${at}引用了未知计划 ${node.parameterId}`, conclusion);
        const previous = block.nodes.slice(0, nodeIndex).filter((entry): entry is Extract<AnalysisAnswerNode, { kind: "text" }> => entry.kind === "text").map((entry) => entry.text).join("").slice(-60);
        const next = block.nodes[nodeIndex + 1];
        if (/(?:预计|预期|预测|保证|确保|有望|将会|将|能|可).*(?:增长|提升|收益|销售|回报|增收|达到)\s*[为约：:]?$/.test(previous) || next?.kind === "text" && /^\s*(?:%|％|个百分点|元|收益|销售额)/.test(next.text)) add("unsupported_explanation", `${at}不能把试点对象数或天数包装成增长或收益预测`, conclusion);
      }
    }
  }
  d.questions.forEach((question) => qualitative(question, "业务追问"));
  const deduplicated = issues.filter((issue, index) => !issues.slice(0, index).some((prior) => same(prior, issue)));
  return { valid: deduplicated.length === 0, issues: deduplicated };
}

function parseReview(value: unknown): AnalysisSemanticReview {
  const item = object(value, "独立复核");
  return { verdict: choice(item.verdict, ["accept", "revise", "accept_conditional"] as const, "复核结论"), issues: list(item.issues, (raw, at) => { const issue = object(raw, at); return { kind: choice(issue.kind, ISSUE_KINDS, `${at}问题类型`), needIds: ids(issue.needIds, `${at}事项编号`), conclusionIds: ids(issue.conclusionIds, `${at}结论编号`), requirement: text(issue.requirement, `${at}具体要求`) }; }, "复核问题") };
}
function parseTrace(value: unknown): ToolTrace {
  if (!isToolTrace(value)) fail("执行过程记录格式不正确");
  const trace: ToolTrace = { status: value.status, durationMs: value.durationMs, steps: value.steps.map((step) => ({ id: step.id, tool: step.tool, title: step.title, status: step.status, initiatedBy: step.initiatedBy, startedAt: step.startedAt, ...(step.summary === undefined ? {} : { summary: step.summary }), ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }) })), ...(value.timing ? { timing: { totalMs: value.timing.totalMs, analysisWaitingMs: value.timing.analysisWaitingMs, skillsToolsMs: value.timing.skillsToolsMs } } : {}) };
  return trace;
}

export function validateAnalysisAnswer(value: unknown): AnalysisAnswer {
  const item = object(value, "最终分析回答");
  if (item.schema !== ANALYSIS_ANSWER_SCHEMA) fail("最终分析回答版本不正确，不从旧来源 metadata 补装新证据");
  const task = parseTask(item.task), evidence = parseEvidence(item.evidence), draft = parseDraft(item), review = parseReview(item.review);
  const checked = validateAnalysisDraft(task, draft, evidence);
  if (!checked.valid) fail(checked.issues.map((issue) => issue.requirement).join("；"));
  if (draft.status === "answered" && (review.verdict !== "accept" || review.issues.length) || draft.status === "conditional" && review.verdict !== "accept_conditional" || draft.status === "incomplete" && (review.verdict !== "revise" || !review.issues.length)) fail("回答状态与独立复核结论不一致");
  const conclusionIds = new Set(draft.conclusions.map((conclusion) => conclusion.id));
  const needIds = new Set(task.needs.map((need) => need.id));
  for (const issue of review.issues) {
    if (issue.needIds.some((id) => !needIds.has(id)) || issue.conclusionIds.some((id) => !conclusionIds.has(id))) fail("独立复核问题引用了不存在的事项或结论");
  }
  for (const need of task.needs) {
    const actual = draft.conclusions.filter((conclusion) => conclusion.needIds.includes(need.id)).map((conclusion) => conclusion.id);
    if (need.conclusionIds.some((id) => !conclusionIds.has(id)) || !same([...need.conclusionIds].sort(), actual.sort())) fail(`待答事项 ${need.id} 的结论覆盖关系不一致`);
    if (draft.status === "answered" && need.status !== "supported" || draft.status === "conditional" && need.status === "open") fail(`待答事项 ${need.id} 尚未完成，不能以当前状态结束`);
    const coverage = draft.coverage?.find((entry) => entry.needId === need.id);
    if (coverage && coverage.status !== need.status) fail(`待答事项 ${need.id} 的最终任务状态与逐事项覆盖状态不一致`);
  }
  if (draft.status === "conditional" && !task.needs.some((need) => need.status === "conditional" || need.status === "needs_business_input")) fail("有条件回答必须标明具体有条件事项或待确认业务事实");
  if (draft.status === "conditional") for (const need of task.needs.filter((need) => need.status === "conditional" || need.status === "needs_business_input")) {
    if (!draft.conclusions.some((conclusion) => conclusion.needIds.includes(need.id) && conclusion.limitations.length && conclusion.validation)) fail(`有条件事项 ${need.id} 必须说明限制与验证方式`);
  }
  return { schema: ANALYSIS_ANSWER_SCHEMA, ...draft, task, evidence, review, ...(item.trace === undefined ? {} : { trace: parseTrace(item.trace) }) };
}
