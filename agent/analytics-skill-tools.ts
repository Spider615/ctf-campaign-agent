import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ANALYSIS_DIMENSIONS, ANALYSIS_METRICS, type AnalysisConstraints, type AnalysisDataSession, type AnalysisDimension, type AnalysisOperationRequest, type AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";
import type { ResolvedVisualization } from "../app/lib/analytics/visualization-types.ts";
import { createEvidenceRegistry } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { analysisArgumentsInvalid, createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { normalizeNetChanges, normalizeScenarioAdjustment } from "../app/lib/analytics/analysis-v2-scenarios.ts";
import { simulatePlanScenario } from "../app/lib/analytics/plan/scenario.ts";
import { capabilityBrief } from "../app/lib/analytics/qa/capabilities.ts";
import { createQaResult, pageQaResult, type QaResult } from "../app/lib/analytics/qa/results.ts";
import { drawQaChart, type DrawQaChartInput } from "../app/lib/analytics/qa/chart.ts";
import { ANALYTICS_QA_TOOLS, type AnalyticsQaToolName } from "../app/lib/analytics/tool-names.ts";
import { ANALYSIS_FILTER_KEYS } from "../app/lib/analytics/semantic/model.ts";
import { isTurnCancelled, throwIfTurnCancelled } from "../app/lib/cancellation.ts";

const period = z.object({ start: z.string().max(10), end: z.string().max(10) }).strict();
const filters = z.object(Object.fromEntries(ANALYSIS_FILTER_KEYS.map((key) => [key, z.array(z.string().max(120)).max(100).optional()]))).strict();
const scope = z.object({ period, population: z.enum(["sales", "net", "returns", "recovery", "zero_sales"]), filters: filters.optional() }).strict();
const metric = z.string().describe(`指标id：${ANALYSIS_METRICS.join("、")}；销售实收使用amount，净销售使用population=net与amount；实际可用指标以当前数据目录为准`);
const dimension = z.string().describe(`维度id：${ANALYSIS_DIMENSIONS.join("、")}；实际可用维度以当前数据目录为准`);
const operation = z.object({ method: z.string().describe("aggregate、compare、decompose、scan、robustness之一"), scope, metrics: z.array(metric).min(1).max(24), purpose: z.string().min(1).max(1000), by: z.array(dimension).optional(), reference: scope.optional(), controls: z.array(dimension).optional(), commonStores: z.boolean().optional(), breakdown: dimension.optional(), check: z.string().optional(), alternative: period.optional() }).strict();
const pageFields = { cursor: z.string().max(500).optional(), pageSize: z.number().int().min(1).max(100).optional() };
const analyzeFields = { action: z.enum(["query", "read_result"]), request: operation.optional(), resultId: z.string().max(160).optional(), orderBy: z.object({ metric: z.string(), direction: z.enum(["asc", "desc"]).optional(), frameId: z.string().optional() }).strict().optional(), ...pageFields };
const scenarioFields = { baselineResultId: z.string().max(160), adjustment: z.object({ kind: z.string(), amount: z.string().optional(), rate: z.string().optional(), threshold: z.string().optional() }).strict(), netVolumeChanges: z.array(z.string()).min(1).max(20), reason: z.string().min(1).max(1000) };
const chartFields = { resultId: z.string().max(160), metric: z.string().max(120), kind: z.enum(["bar", "line"]), by: z.string().max(120).optional(), top: z.number().int().min(1).max(30).optional(), title: z.string().max(1000).optional(), frameIds: z.array(z.string().max(160)).optional() };
const readonly = { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const asError = (error: unknown) => error instanceof Error ? error : new Error("分析工具执行失败");

export type AnalyticsSkillToolEvent = { id: string; tool: AnalyticsQaToolName; status: "started" | "completed" | "warning" | "failed"; input: Record<string, unknown>; output?: unknown; error?: string };
type Config = {
  ensureSession(): Promise<AnalysisDataSession>; constraints: AnalysisConstraints; signal?: AbortSignal;
  onSubmit(body: string): Promise<unknown>; onEvent?(event: AnalyticsSkillToolEvent): void;
  onFatal?(error: Error): void; cleanPublicText?(text: string): string;
};

export function createAnalyticsSkillTools(config: Config) {
  const registry = createEvidenceRegistry();
  const results = new Map<string, QaResult>(), charts = new Map<string, ResolvedVisualization>();
  const operations: Array<{ id: string; op: string; status: string; summary: string }> = [];
  const pending = new Set<Promise<unknown>>();
  const ingested = new Map<string, AnalysisOperationResult>();
  let registration = Promise.resolve(), analysis: ReturnType<typeof createAnalysisOperations> | undefined;
  let analysisPending: Promise<ReturnType<typeof createAnalysisOperations>> | undefined;
  const prefix = crypto.randomUUID().slice(0, 8); let sequence = 0;
  const clean = config.cleanPublicText ?? ((text: string) => text);
  const check = () => throwIfTurnCancelled(config.signal);
  const getAnalysis = async () => analysis ?? (analysisPending ??= config.ensureSession().then((session) => analysis = createAnalysisOperations(session, config.constraints)));
  const readFactIds = () => new Set([...results.values()].flatMap((stored) => [...stored.readFactIds]));
  const lookup = (id: string) => { const value = results.get(id); if (!value) throw analysisArgumentsInvalid("当前回合没有这个结果编号，请使用已返回的 resultId"); return value; };
  const register = async (result: AnalysisOperationResult) => {
    const task = registration.then(async () => {
      check(); const previous = ingested.get(result.operationId);
      if (previous?.facts === result.facts && previous.frames === result.frames && previous.objects === result.objects && previous.methods === result.methods) return;
      await registry.ingestAsync(result, config.signal); check(); ingested.set(result.operationId, result);
    });
    registration = task.catch(() => {}); await task;
  };
  const save = async (result: AnalysisOperationResult) => {
    await register(result); check();
    const stored = createQaResult(`r-${prefix}-${++sequence}`, result); results.set(stored.resultId, stored);
    operations.push({ id: stored.resultId, op: result.purpose.startsWith("scenario ") ? "scenario" : result.method, status: result.status, summary: clean(result.purpose) });
    return pageQaResult(stored);
  };
  const wrap = (name: AnalyticsQaToolName, work: (input: Record<string, unknown>) => Promise<unknown>) => (input: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    const task = (async () => {
      check(); config.onEvent?.({ id, tool: name, status: "started", input });
      try {
        const output = await work(input); check();
        config.onEvent?.({ id, tool: name, status: "completed", input, output });
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (raw) {
        const error = asError(raw), invalid = (error as Error & { code?: string }).code === "ANALYSIS_ARGUMENTS_INVALID" || error instanceof z.ZodError;
        const message = clean(error instanceof z.ZodError ? `工具参数不正确，请检查 ${error.issues.map((issue) => issue.path.join(".")).join("、")}` : error.message) || "工具参数或数据读取未完成";
        config.onEvent?.({ id, tool: name, status: invalid ? "warning" : "failed", input, error: message });
        if (!invalid) { if (!isTurnCancelled(error)) config.onFatal?.(error); throw error; }
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
      }
    })();
    pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task;
  };

  const handlers = {
    inspect_dataset: wrap("inspect_dataset", async (raw) => {
      const input = z.object({ dimension: z.string().optional(), ...pageFields }).strict().parse(raw);
      const session = await config.ensureSession(); check(); session.assertActive?.();
      if (input.dimension) {
        if (!session.capabilities.dimensions.includes(input.dimension as AnalysisDimension)) throw analysisArgumentsInvalid("当前数据没有这个维度");
        if (!session.dimensionValues) throw analysisArgumentsInvalid("当前数据源未提供完整维度分页能力");
        return { dimension: input.dimension, ...(await session.dimensionValues({ dimension: input.dimension as AnalysisDimension, scope: { period: config.constraints.period ?? session.capabilities.coverage, population: "sales", filters: config.constraints.filters }, cursor: input.cursor, pageSize: input.pageSize }, config.signal)) };
      }
      const lines = capabilityBrief(session.capabilities).split("\n"), start = input.cursor ? Number(input.cursor.replace(`catalog:${session.snapshotId}:`, "")) : 0;
      if (input.cursor && (!input.cursor.startsWith(`catalog:${session.snapshotId}:`) || !Number.isInteger(start) || start < 0 || start >= lines.length)) throw analysisArgumentsInvalid("能力目录游标已失效或不属于本会话");
      const page: string[] = []; let next = start;
      while (next < lines.length && JSON.stringify({ catalog: [...page, lines[next]].join("\n"), nextCursor: `catalog:${session.snapshotId}:${next + 1}` }).length < 15500) { page.push(lines[next++]); }
      if (!page.length) throw analysisArgumentsInvalid("能力目录单项超过安全返回长度");
      return { catalog: page.join("\n"), nextCursor: next < lines.length ? `catalog:${session.snapshotId}:${next}` : null };
    }),
    analyze: wrap("analyze", async (raw) => {
      const input = z.object(analyzeFields).strict().parse(raw);
      if (input.action === "read_result") {
        if (!input.resultId || input.request) throw analysisArgumentsInvalid("读取结果须提供 resultId，不能同时传入 request");
        (await config.ensureSession()).assertActive?.(); check();
        return pageQaResult(lookup(input.resultId), input);
      }
      if (!input.request || input.resultId || input.cursor) throw analysisArgumentsInvalid("新查询须提供 request，不能同时传入结果编号或游标");
      const result = await (await getAnalysis()).execute({ ...input.request, needIds: ["qa"] } as AnalysisOperationRequest, config.signal);
      await register(result); check();
      const stored = createQaResult(`r-${prefix}-${++sequence}`, result); results.set(stored.resultId, stored);
      operations.push({ id: stored.resultId, op: result.method, status: result.status, summary: clean(result.purpose) });
      return pageQaResult(stored, { pageSize: input.pageSize, orderBy: input.orderBy });
    }),
    simulate_scenario: wrap("simulate_scenario", async (raw) => {
      const input = z.object(scenarioFields).strict().parse(raw), baseline = lookup(input.baselineResultId);
      const session = await config.ensureSession(); check();
      const candidates = baseline.result.facts.filter((fact) => baseline.readFactIds.has(fact.id) && fact.metricId === "amount" && !fact.derivation && !fact.assumption && !fact.objectIds.length && fact.value !== null && fact.value > 0);
      if (candidates.length !== 1) throw analysisArgumentsInvalid("请先读取唯一的 sales 总体 amount 基线；分组或多个范围不能猜选");
      return save(await simulatePlanScenario({ id: `qa-${sequence + 1}`, adjustment: normalizeScenarioAdjustment(input.adjustment), netVolumeChanges: normalizeNetChanges(input.netVolumeChanges), reason: input.reason }, candidates[0].id, registry.view(), session, config.signal));
    }),
    draw_chart: wrap("draw_chart", async (raw) => {
      const input = z.object(chartFields).strict().parse(raw) as DrawQaChartInput, stored = lookup(input.resultId);
      check(); const id = `c${charts.size + 1}`;
      let chart: ResolvedVisualization;
      try { chart = drawQaChart({ id, input, result: stored.result, evidence: registry.view() }); } catch (error) { throw analysisArgumentsInvalid(asError(error).message); }
      charts.set(id, chart); chart.factIds.forEach((fact) => stored.readFactIds.add(fact));
      return { chartId: id, title: chart.title, categories: chart.categories.length, series: chart.series.length, limitations: chart.limitations };
    }),
    submit_answer: wrap("submit_answer", async (raw) => {
      const { body } = z.object({ body: z.string().min(1).max(20000) }).strict().parse(raw);
      // 不把中间正文冒充最终交付；先等待已经开始的其他工具，本调用尚未加入 pending。
      await Promise.all([...pending]); check();
      try { await config.onSubmit(body); } catch (error) { throw analysisArgumentsInvalid(asError(error).message); }
      return { accepted: true };
    }),
  };
  const server = createSdkMcpServer({ name: "analytics", version: "2.0.0", tools: [
    tool("inspect_dataset", "按需读取当前授权数据的维度、指标定义、可用方法和限制；指定dimension后用cursor读取全部真实取值。无需先调用本工具才能查数。", { dimension: z.string().optional(), ...pageFields }, handlers.inspect_dataset, readonly),
    tool("analyze", "在同一只读快照执行aggregate汇总、compare对照、decompose变化拆解、scan分组份额/偏离、robustness敏感性检查。compare/decompose须reference；scan须by或breakdown；robustness须check，可选largest_store/largest_order/order_distribution/alternative_window。保留controls和commonStores。action=read_result只翻页，不重算。可用orderBy按真实metric排序完整结果，先看重点再续读其余，不重查或丢弃长尾；多范围时用orderBy.frameId选择。返回单元数不是实际门店/活动数。", analyzeFields, handlers.analyze, readonly),
    tool("simulate_scenario", "在实际已读的唯一sales总体实收上，按显式假设计算额外让利及收入情景；不是利润、需求或真实活动预测。逐行/逐单完整计算与到分舍入由代码执行。", scenarioFields, handlers.simulate_scenario, readonly),
    tool("draw_chart", "从本轮真实resultId画图，metric为结果真实metricId，不接受模型编写数据点。by是维度；多控制层可用frameIds明确选择。情景使用数值横轴。返回可放入正文的chartId。", chartFields, handlers.draw_chart),
    tool("submit_answer", "提交自由Markdown正文，图用独立行[[chart:chartId]]插入。正文数字不作逐句核验。允许继续查证或多次提交，最后有效提交作为答案；无效提交不会覆盖旧版。", { body: z.string().min(1).max(20000) }, handlers.submit_answer),
  ] });
  return { server, results, charts, operations, readFactIds, evidence: () => registry.view(), pending, toolNames: ANALYTICS_QA_TOOLS };
}
