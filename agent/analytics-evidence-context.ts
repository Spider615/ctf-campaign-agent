import type { AnalysisEvidence, AnalysisFact, AnalysisMethodReport, FactExpression } from "../app/lib/analytics/analysis-v2-types.ts";
import { createHash } from "node:crypto";
import { analysisFactParents } from "../app/lib/analytics/analysis-v2-fact-links.ts";
import { analysisArgumentsInvalid } from "../app/lib/analytics/analysis-v2-operations.ts";

// 模型读取真实检查的统计摘要；完整逐组检查仍在注册表，可按方法引用分页读取。
export function summarizeAnalysisMethod(method: AnalysisMethodReport) {
  const groups = new Map<string, { name: string; status: "performed" | "unavailable"; count: number; results: Set<string> }>();
  for (const check of method.checks) {
    const key = JSON.stringify([check.name, check.status]); const group = groups.get(key) ?? { name: check.name, status: check.status, count: 0, results: new Set<string>() };
    group.count++; group.results.add(check.result); groups.set(key, group);
  }
  const checks = method.checks.length <= 16 ? method.checks : [...groups.values()].map((group) => ({ name: group.name, status: group.status, result: `共 ${group.count} 条真实记录、${group.results.size} 种结果；示例：${[...group.results].slice(0, 2).join("；")}。逐组记录可按本方法引用分页读取` }));
  return { ...method, checks, limitations: [...new Set(method.limitations)], checkCount: method.checks.length };
}

const PAGE_FACT_CHARS = 48000;
// 交接保留所有近期已送达根值关联的实际对象；不扩大到未读取的门店或整张对象表。
export function analysisObjectReferences(evidence: AnalysisEvidence, factIds: readonly string[]) {
  const selected = new Set(factIds); const objectIds = new Set<string>();
  for (const fact of evidence.facts) if (selected.has(fact.id)) fact.objectIds.forEach((id) => objectIds.add(id));
  return evidence.objects.filter((object) => objectIds.has(object.id));
}

const PAGE_FACT_COUNT = 240;
const PAGE_COMPARISON_COUNT = 12;
const PAGE_COMPARISON_CHARS = 16000;
type PageOptions = { ids?: string[]; operationId?: string; offset?: number; limit?: number; includeParents?: boolean; checkOffset?: number; checkLimit?: number; detailOffset?: number; detailLimit?: number };

export function analysisFactSummary(fact: AnalysisFact) {
  const summary = { ...fact, ...(fact.derivation ? { derivationAvailable: true } : {}) }; delete summary.derivation; return summary;
}

// 全范围结果留在注册表中；模型按目录分页读取，不能将正文或上下文塞成搜索结果全集。
export function analysisEvidencePage(evidence: AnalysisEvidence, options: PageOptions = {}) {
  const offset = options.offset ?? 0; const limit = options.limit ?? 60;
  const allIds = new Set([...evidence.facts, ...evidence.frames, ...evidence.objects, ...evidence.methods].map((item) => item.id));
  const directReferenceRequested = options.ids?.some((id) => allIds.has(id));
  for (const fact of evidence.facts) allIds.add(fact.operationId);
  for (const method of evidence.methods) allIds.add(method.operationId);
  const operationAlias = options.ids?.length === 1 && !directReferenceRequested && allIds.has(options.ids[0]) && (!options.operationId || options.operationId === options.ids[0]) ? options.ids[0] : undefined;
  const validPage = (start: number, size: number) => Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(size) && size >= 1 && size <= 150;
  if (!validPage(offset, limit) || !validPage(options.checkOffset ?? 0, options.checkLimit ?? 60) || !validPage(options.detailOffset ?? 0, options.detailLimit ?? 60) || options.ids?.some((id) => !allIds.has(id))) throw analysisArgumentsInvalid("请使用已登记引用或有效分页范围");
  const requested = new Set(options.ids); const objectIdsRequested = new Set(evidence.objects.filter((object) => requested.has(object.id)).map((object) => object.id));
  // 明确事实是定向读取目标；同时携带的对象只补身份，不能扩成对象全集挤掉目标事实。
  const hasFactIds = evidence.facts.some((fact) => requested.has(fact.id));
  const byObject = !hasFactIds && objectIdsRequested.size > 0;
  const pool = evidence.facts.filter((fact) => (!options.operationId || fact.operationId === options.operationId) && (!options.ids?.length || requested.has(fact.id) || !hasFactIds && requested.has(fact.operationId) || byObject && fact.objectIds.some((id) => objectIdsRequested.has(id))));
  const roots: AnalysisFact[] = [];
  const facts: AnalysisFact[] = []; const seen = new Set<string>(); const index = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const closure = (root: AnalysisFact) => {
    const selected: AnalysisFact[] = []; const visited = new Set<string>();
    const add = (fact: AnalysisFact) => { if (visited.has(fact.id)) return; visited.add(fact.id); selected.push(fact); if (options.includeParents !== false) for (const id of analysisFactParents(fact)) { const parent = index.get(id); if (parent) add(parent); } };
    add(root); return selected;
  };
  // 续窗摘要与极大表达式只展示已核验根值，图和全部父事实留在代码侧；父链明细可按同一根引用分页。
  const present = (fact: AnalysisFact): AnalysisFact & { derivationAvailable?: boolean } => {
    if (!fact.derivation || options.includeParents !== false && JSON.stringify(fact.derivation).length <= 12000) return fact;
    return analysisFactSummary(fact);
  };
  let characters = 0; let detailPaging: { ids: string[]; totalFacts: number; offset: number; nextOffset: number | null } | null = null;
  const append = (items: AnalysisFact[], start = 0, size = items.length) => {
    let consumed = 0;
    for (const fact of items.slice(start, start + size)) {
      if (seen.has(fact.id)) { consumed++; continue; }
      const item = present(fact); const length = JSON.stringify(item).length;
      if (facts.length && (characters + length > PAGE_FACT_CHARS || facts.length >= PAGE_FACT_COUNT)) break;
      seen.add(fact.id); facts.push(item); characters += length; consumed++;
    }
    return consumed;
  };
  if (options.detailOffset !== undefined) {
    if (!hasFactIds) throw analysisArgumentsInvalid("父链明细分页须提供真实事实引用");
    const expanded = new Map<string, AnalysisFact>(); for (const root of pool) for (const fact of closure(root)) expanded.set(fact.id, fact);
    const items = [...expanded.values()]; const count = append(items, options.detailOffset, options.detailLimit ?? 60);
    roots.push(...pool.filter((root) => seen.has(root.id))); detailPaging = { ids: options.ids!, totalFacts: items.length, offset: options.detailOffset, nextOffset: options.detailOffset + count < items.length ? options.detailOffset + count : null };
  } else for (const root of pool.slice(offset, offset + limit)) {
    const expanded = closure(root); const unseen = expanded.filter((fact) => !seen.has(fact.id));
    const size = unseen.reduce((total, fact) => total + JSON.stringify(present(fact)).length, 0);
    if (roots.length && (characters + size > PAGE_FACT_CHARS || facts.length + unseen.length > PAGE_FACT_COUNT)) break;
    roots.push(root); const count = append(expanded);
    if (count < expanded.length) { detailPaging = { ids: [root.id], totalFacts: expanded.length, offset: 0, nextOffset: count }; break; }
  }
  // 配对导航来自原图已登记的比较身份，不从两个原值自行拼出可比关系。
  const comparisonGroups = new Map<string, AnalysisFact[]>();
  const linkedKeys = new Set<string>();
  for (const root of roots) {
    if (!root.comparisonRole || root.comparisonRole === "descriptive") continue;
    const visited = new Set<string>(); const queue = [root];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const fact = queue[cursor]; if (visited.has(fact.id)) continue; visited.add(fact.id);
      if (fact.comparisonKey) { linkedKeys.add(JSON.stringify([fact.operationId, fact.comparisonKey])); continue; }
      for (const id of analysisFactParents(fact)) { const parent = index.get(id); if (parent) queue.push(parent); }
    }
  }
  if (linkedKeys.size) for (const fact of evidence.facts) if (fact.comparisonKey) {
    const key = JSON.stringify([fact.operationId, fact.comparisonKey]); if (!linkedKeys.has(key)) continue;
    const members = comparisonGroups.get(key) ?? []; members.push(fact); comparisonGroups.set(key, members);
  }
  type ComparisonLink = { operationId: string; comparisonKey: string; members: ReturnType<typeof analysisFactSummary>[] };
  const comparisonEntries: ComparisonLink[] = []; let comparisonCharacters = 0;
  for (const key of linkedKeys) {
    const members = comparisonGroups.get(key)!; const link = { operationId: members[0].operationId, comparisonKey: members[0].comparisonKey!, members: members.map(analysisFactSummary) };
    const length = JSON.stringify(link).length;
    if (comparisonEntries.length >= PAGE_COMPARISON_COUNT || comparisonCharacters + length > PAGE_COMPARISON_CHARS) continue;
    comparisonEntries.push(link); comparisonCharacters += length;
  }
  const linkedFacts = comparisonEntries.flatMap((link) => link.members);
  const methodIds = new Set(options.ids); const operationIds = new Set(facts.map((fact) => fact.operationId));
  const selectedMethods = evidence.methods.filter((method) => options.operationId === method.operationId || operationIds.has(method.operationId) || methodIds.has(method.id) || requested.has(method.operationId));
  const checkPaging: Array<{ methodId: string; totalChecks: number; offset: number; nextOffset: number | null }> = [];
  const methods = selectedMethods.map((method) => {
    const summary = summarizeAnalysisMethod(method); if (!methodIds.has(method.id)) return summary;
    const start = options.checkOffset ?? 0; const size = options.checkLimit ?? 60;
    checkPaging.push({ methodId: method.id, totalChecks: method.checks.length, offset: start, nextOffset: start + size < method.checks.length ? start + size : null });
    return { ...summary, checks: method.checks.slice(start, start + size) };
  });
  const objectIds = new Set([...(options.ids ?? []), ...facts.flatMap((fact) => fact.objectIds), ...linkedFacts.flatMap((fact) => fact.objectIds)]);
  const objects = evidence.objects.filter((object) => objectIds.has(object.id));
  const frameIds = new Set([...(options.ids ?? []), ...methods.flatMap((method) => method.frameIds), ...facts.map((fact) => fact.frameId), ...linkedFacts.map((fact) => fact.frameId), ...objects.map((object) => object.frameId)]);
  const frames = evidence.frames.filter((frame) => frameIds.has(frame.id));
  const operationFacts = new Map<string, { count: number; metrics: Set<string> }>();
  for (const fact of evidence.facts) {
    const item = operationFacts.get(fact.operationId) ?? { count: 0, metrics: new Set<string>() };
    item.count++; item.metrics.add(fact.metricId); operationFacts.set(fact.operationId, item);
  }
  const frameDimensions = new Map<string, Set<string>>();
  for (const object of evidence.objects) {
    const dimensions = frameDimensions.get(object.frameId) ?? new Set<string>();
    dimensions.add(object.dimension); frameDimensions.set(object.frameId, dimensions);
  }
  const frameIndex = new Map(evidence.frames.map((frame) => [frame.id, frame]));
  // 目录来自全量已捕获依据，不能把当前页没展示的指标或分组当作尚未计算。
  const directory = evidence.methods.map(summarizeAnalysisMethod).map((method) => ({ id: method.id, operationId: method.operationId, method: method.method, status: method.status, controls: method.controls, checks: method.checks, checkCount: method.checkCount, limitations: method.limitations, groupCount: method.groupCount,
    factCount: operationFacts.get(method.operationId)?.count ?? 0, metrics: [...(operationFacts.get(method.operationId)?.metrics ?? [])].sort(),
    dimensions: [...new Set(method.frameIds.flatMap((id) => [...(frameDimensions.get(id) ?? [])]))].sort(),
    frames: method.frameIds.flatMap((id) => { const frame = frameIndex.get(id); return frame ? [{ id, scope: frame.scope, currency: frame.currency, grain: frame.grain }] : []; }),
  }));
  return { frames, facts, objects, methods, rootFactIds: roots.map((fact) => fact.id), operationAlias, parentChainsIncluded: options.includeParents !== false && !detailPaging, detailPaging, checkPaging,
    comparisonLinks: { entries: comparisonEntries, omittedKeys: linkedKeys.size - comparisonEntries.length, note: "仅原图中实际配对的已核验端点与差额；导航未包含完整父链，省略项可按对应根引用定向读取。旧聚合原值的观察身份不变。" },
    paging: { totalFacts: pool.length, offset, limit: roots.length, nextOffset: options.detailOffset !== undefined || offset + roots.length >= pool.length ? null : offset + roots.length }, directory };
}

// 记录实际交付给模型的内容及未读游标；随机引用和快照重连本身不产生新进展。
export function createEvidenceDelivery() {
  const delivered = new Set<string>();
  const readFacts = new Set<string>();
  const pages = new Map<string, { operationId?: string; totalFacts: number; ranges: Array<[number, number]> }>();
  const recent = new Map<string, string[]>();
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const record = (page: ReturnType<typeof analysisEvidencePage>, selector: { ids?: string[]; operationId?: string; remember?: boolean } = {}) => {
    for (const fact of [...page.facts, ...page.comparisonLinks.entries.flatMap((link) => link.members)]) readFacts.add(fact.id);
    const frames = new Map(page.frames.map((frame) => [frame.id, frame])); const objects = new Map(page.objects.map((object) => [object.id, object])); const facts = new Map([...page.facts, ...page.comparisonLinks.entries.flatMap((link) => link.members)].map((fact) => [fact.id, fact]));
    const scopeOf = (id: string) => { const frame = frames.get(id); return frame ? { scope: frame.scope, currency: frame.currency, grain: frame.grain, controls: frame.controls, mode: frame.mode, provenance: frame.provenance, datasetVersion: frame.mode === "database" ? undefined : frame.datasetVersion } : undefined; };
    const objectOf = (id: string) => { const object = objects.get(id); return object ? { scope: scopeOf(object.frameId), dimension: object.dimension, value: object.value } : undefined; };
    const factOf = (fact: AnalysisFact) => {
      const calculated = fact.assumption || fact.metricId.startsWith("calculation.");
      return { scope: scopeOf(fact.frameId), metricId: calculated ? fact.assumption ? "calculation.parameter" : "calculation.result" : fact.metricId, ...(calculated ? {} : { label: fact.label, definition: fact.definition }), value: fact.value, unit: fact.unit, objects: fact.objectIds.map(objectOf), comparisonRole: fact.comparisonRole, comparisonControls: fact.comparisonControls, comparisonValues: fact.comparisonValues };
    };
    const expressionOf = (expression: FactExpression): unknown => "factId" in expression ? { fact: facts.has(expression.factId) ? factOf(facts.get(expression.factId)!) : undefined } : "args" in expression ? { op: expression.op, args: expression.args.map(expressionOf) } : expression;
    const keys = [
      ...page.facts.map((fact) => digest({ fact: factOf(fact), derivation: fact.derivation && expressionOf(fact.derivation) })),
      ...page.objects.map((object) => digest({ object: objectOf(object.id) })),
      ...page.frames.map((frame) => digest({ frame: scopeOf(frame.id) })),
      ...page.methods.map((method) => digest({ method: method.method, status: method.status, frames: method.frameIds.map(scopeOf), checks: method.checks, controls: method.controls, sampleRows: method.sampleRows, groupCount: method.groupCount })),
      ...page.comparisonLinks.entries.map((link) => digest({ comparison: link.members.map(factOf) })),
    ];
    const changed = keys.some((key) => !delivered.has(key)); keys.forEach((key) => delivered.add(key));
    // 续窗保留已读候选的真实引用；仅有游标会让新上下文重复寻找已找到的指标。
    const perOperation = new Map<string, string[]>();
    // 只登记本页真正选中的根事实；续窗再由根引用补齐父链，父链不能挤掉候选。
    if (selector.remember !== false) for (const id of page.rootFactIds) { const fact = facts.get(id)!; const ids = perOperation.get(fact.operationId) ?? []; ids.push(id); perOperation.set(fact.operationId, ids); }
    for (const [operationId, ids] of perOperation) {
      const incoming = new Set(ids); const prior = recent.get(operationId) ?? [];
      recent.delete(operationId); recent.set(operationId, [...prior.filter((id) => !incoming.has(id)), ...ids].slice(-24));
    }
    while (recent.size > 12) recent.delete(recent.keys().next().value!);
    if (!selector.ids?.length || page.operationAlias) {
      const operationId = page.operationAlias ?? selector.operationId;
      const key = operationId ?? "all"; const prior = pages.get(key) ?? { operationId, totalFacts: page.paging.totalFacts, ranges: [] };
      prior.totalFacts = page.paging.totalFacts; prior.ranges.push([page.paging.offset, Math.min(page.paging.offset + page.paging.limit, prior.totalFacts)]);
      const ranges: Array<[number, number]> = [];
      for (const range of prior.ranges.sort((a, b) => a[0] - b[0])) { const last = ranges.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else ranges.push([...range]); }
      prior.ranges = ranges; pages.set(key, prior);
    }
    return { page, changed };
  };
  return { record, hasReadFact: (id: string) => readFacts.has(id), resetPages: () => { pages.clear(); recent.clear(); readFacts.clear(); }, state: () => ({ recentFactIds: [...recent.values()].flat(), pages: [...pages.values()].map((page) => ({ ...page, firstUnreadOffset: page.ranges[0]?.[0] === 0 ? page.ranges[0][1] >= page.totalFacts ? null : page.ranges[0][1] : 0 })) }) };
}
