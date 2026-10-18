import { createAnalysisOperations } from "../analysis-v2-operations.ts";
import { SEMANTIC_DIMENSIONS } from "../semantic/model.ts";
import { isTurnCancelled, throwIfTurnCancelled } from "../../cancellation.ts";
import { simulatePlanScenario } from "./scenario.ts";
import type { AnalysisConstraints, AnalysisDataSession, AnalysisDimension, AnalysisEvidence, AnalysisFact, AnalysisObject, AnalysisMetric, AnalysisOperationRequest, AnalysisOperationResult, AnalysisScope, EvidenceRegistry } from "../analysis-v2-types.ts";
import type { PlanNode, PlanScope } from "./types.ts";

export type NodeRole = "value" | "target" | "reference" | "delta" | "change" | "deviation" | "share" | "contribution" | "check";
export type NodeRow = { key: Record<string, string>; metric: string; factId: string; role: NodeRole; sampleRows?: number };
export type NodeResult = { node: PlanNode; status: "completed" | "unsupported" | "failed"; operationIds: string[]; message?: string; rows: NodeRow[]; robust?: Array<{ check: string; metric: string; kept: boolean | null; detail: string }> };
export type PlanExecution = { results: Map<string, NodeResult>; evidence: AnalysisEvidence };

type Call = Omit<AnalysisOperationRequest, "needIds" | "purpose">;
type Outcome = { result?: AnalysisOperationResult; message?: string };
// 数据来源：measure / contrast 节点的范围、参照与对齐参数，供下游节点沿用。
type Source = { scope: PlanScope; reference?: PlanScope; metrics: string[]; by?: string[]; controls?: string[]; commonStores?: boolean };

// 后缀决定角色；具名分量（amount.quantity_contribution 等）保留完整指标名，其余去掉后缀归到基础指标。
const SUFFIX_ROLES: Array<[string, NodeRole]> = [[".delta", "delta"], [".relative_change", "change"], [".relative_deviation", "deviation"], [".share", "share"], [".change_contribution", "contribution"]];
function roleOf(metricId: string, metrics: string[], reference: boolean, frameIsReference: boolean): { metric: string; role: NodeRole } | undefined {
  for (const [suffix, role] of SUFFIX_ROLES) if (metricId.endsWith(suffix)) return frameIsReference ? undefined : { metric: metricId.slice(0, -suffix.length), role };
  if (metricId.includes(".")) return metricId.endsWith("_contribution") && !frameIsReference ? { metric: metricId, role: "contribution" } : undefined;
  // 无后缀只收节点所问指标与分组个数；比率的分子分母、天数留在证据里。
  if (!metrics.includes(metricId) && metricId !== "distinct_count") return undefined;
  return { metric: metricId, role: frameIsReference ? "reference" : reference ? "target" : "value" };
}
const signature = (key: Record<string, string>) => JSON.stringify(Object.keys(key).sort().map((name) => [name, key[name]]));
// 方向核对：任一侧缺失为 null；原值为零没有方向，也记 null。
function direction(before: number | null, after: number | null): { kept: boolean | null; note?: string } {
  if (before === null || after === null) return { kept: null };
  if (before === 0) return { kept: null, note: "原值为零，无方向可比" };
  return { kept: before > 0 ? after > 0 : after < 0 };
}

export type RowOptions = { metrics: string[]; reference: boolean; roles?: NodeRole[]; sampleRows?: boolean };
// 事实整理成行（不去重）：参照框架由差额事实的派生式确定——subtract(T, R) 中 R 所在框架是参照。
export function rowsFromResult(result: AnalysisOperationResult, objects: Map<string, AnalysisObject>, options: RowOptions): NodeRow[] {
  const byId = new Map(result.facts.map((fact) => [fact.id, fact]));
  const referenceFrames = new Set<string>();
  if (options.reference) for (const fact of result.facts) {
    const derivation = fact.derivation;
    if (!fact.metricId.endsWith(".delta") || !derivation || !("op" in derivation) || derivation.op !== "subtract") continue;
    const second = derivation.args[1]; const frameId = second && "factId" in second ? byId.get(second.factId)?.frameId : undefined;
    if (frameId) referenceFrames.add(frameId);
  }
  const keyOf = (fact: AnalysisFact) => Object.fromEntries(fact.objectIds.map((id) => objects.get(id)).filter(Boolean).map((item) => [item!.dimension, item!.value]));
  const isReference = (fact: AnalysisFact) => referenceFrames.has(fact.frameId);
  const sizes = new Map<string, number>();
  if (options.sampleRows) for (const fact of result.facts) if (fact.metricId === "rows" && !isReference(fact) && fact.value !== null) { const key = signature(keyOf(fact)); if (!sizes.has(key)) sizes.set(key, fact.value); }
  const rows: NodeRow[] = [];
  for (const fact of result.facts) {
    const mapped = roleOf(fact.metricId, options.metrics, options.reference, isReference(fact));
    if (!mapped || options.roles && !options.roles.includes(mapped.role)) continue;
    const key = keyOf(fact); const sampleRows = options.sampleRows ? sizes.get(signature(key)) : undefined;
    rows.push({ key, metric: mapped.metric, factId: fact.id, role: mapped.role, ...(sampleRows !== undefined ? { sampleRows } : {}) });
  }
  return rows;
}
const DAY = 86400000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
// 按天数对半切；奇数天前半段少一天，只有一天时无法拆分。
function halves(period: PlanScope["period"]): [PlanScope["period"], PlanScope["period"]] | undefined {
  const days = Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / DAY) + 1; const first = Math.floor(days / 2);
  if (first < 1) return undefined;
  return [{ start: period.start, end: shift(period.start, first - 1) }, { start: shift(period.start, first), end: period.end }];
}
const isInvalid = (error: unknown) => Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "ANALYSIS_ARGUMENTS_INVALID";
const unsupportedMessage = (result: AnalysisOperationResult) => result.methods.flatMap((method) => method.checks).find((check) => check.name === "方法适用性")?.result ?? (result.limitations.join("；") || "当前数据不支持该分析");

// measure / contrast 节点的数据来源；其他算子没有自己的来源。
function sourceOf(node: PlanNode): Source | undefined {
  if (node.op === "measure") return { scope: node.scope, metrics: node.metrics, ...(node.by?.length ? { by: node.by } : {}) };
  if (node.op === "contrast") return { scope: node.target, reference: node.reference, metrics: node.metrics, ...(node.by?.length ? { by: node.by } : {}), ...(node.align?.controls?.length ? { controls: node.align.controls } : {}), ...(node.align?.commonStores ? { commonStores: true } : {}) };
  return undefined;
}

// prior：此前同一 registry 上已执行的节点结果。of 指向它们时直接沿用其结果和来源，不重跑、不重复登记证据；返回的 results 只含本次执行的节点。
export async function executePlan(nodes: PlanNode[], session: AnalysisDataSession, constraints: AnalysisConstraints, registry: EvidenceRegistry, signal?: AbortSignal, prior?: Map<string, NodeResult>): Promise<PlanExecution> {
  throwIfTurnCancelled(signal);
  const operations = createAnalysisOperations(session, constraints);
  const results = new Map<string, NodeResult>(); const sources = new Map<string, Source>();
  for (const [id, result] of prior ?? []) { const source = result.status === "completed" ? sourceOf(result.node) : undefined; if (source) sources.set(id, source); }
  const resultOf = (id: string) => results.get(id) ?? prior?.get(id);
  const objects = () => new Map(registry.view().objects.map((item) => [item.id, item]));

  for (const node of nodes) {
    throwIfTurnCancelled(signal);
    if (prior?.has(node.id)) continue;
    const output: NodeResult = { node, status: "completed", operationIds: [], rows: [] };
    results.set(node.id, output);
    const parentId = "of" in node ? node.of : undefined;
    if (parentId !== undefined && resultOf(parentId)?.status !== "completed") { output.status = "failed"; output.message = "依赖的节点未完成"; continue; }
    const source = parentId ? sources.get(parentId) : undefined;
    const seen = new Set<string>(); const messages: string[] = [];

    // 调一次分析操作：登记证据；参数不被接受或能力不足记为不支持，其他错误（取消、快照失效）原样抛出。
    const call = async (request: Call): Promise<Outcome> => {
      let result: AnalysisOperationResult;
      try { result = await operations.execute({ needIds: ["plan"], purpose: `${node.op} ${node.id}`, ...request }, signal); }
      catch (error) { if (isInvalid(error)) return { message: (error as Error).message }; throw error; }
      // 证据不通过登记校验只影响本节点，不中断整轮；取消照常抛出。
      try { await registry.ingestAsync(result, signal); }
      catch (error) { if (signal?.aborted || isTurnCancelled(error)) throw error; return { message: `证据未通过校验：${(error as Error).message}` }; }
      output.operationIds.push(result.operationId);
      return result.status === "completed" ? { result } : { result, message: unsupportedMessage(result) };
    };
    // 同一节点内键、指标、角色唯一：跨层重复的父组与总体只保留第一次出现
    const collect = (result: AnalysisOperationResult, options: RowOptions) => {
      for (const row of rowsFromResult(result, objects(), options)) {
        const id = JSON.stringify([signature(row.key), row.metric, row.role]);
        if (seen.has(id)) continue; seen.add(id); output.rows.push(row);
      }
    };
    const scopeOf = (scope: PlanScope) => scope as unknown as AnalysisScope;
    const base = (from: Source): Call => ({ method: "aggregate", scope: scopeOf(from.scope), metrics: from.metrics as AnalysisMetric[],
      ...(from.reference ? { reference: scopeOf(from.reference) } : {}), ...(from.controls?.length ? { controls: from.controls as AnalysisDimension[] } : {}), ...(from.commonStores ? { commonStores: true } : {}) });
    // 多次调用的节点：至少一次完成即算完成，未完成的原因写进 message。
    const settle = (outcomes: Outcome[]) => {
      if (!outcomes.some((item) => item.result?.status === "completed")) output.status = "unsupported";
      const reasons = outcomes.map((item) => item.message).filter(Boolean) as string[]; messages.push(...reasons);
    };

    if (node.op === "measure") {
      const own = sourceOf(node)!; sources.set(node.id, own);
      const outcome = await call({ ...base(own), ...(own.by ? { by: own.by as AnalysisDimension[] } : {}) });
      if (outcome.result?.status === "completed") collect(outcome.result, { metrics: node.metrics, reference: false }); settle([outcome]);
    } else if (node.op === "contrast") {
      const own = sourceOf(node)!; sources.set(node.id, own);
      const outcome = await call({ ...base(own), method: "compare", ...(own.by ? { by: own.by as AnalysisDimension[] } : {}) });
      if (outcome.result?.status === "completed") collect(outcome.result, { metrics: node.metrics, reference: true }); settle([outcome]);
    } else if (node.op === "decompose") {
      const outcome = await call({ method: "decompose", scope: scopeOf(source!.scope), reference: scopeOf(source!.reference!), metrics: ["amount", "quantity"] });
      if (outcome.result?.status === "completed") collect(outcome.result, { metrics: [], reference: true, roles: ["contribution"] }); settle([outcome]);
    } else if (node.op === "drill" || node.op === "scan") {
      const layers: Array<{ by: AnalysisDimension[]; breakdown?: AnalysisDimension }> = [];
      if (node.op === "drill") node.path.forEach((dimension, i) => layers.push({ by: node.path.slice(0, i + 1) as AnalysisDimension[], ...(i > 0 ? { breakdown: dimension as AnalysisDimension } : {}) }));
      else {
        const catalog = session.capabilities.dimensionCatalog;
        const dimensions = node.dimensions?.length ? node.dimensions : catalog ? catalog.filter((item) => item.scan && session.capabilities.dimensions.includes(item.id)).map((item) => item.id) : session.capabilities.dimensions.filter((id) => SEMANTIC_DIMENSIONS[id].scan);
        for (const dimension of dimensions) layers.push({ by: [dimension as AnalysisDimension] });
      }
      const outcomes: Outcome[] = [];
      for (const layer of layers) {
        const outcome = await call({ ...base(source!), method: "scan", by: layer.by, ...(layer.breakdown ? { breakdown: layer.breakdown } : {}) }); outcomes.push(outcome);
        if (outcome.result?.status === "completed") collect(outcome.result, { metrics: source!.metrics, reference: Boolean(source!.reference), sampleRows: true });
      }
      settle(outcomes);
    } else if (node.op === "robust") {
      if (!source) { output.status = "unsupported"; output.message = "robust 只能检查 measure 或 contrast 节点"; continue; }
      const from = source; const metric = from.metrics[0]; const contrast = Boolean(from.reference); const robust: NonNullable<NodeResult["robust"]> = []; output.robust = robust;
      // 原值：所指节点的总体差额（contrast）或总体值（measure）
      const parentRow = resultOf(parentId!)!.rows.find((row) => row.metric === metric && row.role === (contrast ? "delta" : "value") && !Object.keys(row.key).length);
      const factValue = (id: string | undefined) => id === undefined ? null : registry.view().facts.find((fact) => fact.id === id)?.value ?? null;
      const record = (check: string, key: Record<string, string>, before: number | null, after: AnalysisFact | undefined, label: string, directional = true) => {
        if (after) output.rows.push({ key, metric, factId: after.id, role: "check" });
        const value = after?.value ?? null; const judged = directional ? direction(before, value) : { kept: null, note: "水平值没有方向，只作数值参考" };
        robust.push({ check, metric, kept: judged.kept, detail: `${label}：原值 ${before ?? "缺失"}，核对后 ${value ?? "缺失"}${judged.note ? `；${judged.note}` : ""}` });
      };
      // 总体（无分组）事实：有参照时取差额，否则取所问指标本身
      const total = (result: AnalysisOperationResult, frameIndex: number, metricId: string) => result.facts.find((fact) => fact.metricId === metricId && !fact.objectIds.length && fact.frameId === result.frames[frameIndex]?.id);
      const outcomes: Outcome[] = [];
      // 原值取所指节点的总体行；分组 measure 没有总体行时按原范围补读一次总体
      let original: Promise<number | null> | undefined;
      const originalValue = () => original ??= (async () => {
        if (parentRow) return factValue(parentRow.factId);
        const whole = await call({ ...base(from), method: contrast ? "compare" : "aggregate" }); outcomes.push(whole);
        return whole.result?.status === "completed" ? total(whole.result, 0, contrast ? `${metric}.delta` : metric)?.value ?? null : null;
      })();
      for (const check of node.checks) {
        if (check === "alternative_window") {
          // 替代窗口顶替目标期：contrast 用替代期对原参照重算差额比方向；measure 只读替代期水平值
          const period = node.alternative!; const alt: Source = { ...from, scope: { ...from.scope, period } };
          const outcome = await call({ ...base(alt), method: contrast ? "compare" : "aggregate", ...(contrast && from.by ? { by: from.by as AnalysisDimension[] } : {}) }); outcomes.push(outcome);
          const result = outcome.result?.status === "completed" ? outcome.result : undefined;
          if (!result) { robust.push({ check, metric, kept: null, detail: outcome.message ?? "未执行" }); continue; }
          record(check, { check }, await originalValue(), total(result, 0, contrast ? `${metric}.delta` : metric), `替代窗口 ${period.start}–${period.end}`, contrast);
        } else if (check === "largest_store" || check === "largest_order") {
          const outcome = await call({ ...base(from), method: "robustness", check }); outcomes.push(outcome);
          const result = outcome.result?.status === "completed" ? outcome.result : undefined;
          if (!result) { robust.push({ check, metric, kept: null, detail: outcome.message ?? "未执行" }); continue; }
          const metricId = contrast ? `${metric}.delta` : metric;
          record(check, { check }, total(result, 0, metricId)?.value ?? null, total(result, contrast ? 2 : 1, metricId), check === "largest_store" ? "剔除最大门店" : "剔除最大订单");
        } else {
          const split = halves(from.scope.period); const splitReference = from.reference ? halves(from.reference.period) : undefined;
          if (!split || from.reference && !splitReference) { robust.push({ check, metric, kept: null, detail: "范围只有一天，无法拆成前后两半" }); continue; }
          const before = await originalValue();
          const keptHalves: Array<boolean | null> = []; const details: string[] = [];
          for (const [position, label] of [[0, "前半"], [1, "后半"]] as const) {
            const half: Source = { ...from, scope: { ...from.scope, period: split[position] }, ...(from.reference ? { reference: { ...from.reference, period: splitReference![position] } } : {}) };
            const outcome = await call({ ...base(half), method: contrast ? "compare" : "aggregate" }); outcomes.push(outcome);
            const after = outcome.result?.status === "completed" ? total(outcome.result, 0, contrast ? `${metric}.delta` : metric) : undefined;
            if (after) output.rows.push({ key: { check, half: label }, metric, factId: after.id, role: "check" });
            const value = after?.value ?? null; keptHalves.push(direction(before, value).kept);
            details.push(`${label} ${value ?? outcome.message ?? "缺失"}`);
          }
          const kept = keptHalves.includes(false) ? false : keptHalves.includes(null) ? null : true;
          robust.push({ check, metric, kept, detail: `前后两半：原值 ${before ?? "缺失"}，${details.join("，")}${before === 0 ? "；原值为零，无方向可比" : ""}` });
        }
      }
      if (!robust.some((item) => item.kept !== null) && !outcomes.some((item) => item.result?.status === "completed")) output.status = "unsupported";
      messages.push(...outcomes.map((item) => item.message).filter(Boolean) as string[]);
    } else if (node.op === "scenario") {
      // 基线：所指 measure 的总体 amount；没有时按同范围补读一次总体实收。
      const isBaseline = (fact: AnalysisFact) => fact.metricId === "amount" && !fact.objectIds.length && !fact.derivation && !fact.assumption;
      const parentOps = new Set(resultOf(parentId!)!.operationIds);
      let baseline = registry.view().facts.find((fact) => parentOps.has(fact.operationId) && isBaseline(fact));
      if (!baseline) {
        const outcome = await call({ method: "aggregate", scope: scopeOf(source!.scope), metrics: ["amount"] });
        baseline = outcome.result?.status === "completed" ? outcome.result.facts.find(isBaseline) : undefined;
        if (!baseline) { output.status = "unsupported"; messages.push(outcome.message ?? "没有可用的总体实收基线"); }
      }
      if (baseline) {
        try {
          const result = await simulatePlanScenario({ id: node.id, adjustment: node.adjustment, netVolumeChanges: node.netVolumeChanges, reason: node.reason }, baseline.id, registry.view(), session, signal);
          await registry.ingestAsync(result, signal); output.operationIds.push(result.operationId);
          // 情景结果行：假设参数不进行；按净成交量变化逐项的结果以变化值为键
          for (const fact of result.facts) if (!fact.metricId.startsWith("assumption.")) output.rows.push({ key: fact.scenario?.kind === "revenue" ? { netVolumeChange: fact.scenario.netChange } : {}, metric: fact.metricId, factId: fact.id, role: "value" });
          if (result.status !== "completed") { output.status = "unsupported"; messages.push(result.limitations.at(-1) ?? "情景未完成"); }
        } catch (error) { if (!isInvalid(error)) throw error; output.status = "unsupported"; messages.push((error as Error).message); }
      }
    }
    if (messages.length) output.message = [...new Set(messages)].join("；");
  }
  throwIfTurnCancelled(signal);
  return { results, evidence: registry.view() };
}
