import type { AnalysisFact, AnalysisMethodReport, AnalysisOperationResult } from "../analysis-v2-types.ts";
import { analysisArgumentsInvalid } from "../analysis-v2-operations.ts";
import { formatValue } from "../plan/bind.ts";
import { qaPresentationFacts } from "./observations.ts";

type ResultFact = Pick<AnalysisFact, "id" | "frameId" | "metricId" | "label" | "value" | "unit"> & { formatted: string; assumption?: AnalysisFact["assumption"]; comparisonRole?: AnalysisFact["comparisonRole"] };
type ResultCheck = AnalysisMethodReport["checks"][number] & { occurrences: number; methodId?: string };
type ResultGroup = { key: Record<string, string>; labels: Record<string, string>; facts: ResultFact[]; kind?: "supporting" | "method_check"; checks?: ResultCheck[] };
type ResultMethod = Pick<AnalysisMethodReport, "method" | "status" | "controls" | "sampleRows" | "groupCount"> & { checks: ResultCheck[]; checkCount: number; checksInResult: boolean };
export type QaResultOrder = { metric: string; direction?: "asc" | "desc"; frameId?: string };
type ResultView = { groups: ResultGroup[]; orderBy?: QaResultOrder };
export type QaResult = { resultId: string; result: AnalysisOperationResult; groups: ResultGroup[]; readFactIds: Set<string>; factIndex: Map<string, AnalysisFact>; methods: ResultMethod[]; views: Map<string, ResultView> };

export function createQaResult(resultId: string, result: AnalysisOperationResult): QaResult {
  const objects = new Map(result.objects.map((object) => [object.id, object]));
  const factIndex = new Map(result.facts.map((fact) => [fact.id, fact]));
  const cases = new Map<string, { key: string; label: string }>();
  for (const fact of result.facts) if (fact.scenario?.kind === "revenue") {
    const rate = factIndex.get(fact.scenario.rateFactId);
    const value = { key: fact.scenario.netChange, label: rate ? formatValue(rate, false) : fact.scenario.netChange };
    cases.set(fact.id, value); cases.set(fact.scenario.rateFactId, value);
  }
  const groups = new Map<string, ResultGroup>();
  const primary = new Set(qaPresentationFacts(result).map((fact) => fact.id));
  for (const fact of result.facts) {
    const key: Record<string, string> = {}, labels: Record<string, string> = {};
    for (const object of fact.objectIds.map((id) => objects.get(id)).filter((v) => v !== undefined).sort((a, b) => a.dimension.localeCompare(b.dimension))) {
      key[object.dimension] = object.value; labels[object.dimension] = object.label;
    }
    const scenario = cases.get(fact.id);
    if (scenario) { key.netVolumeChange = scenario.key; labels.netVolumeChange = scenario.label; }
    // 控制层与标准化结果保留实际身份；同对象的目标、参照及派生差额放在一起。
    // comparisonKey是代码生成的真实比较身份，同一对照的目标、参照与差额不可分开。
    const signature = fact.comparisonKey ? `comparison:${fact.comparisonKey}` : JSON.stringify([key, fact.comparisonRole ?? "", fact.comparisonValues ?? {}]);
    let group = groups.get(signature);
    if (!group) { group = { key, labels, facts: [] }; groups.set(signature, group); }
    group.facts.push({ id: fact.id, frameId: fact.frameId, metricId: fact.metricId, label: fact.label, value: fact.value, unit: fact.unit, formatted: formatValue(fact, /(?:delta|change|contribution)/.test(fact.metricId)), ...(fact.assumption ? { assumption: fact.assumption } : {}), ...(fact.comparisonRole ? { comparisonRole: fact.comparisonRole } : {}) });
  }
  const units = [...groups].sort(([a, x], [b, y]) => Number(Boolean(Object.keys(x.key).length)) - Number(Boolean(Object.keys(y.key).length)) || (a < b ? -1 : a > b ? 1 : 0)).flatMap(([signature, group]): ResultGroup[] => {
    if (signature.startsWith("comparison:")) return [group];
    const counts = new Map<string, number>();
    for (const fact of group.facts) if (primary.has(fact.id)) { const key = `${fact.frameId}:${fact.metricId}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    // 无对象、或只有控制层的原始中间依据不等于同一个业务总体。
    // 不能把多个实际计算的同名指标挤成一个无限大的组；各自按真实factId续读。
    // 多指标扫描可能仅重复rows等辅助事实，唯一业务指标仍属于原业务组并可排序。
    const unique = group.facts.filter((fact) => primary.has(fact.id) && counts.get(`${fact.frameId}:${fact.metricId}`) === 1);
    const uniqueIds = new Set(unique.map((fact) => fact.id));
    const repeated = group.facts.filter((fact) => !uniqueIds.has(fact.id));
    return [...(unique.length ? [{ ...group, facts: unique }] : []), ...repeated.map((fact): ResultGroup => ({ key: group.key, labels: group.labels, facts: [fact], kind: "supporting" }))];
  });
  const methods: ResultMethod[] = result.methods.map((method) => {
    const checks = new Map<string, ResultCheck>();
    for (const check of method.checks) { const key = JSON.stringify(check); const prior = checks.get(key); if (prior) prior.occurrences++; else checks.set(key, { ...check, occurrences: 1 }); }
    return { method: method.method, status: method.status, controls: method.controls, sampleRows: method.sampleRows, groupCount: method.groupCount, checks: [...checks.values()], checkCount: method.checks.length, checksInResult: false };
  });
  if (JSON.stringify(methods).length > 4000) for (const [index, method] of methods.entries()) {
    for (const check of method.checks) units.push({ key: {}, labels: {}, kind: "method_check", facts: [], checks: [{ ...check, methodId: result.methods[index].id }] });
    method.checks = []; method.checksInResult = true;
  }
  return { resultId, result, groups: units, readFactIds: new Set(), factIndex, methods, views: new Map([["v0", { groups: units }]]) };
}

function orderedView(stored: QaResult, order: QaResultOrder): string {
  if (!order || typeof order.metric !== "string" || !order.metric || Object.keys(order).some((key) => !["metric", "direction", "frameId"].includes(key)) || order.direction !== undefined && !["asc", "desc"].includes(order.direction) || order.frameId !== undefined && !stored.result.frames.some((frame) => frame.id === order.frameId)) throw analysisArgumentsInvalid("结果排序指标、方向或范围不正确");
  const normalized = { metric: order.metric, direction: order.direction ?? "desc", ...(order.frameId ? { frameId: order.frameId } : {}) } as const;
  for (const [id, view] of stored.views) if (JSON.stringify(view.orderBy) === JSON.stringify(normalized)) return id;
  let matched = false;
  const groups = stored.groups.map((group, index) => {
    const facts = group.kind ? [] : group.facts.filter((fact) => fact.metricId === order.metric && (!order.frameId || fact.frameId === order.frameId));
    if (facts.length > 1) throw analysisArgumentsInvalid("排序指标有多个目标/参照或控制范围，请用 orderBy.frameId 明确选择");
    if (facts.length) matched = true;
    return { group, index, eligible: facts.length > 0, score: facts[0]?.value };
  });
  if (!matched) throw analysisArgumentsInvalid("结果没有可用于排序的真实指标，请选择实际metricId");
  groups.sort((a, b) => {
    const x = a.score, y = b.score;
    if (typeof x === "number" && typeof y === "number") return (normalized.direction === "desc" ? y - x : x - y) || a.index - b.index;
    if (typeof x === "number") return -1; if (typeof y === "number") return 1;
    return Number(b.eligible) - Number(a.eligible) || a.index - b.index;
  });
  const id = `v${stored.views.size}`; stored.views.set(id, { groups: groups.map((item) => item.group), orderBy: normalized }); return id;
}

export function pageQaResult(stored: QaResult, input: { cursor?: string; pageSize?: number; orderBy?: QaResultOrder } = {}) {
  const size = input.pageSize ?? 100;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw analysisArgumentsInvalid("每页组数必须为1至100的整数");
  const prefix = `qa:${stored.resultId}:`;
  let offset = 0, viewId = "v0";
  if (input.cursor !== undefined) {
    if (!input.cursor.startsWith(prefix)) throw analysisArgumentsInvalid("结果游标与当前结果不匹配");
    const tail = input.cursor.slice(prefix.length), parsed = /^(?:(v\d+):)?(\d+)$/.exec(tail);
    if (!parsed) throw analysisArgumentsInvalid("结果游标格式不正确");
    viewId = parsed[1] ?? "v0"; offset = Number(parsed[2]);
    if (!stored.views.has(viewId) || !Number.isSafeInteger(offset) || offset < 0 || offset >= stored.groups.length) throw analysisArgumentsInvalid("结果游标超出可读取范围");
  }
  if (input.orderBy) { const selected = orderedView(stored, input.orderBy); if (input.cursor && selected !== viewId) throw analysisArgumentsInvalid("结果游标与指定排序不匹配"); viewId = selected; }
  const view = stored.views.get(viewId)!;
  const result = stored.result;
  const envelope = (groups: ResultGroup[]) => {
    const frameIds = new Set(groups.flatMap((g) => g.facts.map((fact) => fact.frameId)));
    const next = offset + groups.length;
    return {
      resultId: stored.resultId, operationId: result.operationId, method: result.method, status: result.status,
      purpose: result.purpose, cached: result.cached === true,
      frames: result.frames.filter((frame) => frameIds.has(frame.id)),
      definitions: [...new Set(groups.flatMap((g) => g.facts.map((fact) => stored.factIndex.get(fact.id)!.definition)))],
      methods: stored.methods,
      limitations: result.limitations, groups, totalGroups: stored.groups.length,
      groupCountDefinition: "totalGroups是含总体、比较、控制依据及方法检查的返回单元数；实际业务分组数见methods.groupCount，不能以返回单元数回答门店或活动数量。",
      orderBy: view.orderBy ?? null,
      nextCursor: next < view.groups.length ? `${prefix}${viewId}:${next}` : null,
    };
  };
  const groups: ResultGroup[] = [];
  for (const group of view.groups.slice(offset, offset + size)) {
    if (JSON.stringify(envelope([...groups, group])).length > 16000) {
      if (!groups.length) throw analysisArgumentsInvalid("单组结果超过安全返回长度，未截断或发布不完整结果；请减少单次指标或控制层后重读");
      break;
    }
    groups.push(group);
  }
  const page = envelope(groups);
  if (JSON.stringify(page).length > 16000) throw analysisArgumentsInvalid("结果元数据超过安全返回长度，未发布不完整结果");
  for (const group of groups) for (const fact of group.facts) stored.readFactIds.add(fact.id);
  return page;
}
