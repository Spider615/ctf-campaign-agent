export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_SALES_ROWS = 2000;
export const MAX_SNAPSHOT_BYTES = 1536 * 1024;

export type SalesRow = {
  lineId: string; date: string; store: string; category: string; netSales: number; quantity: number;
  orderId: string | null; region: string | null; city: string | null; sku: string | null;
  memberId: string | null; memberSegment: string | null; campaignId: string | null;
  cost: number | null; weightGrams: number | null;
};
export type CampaignRule = { campaignId: string; name: string; mechanism: string | null; discountValue: number | null };
export type FieldSpec = { key: string; label: string; required: boolean; aliases: string[] };
export type ImportFile = { content: string; format: "csv" | "json"; mapping?: Record<string, string>; fileName?: string };
export type ImportDatasetInput = { name: string; provenance: "imported" | "sample"; currency: "CNY"; sales: ImportFile; campaigns?: ImportFile };
export type AnalyticsDataset = {
  schema: "analytics-dataset/v1"; id: string; version: string; name: string; provenance: "imported" | "sample";
  currency: "CNY"; createdAt: string; rows: SalesRow[]; rules: CampaignRule[];
  sourceFiles: string[]; mappings: { sales: Record<string, string>; campaigns: Record<string, string> };
  minDate: string; maxDate: string; warnings: string[];
};
export type DatasetSummary = Omit<AnalyticsDataset, "rows" | "rules"> & {
  rowCount: number; ruleCount: number;
  facets: { stores: string[]; regions: string[]; categories: string[]; campaignIds: string[]; memberSegments: string[] };
};
export type Period = { start: string; end: string };
export type AnalysisQuery = {
  period: Period; comparison?: Period | null;
  filters: { stores?: string[]; regions?: string[]; categories?: string[]; campaignIds?: string[]; memberSegments?: string[] };
};
export const DIMENSIONS = ["region", "city", "store", "category", "sku", "memberSegment", "campaignId", "regionCategory", "categoryMember"] as const;
export type Dimension = typeof DIMENSIONS[number];
export const DIMENSION_LABELS: Record<Dimension, string> = {
  region: "区域", city: "城市", store: "门店", category: "货类", sku: "商品", memberSegment: "会员分组",
  campaignId: "活动", regionCategory: "区域与货类", categoryMember: "货类与会员分组",
};
export type Metrics = { rows: number; sales: number; quantity: number; grossProfit: number | null; grossMargin: number | null; weightGrams: number | null; orders: number | null; members: number | null };
export type AnalysisGroup = { id: string; dimension: Dimension; values: string[]; value: string; current: Metrics | null; baseline: Metrics | null; salesChange: number | null; salesChangePercent: number | null };
export type AnalysisInsight = { id: string; title: string; explanation: string; evidenceId: string; kind: "observation" };
export type AnalysisReport = {
  schema: "analysis/v1"; id: string; createdAt: string; datasetId: string; datasetVersion: string; datasetName: string; question?: string;
  provenance: "imported" | "sample"; currency: "CNY"; query: AnalysisQuery; metrics: Metrics; baseline: Metrics | null;
  salesChangePercent: number | null; availableDimensions: Dimension[]; groups: AnalysisGroup[]; insights: AnalysisInsight[]; limitations: string[];
};
export type EvidenceResult = { datasetVersion: string; title: string; currentRows: SalesRow[]; baselineRows: SalesRow[]; rules: CampaignRule[]; query: AnalysisQuery };
export type AnalyticsExplainRequest = { report: AnalysisReport; question: string };
export type AnalyticsExplainResult = { insightIds: string[]; nextDimensions: Dimension[]; tools: string[] };
