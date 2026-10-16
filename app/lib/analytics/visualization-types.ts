import type { AnalysisDimension, AnalysisEvidence } from "./analysis-v2-types.ts";

export const VISUALIZATION_SCHEMA = "analysis-visualization/v1" as const;
export const VISUALIZATION_LIMITS = { charts: 6, series: 4, categories: 30, timePoints: 366 } as const;
export type VisualizationKind = "bar" | "line" | "stacked_bar";
export type VisualizationSelection = { mode: "all" } | { mode: "top"; limit: number; rankFrameId?: string } | { mode: "selected"; ids: string[] };
export type VisualizationSource =
  | { kind: "analysis"; operationId: string; metricId: string; dimension: AnalysisDimension | "period"; seriesDimension?: AnalysisDimension; frameIds?: string[] }
  | { kind: "scenario"; operationId: string; metricId: "scenario.revenue_change" | "scenario.revenue_after" }
  | { kind: "attachment"; calculationIds: string[]; dimensionIndex?: number; seriesIndex?: number };
export type VisualizationSpec = { id: string; revision: number; kind: VisualizationKind; renderer: "native" | "html"; afterBlockIndex: number; source: VisualizationSource; selection: VisualizationSelection; conclusionId?: string };
export type Visualizations = { schema: typeof VISUALIZATION_SCHEMA; items: VisualizationSpec[] };
export type AttachmentCalculation = {
  id: string; attachmentId: string; version: string; tableId: string; name: string; location: string;
  operation: "sum" | "count" | "distinct" | "average" | "min" | "max"; column?: string; groupBy: string[]; unit: string;
  filters: Array<{ column: string; operator: string; value: string }>; groupCount: number;
  groups: Array<{ labels: string[]; value: string | null; sourceId: string; matchedRows: number; missingRows: number }>; warnings: string[];
};
export type VisualizationFileSource = { id: string; attachmentId: string; version: string; name: string; location: string; excerpt: string; calculationId?: string };
export type VisualizationValue = { value: number | null; exact: string | null; refIds: string[] };
export type ResolvedVisualization = {
  id: string; revision: number; kind: VisualizationKind; renderer: VisualizationSpec["renderer"]; afterBlockIndex: number;
  title: string; unit: string; scope: string; definition: string; limitations: string[]; selectionLabel: string;
  categories: Array<{ key: string; label: string; numericValue?: number }>;
  xAxis?: { kind: "number"; label: string; unit: string };
  series: Array<{ key: string; label: string; values: VisualizationValue[] }>;
  sourceIds: string[]; factIds: string[]; objectIds: string[];
};
export type VisualizationPreview = { spec: VisualizationSpec; evidence?: AnalysisEvidence; calculations?: AttachmentCalculation[]; sources?: VisualizationFileSource[] };
export type VisualizationProgressEvent =
  | { type: "visualization"; schema: typeof VISUALIZATION_SCHEMA; runId: string; epoch: number; action: "upsert"; preview: VisualizationPreview }
  | { type: "visualization"; schema: typeof VISUALIZATION_SCHEMA; runId: string; epoch: number; action: "retract"; ids: string[]; reason: "scope_changed" | "snapshot_changed" | "source_unavailable" };
