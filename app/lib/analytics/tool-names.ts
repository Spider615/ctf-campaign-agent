export const ANALYTICS_TOOLS = ["inspect_dataset", "query_metrics", "discover_segments", "read_analysis_evidence", "analyze_snapshot", "inspect_historical_knowledge", "read_historical_case", "query_sales_history"] as const;
export const ANALYTICS_SKILL_TRACE_TOOL = "load_analytics_skill";
export const GENERAL_ANALYTICS_TOOLS = ["plan_analysis", "analyze_history", "calculate_analysis", "simulate_analysis", "read_analysis_state", "read_review_evidence", "submit_analysis", "review_analysis", "submit_review", "present_analysis_chart"] as const;
export const ALL_ANALYTICS_TRACE_TOOLS = [...ANALYTICS_TOOLS, ...GENERAL_ANALYTICS_TOOLS] as const;
export const GENERAL_ANALYTICS_TOOL_LABELS: Record<typeof GENERAL_ANALYTICS_TOOLS[number], string> = {
  plan_analysis: "明确需要回答的问题", analyze_history: "计算分析依据", calculate_analysis: "计算方案条件与保本边界", simulate_analysis: "计算完整规则的条件情景", read_analysis_state: "核对分析进度", read_review_evidence: "核对已有分析证据", submit_analysis: "核验分析草稿", review_analysis: "复核分析结论", submit_review: "完成独立复核", present_analysis_chart: "生成有来源的图表",
};
export const ANALYTICS_TOOL_LABELS: Record<typeof ANALYTICS_TOOLS[number], string> = {
  inspect_dataset: "核对数据覆盖", query_metrics: "读取计算指标", discover_segments: "检查分析角度", read_analysis_evidence: "核对数据依据",
  analyze_snapshot: "按条件重新比较", inspect_historical_knowledge: "检查历史资料", read_historical_case: "读取历史案例", query_sales_history: "查询历史销售",
};
