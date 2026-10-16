import { z } from "zod";
import { ANALYSIS_DIMENSIONS } from "../app/lib/analytics/analysis-v2-types.ts";
import { VISUALIZATION_SCHEMA } from "../app/lib/analytics/visualization-types.ts";

const ids = z.array(z.string().min(1).max(120)).min(1).max(120);
export const chartRequestShape = {
  id: z.string().min(1).max(120).optional().describe("仅修订已创建图表时填写其真实id"),
  kind: z.enum(["bar", "line", "stacked_bar"]), renderer: z.enum(["native", "html"]).default("native"),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scenario"), operationId: z.string().min(1).max(120), metricId: z.enum(["scenario.revenue_change", "scenario.revenue_after"]) }).strict(),
    z.object({ kind: z.literal("analysis"), operationId: z.string().min(1).max(120), metricId: z.string().min(1).max(120), dimension: z.enum([...ANALYSIS_DIMENSIONS, "period"]), seriesDimension: z.enum(ANALYSIS_DIMENSIONS).optional(), frameIds: ids.max(4).optional() }).strict(),
    z.object({ kind: z.literal("attachment"), calculationIds: ids.max(4), dimensionIndex: z.number().int().min(0).max(2).optional(), seriesIndex: z.number().int().min(0).max(2).optional() }).strict(),
  ]),
  selection: z.discriminatedUnion("mode", [z.object({ mode: z.literal("all") }).strict(), z.object({ mode: z.literal("top"), limit: z.number().int().min(1).max(30), rankFrameId: z.string().max(120).optional() }).strict(), z.object({ mode: z.literal("selected"), ids }).strict()]).default({ mode: "all" }),
};
export const chartPlacementsSchema = z.object({ schema: z.literal(VISUALIZATION_SCHEMA), items: z.array(z.object({ id: z.string().min(1).max(120), afterBlockIndex: z.number().int().min(0).max(79), conclusionId: z.string().min(1).max(120).optional() }).strict()).max(6) }).strict();
export const VISUALIZATION_PROMPT = `\n本客户端支持证据图表。趋势、分组比较、结构构成可按需要用 present_analysis_chart；仅问单个数字无需配图。只引用实际operationId/metricId/分组维度或calculationId，不提交数值、HTML或JS。历史折线限真实时间且保留完整序列；simulate_analysis结果使用scenario来源、完整line与数值横轴，明确条件测算，不能冒充实际趋势。堆叠限完整可加总构成。分类较多时用top并明确排名序列，不能截取已读分页当总体。工具创建图表并返回visualizationId；最终draft添加visualizations:{schema:"${VISUALIZATION_SCHEMA}",items:[{id:真实visualizationId,afterBlockIndex:相关原始blocks下标,conclusionId:关联结论id}]}。该字段只接受id和正文位置；完整数据由程序组装。图文一起复核。每次显式提供renderer为native或html，html使用相同证据的隔离图文模板。绘图失败可修正或以文字回答，不重复无效绘图。`;
