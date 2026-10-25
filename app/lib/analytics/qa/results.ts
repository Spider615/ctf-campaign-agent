import type { AnalysisFact, AnalysisFrame, AnalysisMethodReport, AnalysisOperationRequest, AnalysisOperationResult, FactExpression } from "../analysis-v2-types.ts";
import { SEMANTIC_DIMENSIONS } from "../semantic/model.ts";
import { analysisArgumentsInvalid } from "../analysis-v2-operations.ts";
import { formatValue } from "../plan/bind.ts";
import { qaPresentationFacts } from "./observations.ts";

type ResultFact = Pick<AnalysisFact, "id" | "frameId" | "metricId" | "label" | "value" | "unit" | "definition" | "comparisonRole" | "comparisonControls" | "comparisonValues"> & { formatted: string; readout: string; objectContext: string; comparisonContext: string; evidenceKind: "observation" | "calculation" | "assumption"; calculation?: string; limitations?: string[]; assumption?: AnalysisFact["assumption"] };
type ResultCheck = AnalysisMethodReport["checks"][number] & { occurrences: number; methodId?: string };
type ResultGroup = { key: Record<string, string>; labels: Record<string, string>; facts: ResultFact[]; kind?: "supporting" | "method_check"; checks?: ResultCheck[] };
type ResultMethod = Pick<AnalysisMethodReport, "method" | "status" | "controls" | "sampleRows" | "groupCount"> & { checks: ResultCheck[]; checkCount: number; checksInResult: boolean };
export type QaResultOrder = { metric: string; direction?: "asc" | "desc"; frameId?: string };
type ResultView = { groups: ResultGroup[]; orderBy?: QaResultOrder };
type QueryGrouping = Pick<AnalysisOperationRequest, "by" | "controls" | "breakdown">;
export type QaResult = { resultId: string; result: AnalysisOperationResult; queryGrouping?: QueryGrouping; groups: ResultGroup[]; readFactIds: Set<string>; presentedFactIds: Set<string>; factIndex: Map<string, AnalysisFact>; methods: ResultMethod[]; views: Map<string, ResultView> };

function scopeReadout(frame: AnalysisFrame): string {
  const population = { sales: "销售", net: "净销售", returns: "退货", recovery: "回收候选", zero_sales: "零元销售", unknown: "总体未知" }[frame.scope.population];
  const selections = Object.entries(frame.scope.filters).filter(([, values]) => values?.length).map(([filter, values]) => {
    const label = Object.values(SEMANTIC_DIMENSIONS).find((item) => item.filter === filter)?.label ?? filter;
    const shown = values!.slice(0, 3).map((value) => value.length > 80 ? `${value.slice(0, 80)}…` : value).join("、");
    return `${label}=${shown}${values!.length > 3 ? `等${values!.length}个入选值（完整名单见frame）` : ""}`;
  });
  return [population, `${frame.scope.period.start}至${frame.scope.period.end}`, ...selections].join("；");
}

// 只注释工具已经返回的事实，不重算正文，也不把未翻到的计算依据偷带到本页。
function calculationReadout(fact: AnalysisFact, stored: QaResult, visible: Set<string>): string | undefined {
  if (!fact.derivation) return;
  let remaining = 12;
  const render = (node: FactExpression): string | undefined => {
    if (--remaining < 0) return;
    if ("constant" in node) return String(node.constant);
    if ("factId" in node) {
      const parent = stored.factIndex.get(node.factId);
      if (!parent || !visible.has(parent.id)) return;
      const frame = parent.frameId === fact.frameId ? undefined : stored.result.frames.find((item) => item.id === parent.frameId);
      return `${parent.value === null ? "未提供" : String(parent.value)} ${parent.unit}${frame ? `［${scopeReadout(frame)}］` : ""}`;
    }
    const args = node.args.map(render);
    if (args.some((arg) => arg === undefined)) return;
    return `(${args.join(` ${{ add: "+", subtract: "−", multiply: "×", divide: "÷" }[node.op]} `)})`;
  };
  const text = render(fact.derivation);
  return text && text.length <= 1800 ? text : undefined;
}

export function createQaResult(resultId: string, result: AnalysisOperationResult, request?: QueryGrouping): QaResult {
  const objects = new Map(result.objects.map((object) => [object.id, object]));
  const factIndex = new Map(result.facts.map((fact) => [fact.id, fact]));
  const scopes = new Map(result.frames.map((frame) => [frame.id, scopeReadout(frame)]));
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
    const factObjects = fact.objectIds.map((id) => objects.get(id)).filter((v) => v !== undefined).sort((a, b) => a.dimension.localeCompare(b.dimension));
    for (const object of factObjects) {
      key[object.dimension] = object.value; labels[object.dimension] = object.label;
    }
    const objectContext = factObjects.length ? factObjects.slice(0, 3).map((object) => `${SEMANTIC_DIMENSIONS[object.dimension].label}=${object.label.length > 80 ? `${object.label.slice(0, 80)}…` : object.label}`).join("；") + (factObjects.length > 3 ? `；其余对象见group.key，共${factObjects.length}个标签` : "") : "无分组对象标签（范围见frame筛选）";
    const scenario = cases.get(fact.id);
    if (scenario) { key.netVolumeChange = scenario.key; labels.netVolumeChange = scenario.label; }
    // 控制层与标准化结果保留实际身份；同对象的目标、参照及派生差额放在一起。
    // comparisonKey是代码生成的真实比较身份，同一对照的目标、参照与差额不可分开。
    const signature = fact.comparisonKey ? `comparison:${fact.comparisonKey}` : JSON.stringify([key, fact.comparisonRole ?? "", fact.comparisonValues ?? {}]);
    let group = groups.get(signature);
    if (!group) { group = { key, labels, facts: [] }; groups.set(signature, group); }
    const formatted = formatValue(fact, /(?:delta|change|contribution)/.test(fact.metricId));
    const evidenceKind = fact.assumption || fact.scenario ? "assumption" : fact.derivation ? "calculation" : "observation";
    const comparisonContext = fact.comparisonRole ? { descriptive: "未调整的描述性读数", within_stratum: "层内对照，非标准化总体", standardized: "已标记标准化" }[fact.comparisonRole] : "无标准化标记";
    group.facts.push({ id: fact.id, frameId: fact.frameId, metricId: fact.metricId, label: fact.label, value: fact.value, unit: fact.unit, definition: fact.definition, formatted, evidenceKind, objectContext, comparisonContext, readout: `［${{ observation: "观察", calculation: "计算", assumption: "假设情景" }[evidenceKind]}；${scopes.get(fact.frameId) ?? "范围未知"}；${objectContext}；${comparisonContext}］${fact.label}：${formatted}`, ...(fact.limitations.length ? { limitations: [...fact.limitations] } : {}), ...(fact.assumption ? { assumption: fact.assumption } : {}), ...(fact.comparisonRole ? { comparisonRole: fact.comparisonRole } : {}), ...(fact.comparisonControls ? { comparisonControls: [...fact.comparisonControls] } : {}), ...(fact.comparisonValues ? { comparisonValues: { ...fact.comparisonValues } } : {}) });
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
  const queryGrouping = request ? { by: [...new Set(request.by ?? [])], controls: [...new Set(request.controls ?? [])], ...(request.breakdown ? { breakdown: request.breakdown } : {}) } : undefined;
  return { resultId, result, queryGrouping, groups: units, readFactIds: new Set(), presentedFactIds: new Set(), factIndex, methods, views: new Map([["v0", { groups: units }]]) };
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
  let compactReadouts = false;
  const envelope = (groups: ResultGroup[], compact = compactReadouts) => {
    const frameIds = new Set(groups.flatMap((g) => g.facts.map((fact) => fact.frameId)));
    const next = offset + groups.length;
    // 图表保留的fact未必向模型展示过数值，不能充当已读公式依据。
    const visible = new Set([...stored.presentedFactIds, ...groups.flatMap((group) => group.facts.map((fact) => fact.id))]);
    return {
      resultId: stored.resultId, operationId: result.operationId, method: result.method, status: result.status,
      purpose: result.purpose, cached: result.cached === true,
      frames: result.frames.filter((frame) => frameIds.has(frame.id)),
      definitions: compact ? [] : [...new Set(groups.flatMap((g) => g.facts.map((fact) => fact.definition)))],
      methods: stored.methods,
      limitations: result.limitations, groups: groups.map((group) => ({ ...group, facts: group.facts.map((fact) => {
        // 长名单比较不能因重复展示范围而变成不可读；完整frames、值、身份与限制仍在本页。
        if (compact) return { ...fact, readout: `frame=${fact.frameId}` };
        const calculation = calculationReadout(stored.factIndex.get(fact.id)!, stored, visible);
        return calculation ? { ...fact, calculation } : fact;
      }) })), totalGroups: stored.groups.length,
      ...(compact ? { readoutContext: "本页读数以frameId关联同页完整范围，省略重复注释；事实与筛选未删改" } : {}),
      queryGrouping: stored.queryGrouping,
      groupCountDefinition: "totalGroups含总体、比较、控制依据与方法检查；methods.groupCount是方法实际分组键的组合计数，不能自动当作其中单字段的全域去重数或实体数。queryGrouping记录请求分组，实际覆盖看方法检查；组合数等于分父组计数之和不能证明跨组无重名。",
      orderBy: view.orderBy ?? null,
      orderingMeaning: view.orderBy ? `仅按${view.orderBy.metric}的${view.orderBy.direction}排序，不代表其他属性的排名` : "未指定指标排序；返回先后不能当作其他属性最大、最优或跨度最长的依据",
      nextCursor: next < view.groups.length ? `${prefix}${viewId}:${next}` : null,
    };
  };
  const groups: ResultGroup[] = [];
  for (const group of view.groups.slice(offset, offset + size)) {
    if (JSON.stringify(envelope([...groups, group])).length > 16000) {
      if (groups.length) break;
      if (JSON.stringify(envelope([group], true)).length > 16000) throw analysisArgumentsInvalid("单组结果超过安全返回长度，未截断或发布不完整结果；请减少单次指标或控制层后重读");
      compactReadouts = true;
    }
    groups.push(group);
  }
  const page = envelope(groups);
  if (JSON.stringify(page).length > 16000) throw analysisArgumentsInvalid("结果元数据超过安全返回长度，未发布不完整结果");
  for (const group of groups) for (const fact of group.facts) { stored.readFactIds.add(fact.id); stored.presentedFactIds.add(fact.id); }
  return page;
}
