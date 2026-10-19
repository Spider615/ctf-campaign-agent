import { validatePlanAnswer, validatePlanAnswerV4 } from "../../app/lib/analytics/plan/answer.ts";
import type { PlanAnswer, PlanAnswerV4 } from "../../app/lib/analytics/analysis-v2-types.ts";

// v3 计划式答案（旧会话格式）的合成夹具：v3 组装已下线，直接写出一份结构，再过 validatePlanAnswer 保证合法。
export function simulatedPlanAnswer(runId = "synthetic-plan-run", question = "先核对哪些门店？"): PlanAnswer {
  return validatePlanAnswer({
    schema: "analysis-answer/v3", runId, question, status: "answered",
    headline: { text: "销售额 1234.56 元", factIds: ["amount"], confidence: "kept" }, claims: [],
    figures: { targetLabel: "2025-02-01至2025-02-28", rows: [{ label: "销售额", target: "1,234.56元", factIds: ["amount"] }] },
    actions: [], cannotConclude: ["销售额 1234.56 元"], questions: [], assumptions: [], definitions: ["销售额：逐行按分汇总销售正金额"],
    plan: [{ id: "n1", op: "measure", status: "completed", summary: "统计 2025-02-01至2025-02-28 的 销售额" }], review: { notes: [] },
    evidence: {
      frames: [{ id: "frame", snapshotId: "synthetic-snapshot", datasetVersion: "synthetic-version", mode: "database", provenance: "sample", scope: { period: { start: "2025-02-01", end: "2025-02-28" }, population: "sales", filters: {} }, currency: "人民币", grain: "line", controls: [], limitations: [] }],
      objects: [],
      facts: [{ id: "amount", frameId: "frame", metricId: "amount", label: "销售额", value: 1234.56, unit: "元", definition: "逐行按分汇总销售正金额", objectIds: [], operationId: "operation", limitations: [] }],
      methods: [{ id: "method", operationId: "operation", status: "completed", method: "aggregate", frameIds: ["frame"], controls: [], checks: [{ name: "币种核对", status: "performed", result: "同币种" }], sampleRows: 300, groupCount: 1, limitations: [] }],
    },
  });
}

// 复现全量扫描留下大量方法检查、最终回答超过单条流消息上限的情况。
export function largeSimulatedPlanAnswer(): PlanAnswer {
  const answer = simulatedPlanAnswer();
  answer.evidence.methods[0].checks = Array.from({ length: 29046 }, (_, index) => ({ name: "参与样本", status: "performed", result: `模拟分组 ${index}：共同控制分层与参照权重均已核对；保留原文、引号\"、反斜杠\\及补充字符😀，不删除重复检查。` }));
  return answer;
}

// v4 计划式答案（自由正文）的合成夹具，同一份证据。
export function simulatedPlanAnswerV4(runId = "synthetic-plan-run", question = "先核对哪些门店？"): PlanAnswerV4 {
  const v3 = simulatedPlanAnswer(runId, question);
  return validatePlanAnswerV4({
    schema: "analysis-answer/v4", runId, question, status: "answered",
    body: [{ kind: "markdown", text: "二月销售额 1,234.56元，先核对门店口径。", refs: [{ start: 6, end: 15, factIds: ["amount"] }] }],
    keyFigure: { value: "1,234.56元", factId: "amount" },
    assumptions: [], definitions: v3.definitions, plan: v3.plan, review: { notes: [] }, evidence: v3.evidence,
  });
}
