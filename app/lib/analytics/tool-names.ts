export const ANALYTICS_TOOLS = ["inspect_dataset", "query_metrics", "discover_segments", "read_analysis_evidence", "analyze_snapshot", "inspect_historical_knowledge", "read_historical_case", "query_sales_history"] as const;
export const ANALYTICS_SKILL_TRACE_TOOL = "load_analytics_skill";
export const ANALYTICS_QA_TOOLS = ["inspect_dataset", "analyze", "simulate_scenario", "draw_chart", "submit_answer"] as const;
export type AnalyticsQaToolName = typeof ANALYTICS_QA_TOOLS[number];
export const ANALYTICS_QA_TOOL_LABELS: Record<AnalyticsQaToolName, string> = { inspect_dataset: "查看数据能力", analyze: "读取分析结果", simulate_scenario: "计算条件情景", draw_chart: "绘制数据图表", submit_answer: "整理回答" };
// 旧会话过程记录：已删除的多轮自由分析流程的工具名。只用于恢复已存过程记录时通过白名单核验，不再有运行器使用。
export const RETIRED_GENERAL_ANALYTICS_TOOLS = ["plan_analysis", "analyze_history", "calculate_analysis", "simulate_analysis", "read_analysis_state", "read_review_evidence", "submit_analysis", "review_analysis", "submit_review", "present_analysis_chart"] as const;
// 计划即程序：每一步只开放一个提交工具；run_plan_node 是代码执行计划节点的轨迹。
export const PLAN_ANALYTICS_TOOLS = ["submit_plan", "submit_plan_review", "run_plan_node", "submit_followup", "submit_answer", "submit_answer_review"] as const;
export type PlanAnalyticsToolName = typeof PLAN_ANALYTICS_TOOLS[number];
export const PLAN_ANALYTICS_TOOL_LABELS: Record<PlanAnalyticsToolName, string> = {
  submit_plan: "明确分析计划", submit_plan_review: "复核分析计划", run_plan_node: "执行分析步骤", submit_followup: "补充分析计划", submit_answer: "撰写回答", submit_answer_review: "复核回答",
};
// 旧会话过程记录：v3 答案的结论与措辞复核步骤。只用于恢复已存的 v3 答案时通过白名单核验。
export const RETIRED_PLAN_ANALYTICS_TOOLS = ["submit_claims", "submit_wording_review"] as const;
export const ALL_ANALYTICS_TRACE_TOOLS = [...ANALYTICS_TOOLS, ...ANALYTICS_QA_TOOLS, ...RETIRED_GENERAL_ANALYTICS_TOOLS, ...PLAN_ANALYTICS_TOOLS, ...RETIRED_PLAN_ANALYTICS_TOOLS] as const;
export const ANALYTICS_TOOL_LABELS: Record<typeof ANALYTICS_TOOLS[number], string> = {
  inspect_dataset: "核对数据覆盖", query_metrics: "读取计算指标", discover_segments: "检查分析角度", read_analysis_evidence: "核对数据依据",
  analyze_snapshot: "按条件重新比较", inspect_historical_knowledge: "检查历史资料", read_historical_case: "读取历史案例", query_sales_history: "查询历史销售",
};
