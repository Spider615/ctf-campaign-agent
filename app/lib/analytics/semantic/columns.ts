// 维度来源用到哪些源字段；数据库编译和洞察图谱的来源说明共用。
import type { SemanticDimensionSource } from "./model.ts";

export const sourceColumns = (source: SemanticDimensionSource): string[] => source.kind === "column" || source.kind === "coalesce" || source.kind === "age_band" || source.kind === "labels" ? [source.column] : source.kind === "composite" ? [...source.columns] : source.kind === "date_range" ? [source.start, source.end] : [source.sunday, source.weekend, source.workday];
