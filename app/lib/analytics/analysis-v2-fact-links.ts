import type { AnalysisFact, FactExpression } from "./analysis-v2-types.ts";

export function analysisFactParents(fact: AnalysisFact): string[] {
  const expressionParents = (expression: FactExpression): string[] => "factId" in expression ? [expression.factId] : "args" in expression ? expression.args.flatMap(expressionParents) : [];
  const scenario = fact.scenario;
  return [...new Set([...(fact.derivation ? expressionParents(fact.derivation) : []), ...(scenario ? scenario.kind === "static_loss" ? [scenario.baselineFactId, ...scenario.parameterFactIds] : [scenario.baselineFactId, scenario.lossFactId, scenario.rateFactId] : [])])];
}
