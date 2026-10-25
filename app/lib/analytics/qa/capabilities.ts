import type { AnalysisCapabilities } from "../analysis-v2-types.ts";
import { SEMANTIC_DIMENSIONS } from "../semantic/model.ts";

// 同一目录用于旧计划与新工具；完整模式不以五个示例代替可续读的真实取值。
export function capabilityBrief(capabilities: AnalysisCapabilities, options: { compact?: boolean } = {}): string {
  const compact = options.compact === true;
  const cut = (value: string) => compact && value.length > 60 ? `${value.slice(0, 60)}…` : value;
  const basis: Record<string, string> = { schema: "字段", data: "数据", business: "业务", assumption: "待确认" };
  const lines = [`数据：${capabilities.name}；覆盖 ${capabilities.coverage.start} 至 ${capabilities.coverage.end}；币种 ${capabilities.currency}`];
  lines.push("维度（id|名称|筛选键|上级|参与扫描|依据与定义|取值）：原值可用 inspect_dataset({dimension,contains,cursor,pageSize}) 分页读取；contains可选，按区分大小写的字面子串筛选，不识别业务身份。目录不是全部取值列表。");
  const catalog = capabilities.dimensionCatalog ?? capabilities.dimensions.map((id) => ({ id, ...SEMANTIC_DIMENSIONS[id] }));
  for (const item of catalog) {
    const values = "values" in item && Array.isArray(item.values) ? item.values as string[] : undefined;
    const listed = !values ? "|取值按需分页读取" : values.length <= 60 ? `|取值：${values.join("、")}` : `|共 ${values.length} 个取值，请分页读取`;
    lines.push(`${item.id}|${item.label}|${item.filter}|${item.parent ?? ""}|${item.scan ? "是" : "否"}|${basis[item.basis] ?? item.basis}：${cut(item.definition)}${listed}`);
  }
  lines.push("指标（id|名称|单位|口径|定义）：");
  for (const metric of capabilities.metrics) lines.push(`${metric.id}|${metric.label}|${metric.unit}|${metric.allowedPopulations.join("/")}${metric.basis ? `，${basis[metric.basis] ?? metric.basis}` : ""}|${cut(metric.definition)}${metric.requiredControls.length ? `；须控制 ${metric.requiredControls.join("、")}` : ""}`);
  if (capabilities.baselines?.length) lines.push("基线：", ...capabilities.baselines.map((v) => `${v.id}|${v.label}|${cut(v.how)}|${cut(v.definition)}`));
  lines.push(`可用方法：${capabilities.methods.join("、")}`);
  if (capabilities.scenarios?.length) lines.push(`情景规则：${capabilities.scenarios.join("、")}`);
  if (capabilities.limitations.length) lines.push(`数据限制：${capabilities.limitations.map(cut).join("；")}`);
  return lines.join("\n");
}
