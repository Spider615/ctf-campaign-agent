import type { DatabaseExplainRequest } from "../app/lib/analytics/database.ts";
import type { AnalyticsExplainRequest } from "../app/lib/analytics/types.ts";
import type { PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";
import type { AnalyticsProgressEvent } from "../app/lib/analytics/stream.ts";

export type AnalyticsSkillRunner = (request: DatabaseExplainRequest | AnalyticsExplainRequest, signal?: AbortSignal, onProgress?: (event: AnalyticsProgressEvent) => void) => Promise<PlanAnswerV4>;
