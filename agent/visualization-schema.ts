import { z } from "zod";
import { ANALYSIS_DIMENSIONS } from "../app/lib/analytics/analysis-v2-types.ts";
import { VISUALIZATION_SCHEMA } from "../app/lib/analytics/visualization-types.ts";

const ids = z.array(z.string().min(1).max(120)).min(1).max(120);
export const chartRequestShape = {
  id: z.string().min(1).max(120).optional().describe("仅修订已创建图表时填写其真实id"),
  title: z.string().min(1).max(40).optional().describe("图的业务标题，直接说这张图回答什么，如「各类活动扣费贡献」；省略时用列名"),
  kind: z.enum(["bar", "line", "stacked_bar"]), renderer: z.enum(["native", "html"]).optional().describe("省略时使用native"),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scenario"), operationId: z.string().min(1).max(120), metricId: z.enum(["scenario.revenue_change", "scenario.revenue_after"]) }).strict(),
    z.object({ kind: z.literal("analysis"), operationId: z.string().min(1).max(120), metricId: z.string().min(1).max(120), dimension: z.enum([...ANALYSIS_DIMENSIONS, "period"]), seriesDimension: z.enum(ANALYSIS_DIMENSIONS).optional(), frameIds: ids.max(4).optional() }).strict(),
    z.object({ kind: z.literal("attachment"), calculationIds: ids.max(4), dimensionIndex: z.number().int().min(0).max(2).optional(), seriesIndex: z.number().int().min(0).max(2).optional() }).strict(),
  ]),
  selection: z.discriminatedUnion("mode", [z.object({ mode: z.literal("all") }).strict(), z.object({ mode: z.literal("top"), limit: z.number().int().min(1).max(30), rankFrameId: z.string().max(120).optional() }).strict(), z.object({ mode: z.literal("selected"), ids }).strict()]).optional().describe("省略时使用mode为all的完整选择"),
};
export const chartPlacementsSchema = z.object({ schema: z.literal(VISUALIZATION_SCHEMA), items: z.array(z.object({ id: z.string().min(1).max(120), afterBlockIndex: z.number().int().min(0).max(79), conclusionId: z.string().min(1).max(120).optional() }).strict()).max(6) }).strict();
