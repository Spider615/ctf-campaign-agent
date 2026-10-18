import { ANALYSIS_DIMENSIONS, ANALYSIS_METHODS } from "./analysis-v2-types.ts";
import { ANALYSIS_FILTER_KEYS, SEMANTIC_DIMENSIONS, type SemanticFilterKey } from "./semantic/model.ts";
import type { AnalysisEvidence, AnalysisFact, AnalysisFilters, AnalysisFrame, AnalysisMethodReport, AnalysisObject, AnalysisOperationResult, EvidenceRegistry, FactExpression } from "./analysis-v2-types.ts";
import type { Period } from "./types.ts";
import { throwIfTurnCancelled } from "../cancellation.ts";
import { analysisFactParents } from "./analysis-v2-fact-links.ts";
import { scenarioCents, scenarioRevenue } from "./scenario-decimal.ts";

// 证据自检的问题记录，只在本模块内汇总成报错文字。
type IssueKind = "task_coverage" | "missing_evidence" | "invalid_comparison" | "unsupported_explanation" | "unclear_action" | "expression";
type AnalysisReviewIssue = { needIds: string[]; conclusionIds: string[]; requirement: string; kind: IssueKind };
const FILTERS = ANALYSIS_FILTER_KEYS;
const CONTROL_FILTERS = Object.fromEntries(ANALYSIS_DIMENSIONS.map((dimension) => [dimension, SEMANTIC_DIMENSIONS[dimension].filter])) as Record<typeof ANALYSIS_DIMENSIONS[number], SemanticFilterKey>;
const POPULATIONS = ["sales", "net", "recovery", "returns", "zero_sales"] as const;
const GRAINS = ["line", "selected_order", "group", "unknown"] as const;
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
