import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnalysisEvidence, AnalysisFact, AnalysisOperationResult, FactExpression } from "../app/lib/analytics/analysis-v2-types.ts";
import { validateAnalysisEvidence } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { analysisArgumentsInvalid } from "../app/lib/analytics/analysis-v2-operations.ts";
import { analysisFactParents } from "../app/lib/analytics/analysis-v2-fact-links.ts";

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const operand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fact"), id: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("assumption"), key }).strict(),
  z.object({ kind: z.literal("result"), key }).strict(),
  z.object({ kind: z.literal("constant"), value: z.union([z.literal(0), z.literal(1), z.literal(100)]) }).strict(),
]);
export const calculationSchema = z.object({
  needIds: z.array(z.string().min(1).max(120)).min(1).max(12), purpose: z.string().min(1).max(500), frameId: z.string().min(1).max(120),
  assumptions: z.array(z.object({ key, label: z.string().min(1).max(120), value: z.number().finite().min(-1e12).max(1e12), unit: z.string().max(80), reason: z.string().min(1).max(500) }).strict()).max(12),
  calculations: z.array(z.object({ key, label: z.string().min(1).max(120), unit: z.string().max(80), op: z.enum(["add", "subtract", "multiply", "divide"]), args: z.array(operand).min(1).max(12) }).strict()).min(1).max(20),
}).strict();

// 仅在已读取的同一经营范围内做四则运算；参数始终保留假设身份，不执行代码或数据库查询。
export function calculateAnalysis(raw: unknown, evidence: AnalysisEvidence, hasReadFact: (id: string) => boolean): AnalysisOperationResult & { progressKey: string } {
  const parsed = calculationSchema.safeParse(raw);
  if (!parsed.success) throw analysisArgumentsInvalid(`计算参数不正确；常量仅允许算术单位或百分比换算，其余数值须声明为假设参数：${parsed.error.issues[0]?.message}`);
  const input = parsed.data; const frame = evidence.frames.find((item) => item.id === input.frameId);
  if (!frame || frame.mode === "historical" || frame.grain === "unknown" || frame.scope.population === "unknown") throw analysisArgumentsInvalid("计算必须绑定本轮已核对口径的真实范围，历史参考不能直接参与");
  const operationId = `calc-${createHash("sha256").update(JSON.stringify({ ...input, purpose: undefined, needIds: undefined })).digest("hex").slice(0, 24)}`;
  const facts = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const support = new Map<string, AnalysisFact>(); const selected = new Map<string, AnalysisFact>();
  const collect = (id: string) => {
    if (support.has(id)) return;
    const fact = facts.get(id);
    if (!fact || fact.frameId !== frame.id) throw analysisArgumentsInvalid("计算引用必须属于相同已授权范围；跨范围对照请使用比较方法");
    support.set(id, fact);
    analysisFactParents(fact).forEach(collect);
  };
  for (const step of input.calculations) for (const item of step.args) if (item.kind === "fact") {
    if (!hasReadFact(item.id)) throw analysisArgumentsInvalid("计算只允许使用本轮实际读取的事实，请先定向读取引用");
    collect(item.id); selected.set(item.id, facts.get(item.id)!);
  }
  if (![...support.values()].some((fact) => !fact.assumption && !fact.derivation)) throw analysisArgumentsInvalid("计算须至少绑定实际读取的经营依据，不能只由假设生成经营数字");
  const identities = new Set([...support.values()].map((fact) => JSON.stringify([...fact.objectIds].sort())));
  if (identities.size > 1) throw analysisArgumentsInvalid("不同分组对象不能借算术替代可比检查，请先执行受控比较");
  const objectIds = [...selected.values()].find((fact) => !fact.assumption)?.objectIds ?? [];
  const objects = evidence.objects.filter((object) => objectIds.includes(object.id));
  const units = [...[...support.values()].map((fact) => fact.unit), ...input.assumptions.map((item) => item.unit), ...input.calculations.map((item) => item.unit)].map((unit) => unit.replace("每", "/"));
  const moneyUnit = /(?:[A-Z]{3}|人民币|元|美元|港元|欧元|日元|英镑)/u;
  const hasGrams = units.some((unit) => unit.includes("克"));
  const hasMoney = units.some((unit) => moneyUnit.test(unit));
  if (frame.scope.population !== "sales" && units.some((unit) => moneyUnit.test(unit) && /\/(?:克|单|件)$/u.test(unit))) throw analysisArgumentsInvalid("每克、每单或每件金额计算仅支持销售正金额，不能混入退货或回收口径");
  const knownControl = (dimension: "category" | "material") => {
    const values = frame.scope.filters[dimension === "category" ? "categories" : "materials"];
    return objects.some((object) => object.dimension === dimension && object.value.trim()) || values?.length === 1 && Boolean(values[0].trim());
  };
  if (hasGrams && hasMoney && !(knownControl("category") && knownControl("material"))) throw analysisArgumentsInvalid("每克金额计算仍须同货类同材料，不能借算术绕过控制条件");
  const scenarioLimit = "情景参数是假设；派生结果为条件测算，不是历史业绩、销量预测或已执行事实";
  const limitations = [...new Set([...frame.limitations, ...[...support.values()].flatMap((fact) => fact.limitations), ...(input.assumptions.length ? [scenarioLimit] : [])])];
  const output: AnalysisFact[] = []; const parameters = new Map<string, AnalysisFact>(); const results = new Map<string, AnalysisFact>(); const used = new Set<string>();
  for (const parameter of input.assumptions) {
    if (parameters.has(parameter.key)) throw analysisArgumentsInvalid("假设参数编号不能重复");
    const fact: AnalysisFact = { id: `${operationId}-p-${parameter.key}`, frameId: frame.id, operationId, metricId: `assumption.${parameter.key}`, label: parameter.label, value: parameter.value, unit: parameter.unit, objectIds: [...objectIds], definition: `情景假设参数：${parameter.reason}`, assumption: { reason: parameter.reason }, limitations: [scenarioLimit] };
    parameters.set(parameter.key, fact); facts.set(fact.id, fact); output.push(fact);
  }
  for (const step of input.calculations) {
    if (results.has(step.key) || ["subtract", "divide"].includes(step.op) && step.args.length !== 2) throw analysisArgumentsInvalid("计算编号须唯一，加减除法参数数量必须符合运算");
    const args: FactExpression[] = step.args.map((item) => {
      if (item.kind === "constant") return { constant: item.value };
      const fact = item.kind === "fact" ? selected.get(item.id) : item.kind === "assumption" ? parameters.get(item.key) : results.get(item.key);
      if (!fact) throw analysisArgumentsInvalid("计算只能引用真实依据、已声明假设或前面的计算结果，不能向前引用");
      if (item.kind === "assumption") used.add(item.key);
      return { factId: fact.id };
    });
    const values = args.map((expression) => "constant" in expression ? expression.constant : facts.get((expression as { factId: string }).factId)!.value);
    const value = values.some((item) => item === null) ? null : step.op === "add" ? values.reduce<number>((sum, item) => sum + item!, 0) : step.op === "subtract" ? values[0]! - values[1]! : step.op === "multiply" ? values.reduce<number>((sum, item) => sum * item!, 1) : values[1] === 0 ? null : values[0]! / values[1]!;
    if (value !== null && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw analysisArgumentsInvalid("计算结果超过有限安全数值范围，请调整单位或范围");
    const fact: AnalysisFact = { id: `${operationId}-r-${step.key}`, frameId: frame.id, operationId, metricId: `calculation.${step.key}`, label: step.label, value, unit: step.unit, objectIds: [...objectIds], definition: "基于已读取依据与明确标识假设的受控四则运算；原始口径不变", derivation: { op: step.op, args }, limitations };
    output.push(fact); results.set(step.key, fact); facts.set(fact.id, fact);
  }
  if (used.size !== parameters.size) throw analysisArgumentsInvalid("未使用的假设参数应删除，不能把无关假设混入结果");
  const method = { id: `${operationId}-method`, operationId, method: "aggregate" as const, status: "completed" as const, frameIds: [frame.id], controls: [...frame.controls], checks: [{ name: "已读依据与同范围运算", status: "performed" as const, result: "已核对真实引用、对象、单位、参数身份和完整运算依赖；无数据源读写" }], sampleRows: 0, groupCount: input.calculations.length, limitations };
  const parentOperations = new Set([...support.values()].map((fact) => fact.operationId));
  const parentMethods = evidence.methods.filter((item) => parentOperations.has(item.operationId));
  const parentFrames = new Set([...parentMethods.flatMap((item) => item.frameIds), frame.id]);
  const parentObjects = new Set([...support.values()].flatMap((fact) => fact.objectIds));
  try { validateAnalysisEvidence({ frames: evidence.frames.filter((item) => parentFrames.has(item.id)), facts: [...support.values(), ...output], objects: evidence.objects.filter((item) => parentObjects.has(item.id) || objectIds.includes(item.id)), methods: [...parentMethods, method] }); }
  catch (error) { throw analysisArgumentsInvalid(error instanceof Error ? error.message : "计算依据未通过核验"); }
  // 展示编号和措辞不算新进展；按真实基线与运算依赖散列，重复改名不能无限续窗。
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const memo = new Map<string, string>();
  const expressionKey = (expression: FactExpression): unknown => "factId" in expression ? factKey(expression.factId) : "constant" in expression ? expression : { op: expression.op, args: expression.args.map(expressionKey) };
  const factKey = (id: string): string => {
    const prior = memo.get(id); if (prior) return prior;
    const fact = facts.get(id)!;
    const value = hash({ unit: fact.unit.replace("每", "/"), ...(fact.assumption ? { assumption: fact.value } : fact.derivation ? { expression: expressionKey(fact.derivation) } : { metric: fact.metricId, definition: fact.definition, value: fact.value }) });
    memo.set(id, value); return value;
  };
  const progressKey = `calculation-${hash({ scope: frame.scope, currency: frame.currency, grain: frame.grain, mode: frame.mode, datasetVersion: frame.mode === "database" ? undefined : frame.datasetVersion, objects: objects.map((object) => ({ dimension: object.dimension, value: object.value })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), expressions: [...new Set(output.filter((fact) => fact.derivation).map((fact) => factKey(fact.id)))].sort() })}`;
  return { operationId, method: "aggregate", status: "completed", needIds: input.needIds, purpose: input.purpose, frames: [frame], objects: [], facts: output, methods: [method], limitations, progressKey };
}
