import { createHash } from "node:crypto";
import { readHistoricalCase } from "./analytics-history.ts";
import type { AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";

// 仅把受控历史聚合记录变成可追溯的参考，不推断缺失的币种、人口或明细粒度。
export function readHistoricalAnalysis(directory: string | undefined, caseId: string, needIds: string[]): AnalysisOperationResult {
  const sources = readHistoricalCase(directory, caseId);
  const shortId = (kind: string, value: unknown) => `h${kind}-${createHash("sha256").update(JSON.stringify([sources, value])).digest("hex").slice(0, 12)}`;
  const operationId = shortId("o", caseId);
  const limitations = ["历史聚合口径、币种和明细粒度未重新核对，只能作为历史参考；不能与当前事实直接计算差额或宣称可比"];
  const result: AnalysisOperationResult = { operationId, status: "completed", method: "aggregate", needIds, purpose: "读取已登记历史参考", frames: [], facts: [], objects: [], methods: [], limitations };
  for (const [index, source] of sources.entries()) {
    const dates = source.periodLabel.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})至([0-9]{4}-[0-9]{2}-[0-9]{2})$/);
    if (!dates) throw new Error("历史参考缺少明确日期，不注册为可引用事实");
    const frameId = shortId("d", index);
    result.frames.push({ id: frameId, snapshotId: `historical:${source.datasetVersion}`, datasetVersion: source.datasetVersion, mode: "historical", provenance: source.provenance, scope: { period: { start: dates[1], end: dates[2] }, population: "unknown", filters: {} }, currency: "未核对", grain: "unknown", controls: [], limitations: [...source.limitations, ...limitations, `源范围：${source.scope}`], recordId: source.recordId });
    for (const [rowIndex, row] of source.rows.entries()) for (const [fieldIndex, field] of row.fields.entries()) {
      if (typeof field.value !== "number" && field.value !== null) continue;
      result.facts.push({ id: shortId("f", [index, rowIndex, fieldIndex]), frameId, operationId, metricId: `historical.${field.label}`, label: `${row.label} · ${field.label}`, value: field.value, unit: field.unit ?? "源单位未提供", definition: source.definition, objectIds: [], limitations: [...source.limitations, ...limitations] });
    }
    result.methods.push({ id: shortId("m", index), operationId, method: "aggregate", status: "completed", frameIds: [frameId], controls: [], checks: [{ name: "历史目录版本与实际结果", status: "performed", result: "已读取登记的原始聚合结果及明确周期，未执行当前明细重算" }, { name: "当前数据可比性", status: "unavailable", result: limitations[0] }], sampleRows: 0, groupCount: source.rows.length, limitations });
  }
  return result;
}
