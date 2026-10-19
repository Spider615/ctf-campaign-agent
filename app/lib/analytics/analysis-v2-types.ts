import type { Period } from "./types.ts";
import type { ToolTrace } from "../tool-trace.ts";
import type { ResolvedVisualization } from "./visualization-types.ts";

// 已退役的 v2 回答合同：只用于识别旧页面请求头和已存会话里的旧答案，不再生成或渲染。
export const RETIRED_ANALYSIS_ANSWER_SCHEMA = "analysis-answer/v2" as const;
export const PLAN_ANSWER_SCHEMA = "analysis-answer/v3" as const;
export const PLAN_ANSWER_V4_SCHEMA = "analysis-answer/v4" as const;
export const ANALYSIS_METHODS = ["aggregate", "compare", "decompose", "scan", "robustness"] as const;
// 维度、指标与筛选键由语义层统一定义。
export { ANALYSIS_DIMENSIONS, ANALYSIS_METRICS } from "./semantic/model.ts";
import type { SemanticDimensionId, SemanticFilterKey, SemanticMetricId } from "./semantic/model.ts";
export type AnalysisMethod = typeof ANALYSIS_METHODS[number];
export type AnalysisDimension = SemanticDimensionId;
export type AnalysisMetric = SemanticMetricId;
export type AnalysisPopulation = "sales" | "net" | "recovery" | "returns" | "zero_sales";
export type AnalysisFilters = Partial<Record<SemanticFilterKey, string[]>>;

export type AnalysisScope = { period: Period; population: AnalysisPopulation; filters: AnalysisFilters };
export type AnalysisConstraints = { period?: Period; filters: AnalysisFilters };

export type AnalysisMetricDefinition = { id: string; label: string; unit: string; grain: "line" | "selected_order" | "group" | "unknown"; additive: boolean; allowedPopulations: AnalysisPopulation[]; requiredControls: AnalysisDimension[]; definition: string; basis?: "schema" | "data" | "business" | "assumption" };
// values：取值不多的维度在会话打开时读出全部实际取值，供计划校验筛选值、提示模型写对原值。
export type AnalysisDimensionDefinition = { id: AnalysisDimension; label: string; filter: SemanticFilterKey; parent?: AnalysisDimension; scan: boolean; definition: string; basis: "schema" | "data" | "business" | "assumption"; values?: string[] };
export type AnalysisBaselineDefinition = { id: string; label: string; how: string; definition: string; basis: "schema" | "data" | "business" | "assumption" };
export type AnalysisCapabilities = { mode: "database" | "snapshot" | "historical"; name: string; coverage: Period; currency: string; provenance: "sample" | "imported"; dimensions: AnalysisDimension[]; dimensionCatalog?: AnalysisDimensionDefinition[]; metrics: AnalysisMetricDefinition[]; baselines?: AnalysisBaselineDefinition[]; methods: AnalysisMethod[]; scenarios?: AnalysisAdjustment["kind"][]; limitations: string[] };
export type AnalysisFrame = { id: string; snapshotId: string; datasetVersion: string; mode: AnalysisCapabilities["mode"]; provenance: "sample" | "imported"; scope: Omit<AnalysisScope, "population"> & { population: AnalysisPopulation | "unknown" }; currency: string; grain: "line" | "selected_order" | "group" | "unknown"; controls: AnalysisDimension[]; limitations: string[]; recordId?: string };
export type AnalysisObject = { id: string; frameId: string; dimension: AnalysisDimension; value: string; label: string };
export type FactExpression = { factId: string } | { constant: number } | { op: "add" | "subtract" | "multiply" | "divide"; args: FactExpression[] };
export type AnalysisScenarioCase = { kind: "static_loss"; baselineFactId: string; parameterFactIds: string[] } | { kind: "revenue"; baselineFactId: string; lossFactId: string; rateFactId: string; netChange: string };
export type AnalysisFact = { id: string; frameId: string; metricId: string; label: string; value: number | null; unit: string; definition: string; objectIds: string[]; operationId: string; derivation?: FactExpression; assumption?: { reason: string }; scenario?: AnalysisScenarioCase; limitations: string[]; comparisonRole?: "descriptive" | "within_stratum" | "standardized"; comparisonControls?: AnalysisDimension[]; comparisonKey?: string; comparisonValues?: Partial<Record<AnalysisDimension, string>> };
export type AnalysisMethodReport = { id: string; operationId: string; method: AnalysisMethod; status: "completed" | "unsupported"; frameIds: string[]; controls: AnalysisDimension[]; checks: Array<{ name: string; status: "performed" | "unavailable"; result: string }>; sampleRows: number; groupCount: number; limitations: string[] };
export type AnalysisEvidence = { frames: AnalysisFrame[]; facts: AnalysisFact[]; objects: AnalysisObject[]; methods: AnalysisMethodReport[] };

// 单元数据仅供确定性操作使用；逐单标识和底层查询不进入模型上下文。
export type AnalysisAggregateCell = { dimensions: Partial<Record<AnalysisDimension | "order", string>>; rows: number; amount: number | null; quantity: number | null; grams: number | null; profit: number | null; orders: number | null; stores: number | null; tag_amount: number | null; orderMissingRows?: number | null; orderIds?: Array<string | null> };
export type AnalysisAggregateQuery = { scope: AnalysisScope; by: Array<AnalysisDimension | "order">; metrics?: AnalysisMetric[]; excludeStores?: string[]; excludeOrders?: string[] };
export type AnalysisOrderDistributionQuery = { scope: AnalysisScope; metrics: AnalysisMetric[] };
export type AnalysisOrderDistribution = { sampleRows: number; excludedRows: number; orderCount: number; quantiles: Partial<Record<AnalysisMetric, { p50: number | null; p90: number | null; p99: number | null }>> };
export type AnalysisAdjustment = { kind: "per_gram" | "per_item" | "per_order"; amount: string } | { kind: "amount_rate"; rate: string } | { kind: "order_threshold"; threshold: string; amount: string };
export type AnalysisScenarioQuery = { scope: AnalysisScope; adjustment: AnalysisAdjustment };
export type AnalysisScenarioAggregate = { sampleRows: number; amountCents: number; lossCents: number | null; units: number | null; unit: "克" | "件" | "单" | "实收"; missingUnits: number; nonpositiveUnits: number; eligibleUnits: number };
export type AnalysisDataSession = { snapshotId: string; datasetVersion: string; capabilities: AnalysisCapabilities; assertActive?(): void; aggregate(query: AnalysisAggregateQuery, signal?: AbortSignal): Promise<AnalysisAggregateCell[]>; aggregateWithOrderIds?(query: AnalysisAggregateQuery, signal?: AbortSignal): Promise<AnalysisAggregateCell[] | null>; orderDistribution?(query: AnalysisOrderDistributionQuery, signal?: AbortSignal): Promise<AnalysisOrderDistribution>; scenario?(query: AnalysisScenarioQuery, signal?: AbortSignal): Promise<AnalysisScenarioAggregate>; close(): Promise<void> };
export type AnalysisDataProvider = { open(signal?: AbortSignal): Promise<AnalysisDataSession> };

export type AnalysisOperationRequest = {
  needIds: string[];
  purpose: string;
  method: AnalysisMethod;
  scope: AnalysisScope;
  metrics: AnalysisMetric[];
  by?: AnalysisDimension[];
  reference?: AnalysisScope;
  controls?: AnalysisDimension[];
  commonStores?: boolean;
  breakdown?: AnalysisDimension;
  check?: "largest_store" | "largest_order" | "order_distribution" | "alternative_window";
  alternative?: Period;
};
export type AnalysisOperationResult = AnalysisEvidence & { operationId: string; status: "completed" | "unsupported"; method: AnalysisMethod; needIds: string[]; purpose: string; limitations: string[]; cached?: boolean };

export type EvidenceRegistry = { ingest(result: AnalysisOperationResult): void; ingestAsync(result: AnalysisOperationResult, signal?: AbortSignal): Promise<void>; bundle(): AnalysisEvidence; view(): AnalysisEvidence; clear(): void };

// 计划式分析的最终答案：措辞由模型写，数字、方向、可信度、图表都由代码绑定和推导。
// keyFigure：这条结论的重点数字（已按单位格式化），只在主结论上用来放大显示；必须是 factIds 里某个事实的值。
export type PlanAnswerClaim = { text: string; factIds: string[]; confidence: "kept" | "flipped" | "unchecked"; keyFigure?: { value: string; factId: string } };
// 关键数据表：由代码从结论绑定的节点生成，每行一个指标；对比给目标、参照和变化，单值只给数值。
export type PlanAnswerFigure = { label: string; scope?: string; target: string; reference?: string; change?: string; factIds: string[] };
export type PlanAnswer = {
  schema: typeof PLAN_ANSWER_SCHEMA; runId: string; question: string; status: "answered" | "partial" | "unavailable";
  headline?: PlanAnswerClaim;
  claims: PlanAnswerClaim[];
  figures?: { targetLabel: string; referenceLabel?: string; rows: PlanAnswerFigure[] };
  actions: string[]; cannotConclude: string[]; questions: string[];
  assumptions: string[]; definitions: string[]; chart?: ResolvedVisualization;
  plan: Array<{ id: string; op: string; status: string; summary: string }>;
  review: { notes: string[] }; evidence: AnalysisEvidence; trace?: ToolTrace;
};

// v4：正文由模型自由写成 Markdown，数字是引用替换出来的；refs 标出每个数字在 text 里的位置和对应事实。
export type PlanAnswerBlock =
  | { kind: "markdown"; text: string; refs: Array<{ start: number; end: number; factIds: string[] }> }
  | { kind: "table"; title: string; columns: string[]; rows: Array<{ cells: string[]; factIds: string[] }> }
  | { kind: "chart"; chart: ResolvedVisualization };
export type PlanAnswerV4 = {
  schema: typeof PLAN_ANSWER_V4_SCHEMA; runId: string; question: string; status: "answered" | "partial" | "unavailable";
  body: PlanAnswerBlock[]; keyFigure?: { value: string; factId: string };
  assumptions: string[]; definitions: string[];
  plan: Array<{ id: string; op: string; status: string; summary: string }>;
  review: { notes: string[] }; evidence: AnalysisEvidence; trace?: ToolTrace;
};
