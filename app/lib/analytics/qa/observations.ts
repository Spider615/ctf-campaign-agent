import type { AnalysisFact, AnalysisOperationResult } from "../analysis-v2-types.ts";
import { analysisFactParents } from "../analysis-v2-fact-links.ts";

// 汇总中的同一读数可能同时登记为请求指标和多个比率的分子/分母。
// 仅选一个相同原值作为展示点，完整事实和父链仍保留；冲突值及其他分析方法不合并。
export function qaPresentationFacts(result: AnalysisOperationResult): AnalysisFact[] {
  if (result.method !== "aggregate") return result.facts;
  const parents = new Set(result.facts.flatMap(analysisFactParents));
  const points = new Map<string, AnalysisFact[]>();
  const keep = new Set<string>();
  for (const fact of result.facts) {
    if (fact.derivation || fact.assumption || fact.scenario) { keep.add(fact.id); continue; }
    const key = JSON.stringify([fact.operationId, fact.frameId, fact.metricId, [...fact.objectIds].sort(), fact.comparisonKey ?? "", fact.comparisonRole ?? "", [...(fact.comparisonControls ?? [])].sort(), Object.entries(fact.comparisonValues ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    const group = points.get(key) ?? []; group.push(fact); points.set(key, group);
  }
  for (const facts of points.values()) {
    const first = facts[0];
    const same = facts.every((fact) => Object.is(fact.value, first.value) && fact.unit === first.unit && fact.definition === first.definition && JSON.stringify(fact.limitations) === JSON.stringify(first.limitations));
    if (same && facts.some((fact) => parents.has(fact.id))) keep.add((facts.find((fact) => !parents.has(fact.id)) ?? first).id);
    else facts.forEach((fact) => keep.add(fact.id));
  }
  return result.facts.filter((fact) => keep.has(fact.id));
}
