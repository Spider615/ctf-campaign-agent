import type { Period } from "./types.ts";
import type { ToolTrace } from "../tool-trace.ts";
import type { Visualizations } from "./visualization-types.ts";

export const ANALYSIS_ANSWER_SCHEMA = "analysis-answer/v2" as const;
export const ANALYSIS_METHODS = ["aggregate", "compare", "decompose", "scan", "robustness"] as const;
export const ANALYSIS_DIMENSIONS = ["store", "region", "district", "category", "material", "offer", "memberFlag", "storeType", "cityTier", "mallGroup", "day", "sku", "memberSegment"] as const;
export const ANALYSIS_METRICS = ["amount", "quantity", "grams", "profit", "orders", "stores", "rows", "tag_amount", "amount_per_order", "amount_per_gram", "gap_per_gram"] as const;
export type AnalysisMethod = typeof ANALYSIS_METHODS[number];
export type AnalysisDimension = typeof ANALYSIS_DIMENSIONS[number];
export type AnalysisMetric = typeof ANALYSIS_METRICS[number];
export type AnalysisPopulation = "sales" | "net" | "recovery" | "returns" | "zero_sales";
export type AnalysisFilters = Partial<Record<"stores" | "regions" | "districts" | "categories" | "materials" | "offers" | "memberFlags" | "storeTypes" | "skus" | "memberSegments", string[]>>;

export type AnalysisScope = { period: Period; population: AnalysisPopulation; filters: AnalysisFilters };
export type AnalysisConstraints = { period?: Period; filters: AnalysisFilters };
export type AnalysisNeed = { id: string; userQuote: string; judgement: string; status: "open" | "supported" | "conditional" | "needs_business_input"; conclusionIds: string[] };
export type AnalysisTask = { runId: string; question: string; context: string[]; mode?: "lookup" | "analysis"; needs: AnalysisNeed[]; hardScope: AnalysisConstraints; focus?: AnalysisFilters; goal?: string; assumptions: string[] };

export type AnalysisMetricDefinition = { id: string; label: string; unit: string; grain: "line" | "selected_order" | "group" | "unknown"; additive: boolean; allowedPopulations: AnalysisPopulation[]; requiredControls: AnalysisDimension[]; definition: string };
export type AnalysisCapabilities = { mode: "database" | "snapshot" | "historical"; name: string; coverage: Period; currency: string; provenance: "sample" | "imported"; dimensions: AnalysisDimension[]; metrics: AnalysisMetricDefinition[]; methods: AnalysisMethod[]; scenarios?: AnalysisAdjustment["kind"][]; limitations: string[] };
export type AnalysisFrame = { id: string; snapshotId: string; datasetVersion: string; mode: AnalysisCapabilities["mode"]; provenance: "sample" | "imported"; scope: Omit<AnalysisScope, "population"> & { population: AnalysisPopulation | "unknown" }; currency: string; grain: "line" | "selected_order" | "group" | "unknown"; controls: AnalysisDimension[]; limitations: string[]; recordId?: string };
export type AnalysisObject = { id: string; frameId: string; dimension: AnalysisDimension; value: string; label: string };
export type FactExpression = { factId: string } | { constant: number } | { op: "add" | "subtract" | "multiply" | "divide"; args: FactExpression[] };
export type AnalysisScenarioCase = { kind: "static_loss"; baselineFactId: string; parameterFactIds: string[] } | { kind: "revenue"; baselineFactId: string; lossFactId: string; rateFactId: string; netChange: string };
export type AnalysisFact = { id: string; frameId: string; metricId: string; label: string; value: number | null; unit: string; definition: string; objectIds: string[]; operationId: string; derivation?: FactExpression; assumption?: { reason: string }; scenario?: AnalysisScenarioCase; limitations: string[]; comparisonRole?: "descriptive" | "within_stratum" | "standardized"; comparisonControls?: AnalysisDimension[]; comparisonKey?: string; comparisonValues?: Partial<Record<AnalysisDimension, string>> };
export type AnalysisMethodReport = { id: string; operationId: string; method: AnalysisMethod; status: "completed" | "unsupported"; frameIds: string[]; controls: AnalysisDimension[]; checks: Array<{ name: string; status: "performed" | "unavailable"; result: string }>; sampleRows: number; groupCount: number; limitations: string[] };
export type AnalysisEvidence = { frames: AnalysisFrame[]; facts: AnalysisFact[]; objects: AnalysisObject[]; methods: AnalysisMethodReport[] };

// 单元数据仅供确定性操作使用；逐单标识和底层查询不进入模型上下文。
export type AnalysisAggregateCell = { dimensions: Partial<Record<AnalysisDimension | "order", string>>; rows: number; amount: number | null; quantity: number | null; grams: number | null; profit: number | null; orders: number | null; stores: number | null; tag_amount: number | null; orderIds?: Array<string | null> };
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

export type AnalysisTrialParameter = { id: string; kind: "store_count" | "duration_days"; value: number; objectIds: string[]; conditions: string[]; status: "proposed" };
export type AnalysisUserCondition = { id: string; quote: string };
export type AnalysisAnswerNode = { kind: "text"; text: string } | { kind: "fact_ref"; factId: string } | { kind: "object_ref"; objectId: string } | { kind: "period_ref"; frameId: string } | { kind: "user_condition_ref"; conditionId: string } | { kind: "trial_parameter_ref"; parameterId: string };
export type AnalysisAnswerBlock = { kind: "paragraph" | "bullet" | "heading"; nodes: AnalysisAnswerNode[]; conclusionId?: string };
export type AnalysisConclusion = { id: string; needIds: string[]; level: "observed" | "comparison_supported" | "hypothesis"; judgement: string; factIds: string[]; objectIds: string[]; methodIds: string[]; limitations: string[]; action?: string; validation?: string };
export type AnalysisDraft = { status: "answered" | "conditional" | "incomplete"; conclusions: AnalysisConclusion[]; blocks: AnalysisAnswerBlock[]; questions: string[]; userConditions: AnalysisUserCondition[]; trialParameters: AnalysisTrialParameter[]; coverage?: Array<{ needId: string; status: AnalysisNeed["status"]; reason: string }>; visualizations?: Visualizations };
export type AnalysisReviewIssue = { needIds: string[]; conclusionIds: string[]; requirement: string; kind: "task_coverage" | "missing_evidence" | "invalid_comparison" | "unsupported_explanation" | "unclear_action" | "expression" };
export type AnalysisSemanticReview = { verdict: "accept" | "revise" | "accept_conditional"; issues: AnalysisReviewIssue[] };
export type AnalysisAnswer = AnalysisDraft & { schema: typeof ANALYSIS_ANSWER_SCHEMA; task: AnalysisTask; evidence: AnalysisEvidence; review: AnalysisSemanticReview; trace?: ToolTrace };

export type EvidenceRegistry = { ingest(result: AnalysisOperationResult): void; ingestAsync(result: AnalysisOperationResult, signal?: AbortSignal): Promise<void>; bundle(): AnalysisEvidence; view(): AnalysisEvidence; clear(): void };
export type DraftValidation = { valid: boolean; issues: AnalysisReviewIssue[] };
