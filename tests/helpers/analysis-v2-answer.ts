import type { AnalysisAnswer } from "../../app/lib/analytics/analysis-v2-types.ts";

// 脚本化复核的合同夹具；真实语义质量不由该夹具评分，缺项拒绝由独立运行时测试覆盖。
export const simulatedDecisionQuality = {
  directAnswer: { status: "supported" as const, reason: "合成回合已核对原问题与开头的回答" },
  evidenceFit: { status: "supported" as const, reason: "合成回合已核对所引对象、范围及方法的适用性" },
  actionValue: { status: "supported" as const, reason: "合成回合已核对建议与目标和依据的联系" },
};

// 专用合成数据；不包含客户真实经营信息。
export function simulatedAnswer(): AnalysisAnswer {
  return {
    schema: "analysis-answer/v2", status: "answered",
    task: {
      runId: "synthetic-run", question: "先核对哪些门店？", context: [], hardScope: { filters: {} }, assumptions: [],
      needs: [{ id: "need", userQuote: "先核对哪些门店", judgement: "识别值得核对的对象", status: "supported", conclusionIds: ["conclusion"] }],
    },
    conclusions: [{ id: "conclusion", needIds: ["need"], level: "observed", judgement: "优先核对这家模拟门店", factIds: ["amount", "missing"], objectIds: ["store"], methodIds: ["method"], limitations: ["尚未与业务对数，不能视为活动增量"], action: "先核对口径", validation: "与业务确认源口径" }],
    blocks: [
      { kind: "heading", nodes: [{ kind: "text", text: "优先核对候选门店" }], conclusionId: "conclusion" },
      { kind: "paragraph", nodes: [{ kind: "object_ref", objectId: "store" }, { kind: "text", text: "在" }, { kind: "period_ref", frameId: "frame" }, { kind: "text", text: "的销售额为" }, { kind: "fact_ref", factId: "amount" }, { kind: "text", text: "；成本为" }, { kind: "fact_ref", factId: "missing" }, { kind: "text", text: "。先核对源口径，再决定是否试点。" }], conclusionId: "conclusion" },
    ],
    questions: [], userConditions: [], trialParameters: [], review: { verdict: "accept", issues: [] },
    evidence: {
      frames: [{ id: "frame", snapshotId: "synthetic-snapshot", datasetVersion: "synthetic-version", mode: "database", provenance: "sample", scope: { period: { start: "2025-02-01", end: "2025-02-28" }, population: "sales", filters: { stores: ["模拟甲店"] } }, currency: "CNY", grain: "line", controls: [], limitations: ["尚未与业务对数"], recordId: "synthetic-record" }],
      objects: [{ id: "store", frameId: "frame", dimension: "store", value: "synthetic-store", label: "模拟甲店" }],
      facts: [
        { id: "amount", frameId: "frame", metricId: "amount", label: "销售额", value: 1234.56, unit: "元", definition: "逐行按分汇总销售正金额", objectIds: ["store"], operationId: "operation", limitations: [] },
        { id: "missing", frameId: "frame", metricId: "profit", label: "成本", value: null, unit: "元", definition: "成本尚未提供，不以零替代", objectIds: ["store"], operationId: "operation", limitations: ["成本尚未提供"] },
      ],
      methods: [{ id: "method", operationId: "operation", method: "aggregate", status: "completed", frameIds: ["frame"], controls: [], checks: [{ name: "币种核对", status: "performed", result: "同币种" }, { name: "订单分布", status: "unavailable", result: "缺少单号，无法执行" }], sampleRows: 4, groupCount: 1, limitations: ["没有执行订单分布检查"] }],
    },
  };
}

// 复现全量扫描留下大量方法检查、最终回答超过单条流消息上限的情况。
export function largeSimulatedAnswer(): AnalysisAnswer {
  const answer = simulatedAnswer();
  answer.evidence.methods[0].checks = Array.from({ length: 29046 }, (_, index) => ({ name: "参与样本", status: "performed", result: `模拟分组 ${index}：共同控制分层与参照权重均已核对；保留原文、引号\"、反斜杠\\及补充字符😀，不删除重复检查。` }));
  return answer;
}
