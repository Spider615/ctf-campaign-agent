import { normalizeAnalysisScope } from "../analysis-v2-operations.ts";
import type { AnalysisCapabilities, AnalysisConstraints, AnalysisDimension, AnalysisScope } from "../analysis-v2-types.ts";
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../semantic/model.ts";
import type { AnalysisPlan, PlanIssue, PlanNode, PlanScope, PlanValidation } from "./types.ts";

const OPS = ["measure", "contrast", "decompose", "drill", "scan", "robust", "scenario"] as const;
const CHECKS = ["largest_store", "largest_order", "halves", "alternative_window"] as const;
export const LIMITS = { nodes: 12, metrics: 6, by: 2, path: 3, dimensions: 30, top: 10, controls: 4, netVolumeChanges: 6 } as const;
// 需要引用前序节点作为数据来源的算子
const NEEDS_SOURCE: readonly string[] = ["decompose", "drill", "scan", "robust", "scenario"];
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 120) ? value as string[] : undefined;
const label = (dimension: string) => SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].label;

// 结构解析：只检查形状，不查能力目录；问题全部收集后一次返回。
// maxNodes：这份计划允许的节点总数；补充计划把已执行节点和新节点合在一起校验，上限要算上已有节点。
// 超出上限的节点逐个报告，不静默截掉。
export function parsePlan(raw: unknown, maxNodes: number = LIMITS.nodes): { plan?: AnalysisPlan; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  if (!isObject(raw) || typeof raw.question !== "string" || !Array.isArray(raw.nodes)) return { issues: [{ message: "计划需要 question 和 nodes" }] };
  if (raw.nodes.length > maxNodes) {
    issues.push({ message: `计划最多 ${maxNodes} 个节点` });
    for (const item of raw.nodes.slice(maxNodes)) if (isObject(item) && typeof item.id === "string") issues.push({ node: item.id, message: `超出节点上限（最多 ${maxNodes} 个），未执行` });
  }
  const seen = new Set<string>(); const nodes: PlanNode[] = [];
  for (const item of raw.nodes.slice(0, maxNodes)) {
    if (!isObject(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id)) { issues.push({ message: "节点 id 只能是 1–40 位字母数字" }); continue; }
    // 重复 id 与未知算子各自报告，同一项两个问题都在时一并给出
    const duplicate = seen.has(item.id); seen.add(item.id);
    const known = OPS.includes(item.op as typeof OPS[number]);
    if (duplicate) issues.push({ node: item.id, message: "节点 id 重复" });
    if (!known) issues.push({ node: item.id, message: `不支持的算子 ${String(item.op)}，可用：${OPS.join("、")}` });
    if (duplicate || !known) continue;
    nodes.push(item as PlanNode);
  }
  return { plan: { question: raw.question, nodes }, issues };
}

// 筛选值的就近建议：先找包含关系（「七夕」→「七夕节」、「一般足金」→「一般足金类」），再找相同字最多的。
function nearest(value: string, values: readonly string[]): string[] {
  const contains = values.filter((item) => item.includes(value) || value.includes(item));
  if (contains.length) return contains.slice(0, 3);
  const score = (item: string) => [...new Set(value)].filter((char) => item.includes(char)).length;
  return [...values].map((item) => ({ item, score: score(item) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.item);
}
// 有实际取值清单的维度，筛选值必须在清单里；写错时给出最接近的正确值。
function checkFilterValues(node: string, field: string, scope: AnalysisScope, capabilities: AnalysisCapabilities, issues: PlanIssue[]) {
  for (const [key, values] of Object.entries(scope.filters)) {
    const dimension = capabilities.dimensionCatalog?.find((item) => item.filter === key);
    if (!dimension?.values) continue;
    for (const value of values ?? []) if (!dimension.values.includes(value)) {
      const hint = nearest(value, dimension.values);
      issues.push({ node, field, message: `${dimension.label}没有「${value}」这个取值${hint.length ? `，可能是：${hint.map((item) => `「${item}」`).join("、")}` : `，可选：${dimension.values.slice(0, 12).map((item) => `「${item}」`).join("、")}`}` });
    }
  }
}
function checkScope(node: string, field: string, scope: PlanScope, capabilities: AnalysisCapabilities, constraints: AnalysisConstraints, issues: PlanIssue[]): AnalysisScope | undefined {
  if (!isObject(scope)) { issues.push({ node, field, message: "范围缺失" }); return undefined; }
  let normalized: AnalysisScope;
  try { normalized = normalizeAnalysisScope(scope, capabilities, constraints); }
  catch (error) { issues.push({ node, field, message: error instanceof Error ? error.message : "范围不正确" }); return undefined; }
  const before = issues.length; checkFilterValues(node, field, normalized, capabilities, issues);
  return issues.length === before ? normalized : undefined;
}
// 控制维度：每个范围都固定为单值，或出现在 by / 对齐控制里，才算控制住。
function checkMetrics(node: string, metrics: unknown, scopes: AnalysisScope[], controls: string[], capabilities: AnalysisCapabilities, issues: PlanIssue[]) {
  const list = strings(metrics, LIMITS.metrics);
  if (!list?.length) { issues.push({ node, field: "metrics", message: `metrics 需要 1–${LIMITS.metrics} 个语义层指标` }); return; }
  const available = new Map(capabilities.metrics.map((metric) => [metric.id, metric]));
  for (const metric of list) {
    const definition = available.get(metric);
    if (!definition) { issues.push({ node, field: "metrics", message: `指标 ${metric} 不在能力目录` }); continue; }
    for (const scope of scopes) if (!definition.allowedPopulations.includes(scope.population)) issues.push({ node, field: "metrics", message: `${definition.label}只适用于 ${definition.allowedPopulations.join("、")} 口径` });
    for (const dimension of definition.requiredControls) {
      const key = SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].filter;
      const fixed = scopes.every((scope) => (scope.filters as Record<string, string[] | undefined>)[key]?.length === 1);
      if (!fixed && !controls.includes(dimension)) issues.push({ node, field: "metrics", message: `${definition.label}需要固定或分组控制${label(dimension)}` });
    }
  }
}
function checkDimensions(node: string, field: string, value: unknown, max: number, capabilities: AnalysisCapabilities, issues: PlanIssue[]): AnalysisDimension[] {
  if (value === undefined) return [];
  const list = strings(value, max);
  if (!list) { issues.push({ node, field, message: `${field} 最多 ${max} 个维度` }); return []; }
  const unknown = list.filter((dimension) => !capabilities.dimensions.includes(dimension as AnalysisDimension));
  for (const dimension of unknown) issues.push({ node, field, message: `维度 ${dimension} 不在能力目录` });
  return list.filter((dimension) => !unknown.includes(dimension)) as AnalysisDimension[];
}

// 静态校验：按节点顺序检查；依赖的节点被丢弃时，依赖方也丢弃。
export function validatePlan(plan: AnalysisPlan, capabilities: AnalysisCapabilities, constraints: AnalysisConstraints): PlanValidation {
  const issues: PlanIssue[] = []; const valid: PlanNode[] = []; const dropped: PlanValidation["dropped"] = [];
  const kept = new Map<string, PlanNode>(); const order = new Map(plan.nodes.map((node, index) => [node.id, index]));
  for (const [index, node] of plan.nodes.entries()) {
    const own: PlanIssue[] = [];
    let parent: string | undefined;
    if (NEEDS_SOURCE.includes(node.op)) {
      const of = (node as { of?: unknown }).of;
      if (typeof of !== "string" || !of) own.push({ node: node.id, field: "of", message: "缺少 of，需要引用前面的节点" });
      else {
        parent = of;
        if (!order.has(of)) own.push({ node: node.id, field: "of", message: `引用的节点 ${of} 不存在` });
        else if (order.get(of)! >= index) own.push({ node: node.id, field: "of", message: `只能引用前面已声明的节点，${of} 在其后或就是自身` });
        else if (!kept.has(of)) own.push({ node: node.id, field: "of", message: `引用的节点 ${of} 未通过校验` });
      }
    }
    const source = parent ? kept.get(parent) : undefined;
    if (node.op === "measure") {
      const scope = checkScope(node.id, "scope", node.scope, capabilities, constraints, own);
      const by = checkDimensions(node.id, "by", node.by, LIMITS.by, capabilities, own);
      if (scope) checkMetrics(node.id, node.metrics, [scope], by, capabilities, own);
    } else if (node.op === "contrast") {
      const target = checkScope(node.id, "target", node.target, capabilities, constraints, own); const reference = checkScope(node.id, "reference", node.reference, capabilities, constraints, own);
      const by = checkDimensions(node.id, "by", node.by, LIMITS.by, capabilities, own); const controls = checkDimensions(node.id, "align.controls", node.align?.controls, LIMITS.controls, capabilities, own);
      if (target && reference) { if (target.population !== reference.population) own.push({ node: node.id, message: "目标与参照口径必须相同" }); checkMetrics(node.id, node.metrics, [target, reference], [...by, ...controls], capabilities, own); }
    } else if (node.op === "decompose") {
      if (source && source.op !== "contrast") own.push({ node: node.id, field: "of", message: "decompose 只能拆解 contrast 节点" });
      if (source?.op === "contrast" && !source.metrics.includes("amount") && !source.metrics.includes("amount_per_day")) own.push({ node: node.id, field: "of", message: "decompose 需要被拆解的 contrast 含实收或日均实收" });
    } else if (node.op === "drill") {
      if (source && source.op !== "contrast" && source.op !== "measure") own.push({ node: node.id, field: "of", message: "drill 只能下钻 measure 或 contrast" });
      const path = checkDimensions(node.id, "path", node.path, LIMITS.path, capabilities, own);
      if (!path.length) own.push({ node: node.id, field: "path", message: "path 需要 1–3 个维度" });
      for (let i = 1; i < path.length; i++) {
        // 沿 parent 链向上找，path[i-1] 必须是 path[i] 的某一级上级
        let ancestor = SEMANTIC_DIMENSIONS[path[i] as SemanticDimensionId].parent;
        while (ancestor && ancestor !== path[i - 1]) ancestor = SEMANTIC_DIMENSIONS[ancestor].parent;
        if (ancestor !== path[i - 1]) own.push({ node: node.id, field: "path", message: `${label(path[i])}不是${label(path[i - 1])}的下级` });
      }
    } else if (node.op === "scan") {
      if (source && source.op !== "contrast" && source.op !== "measure") own.push({ node: node.id, field: "of", message: "scan 只能展开 measure 或 contrast" });
      const dimensions = checkDimensions(node.id, "dimensions", node.dimensions, LIMITS.dimensions, capabilities, own);
      for (const dimension of dimensions) if (!SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].scan) own.push({ node: node.id, field: "dimensions", message: `${label(dimension)}不参与扫描` });
      if (node.top !== undefined && (!Number.isInteger(node.top) || node.top < 1 || node.top > LIMITS.top)) own.push({ node: node.id, field: "top", message: `top 取 1–${LIMITS.top}` });
    } else if (node.op === "robust") {
      if (source && source.op !== "measure" && source.op !== "contrast") own.push({ node: node.id, field: "of", message: "robust 只能检查 measure 或 contrast 节点" });
      if (!Array.isArray(node.checks) || !node.checks.length || node.checks.some((check) => !CHECKS.includes(check))) own.push({ node: node.id, field: "checks", message: `checks 取 ${CHECKS.join("、")}` });
      if (Array.isArray(node.checks) && node.checks.includes("alternative_window") && !node.alternative) own.push({ node: node.id, field: "alternative", message: "alternative_window 需要提供替代窗口" });
      if (Array.isArray(node.checks) && node.checks.includes("largest_order") && source && (source.op === "measure" ? source.scope.population : source.op === "contrast" ? source.target.population : "sales") !== "sales") own.push({ node: node.id, field: "checks", message: "剔除最大订单只适用于销售口径" });
    } else if (node.op === "scenario") {
      if (source && source.op !== "measure") own.push({ node: node.id, field: "of", message: "scenario 只能作用于 measure 节点" });
      if (!capabilities.scenarios?.includes(node.adjustment?.kind)) own.push({ node: node.id, field: "adjustment", message: "当前数据不支持该情景规则" });
      if (!Array.isArray(node.netVolumeChanges) || !node.netVolumeChanges.length || node.netVolumeChanges.length > LIMITS.netVolumeChanges) own.push({ node: node.id, field: "netVolumeChanges", message: `需要 1–${LIMITS.netVolumeChanges} 个净成交量变化假设` });
      if (typeof node.reason !== "string" || !node.reason.trim()) own.push({ node: node.id, field: "reason", message: "情景需要写明假设理由" });
    }
    if (own.length) { issues.push(...own); dropped.push({ node, issues: own }); } else { valid.push(node); kept.set(node.id, node); }
  }
  return { valid, dropped, issues };
}
