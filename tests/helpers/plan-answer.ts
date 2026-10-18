import { assemblePlanAnswer } from "../../app/lib/analytics/plan/answer.ts";
import type { Binding } from "../../app/lib/analytics/plan/bind.ts";
import type { PlanExecution } from "../../app/lib/analytics/plan/execute.ts";
import type { PlanNode } from "../../app/lib/analytics/plan/types.ts";
import type { AnalysisCapabilities, PlanAnswer } from "../../app/lib/analytics/analysis-v2-types.ts";

// 计划式答案的合成夹具：手工搭一个最小执行结果和绑定，再走真实组装，保证通过 validatePlanAnswer。
const capabilities = {
  mode: "database", name: "合成数据", coverage: { start: "2025-01-01", end: "2025-12-31" }, currency: "人民币", provenance: "sample", dimensions: ["store"],
  dimensionCatalog: [{ id: "store", label: "门店", filter: "stores", scan: false, definition: "实体分店", basis: "schema" }],
  metrics: [{ id: "amount", label: "销售额", unit: "元", grain: "line", additive: true, allowedPopulations: ["sales"], requiredControls: [], definition: "逐行按分汇总销售正金额", basis: "data" }],
  methods: ["aggregate"], limitations: [],
} as unknown as AnalysisCapabilities;

export function simulatedPlanAnswer(runId = "synthetic-plan-run", question = "先核对哪些门店？"): PlanAnswer {
  const node = { id: "n1", op: "measure", scope: { period: { start: "2025-02-01", end: "2025-02-28" }, population: "sales", filters: {} }, metrics: ["amount"] } as unknown as PlanNode;
  const execution: PlanExecution = {
    results: new Map([["n1", { node, status: "completed", operationIds: ["operation"], rows: [{ key: {}, metric: "amount", factId: "amount", role: "value" }] }]]),
    evidence: {
      frames: [{ id: "frame", snapshotId: "synthetic-snapshot", datasetVersion: "synthetic-version", mode: "database", provenance: "sample", scope: { period: { start: "2025-02-01", end: "2025-02-28" }, population: "sales", filters: {} }, currency: "人民币", grain: "line", controls: [], limitations: [] }],
      objects: [],
      facts: [{ id: "amount", frameId: "frame", metricId: "amount", label: "销售额", value: 1234.56, unit: "元", definition: "逐行按分汇总销售正金额", objectIds: [], operationId: "operation", limitations: [] }],
      methods: [{ id: "method", operationId: "operation", status: "completed", method: "aggregate", frameIds: ["frame"], controls: [], checks: [{ name: "币种核对", status: "performed", result: "同币种" }], sampleRows: 300, groupCount: 1, limitations: [] }],
    },
  };
  const binding: Binding = { headline: { node: "n1", metric: "amount", assert: "unavailable", text: "销售额 1234.56 元", factIds: ["amount"], rendered: "销售额 1234.56 元", confidence: "kept" }, claims: [], actions: [], dropped: [], droppedText: [], cannotConclude: [], questions: [] };
  return assemblePlanAnswer({ runId, question, execution, binding, capabilities, droppedNodes: [], reviewNotes: [] });
}

// 复现全量扫描留下大量方法检查、最终回答超过单条流消息上限的情况。
export function largeSimulatedPlanAnswer(): PlanAnswer {
  const answer = simulatedPlanAnswer();
  answer.evidence.methods[0].checks = Array.from({ length: 29046 }, (_, index) => ({ name: "参与样本", status: "performed", result: `模拟分组 ${index}：共同控制分层与参照权重均已核对；保留原文、引号\"、反斜杠\\及补充字符😀，不删除重复检查。` }));
  return answer;
}
