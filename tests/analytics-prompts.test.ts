import assert from "node:assert/strict";
import test from "node:test";
import { buildLegacyAnalyticsSystemPrompt, buildPlanSystemPrompt } from "../agent/analytics-system-prompt.ts";

// 旧的多轮自由分析流程已删除；仍在用的两份系统提示词不能再引导模型调用已下线的工具或合同。
test("计划式与旧版 v1 提示词不再提及已删除的分析工具和 v2 合同", () => {
  for (const prompt of [buildPlanSystemPrompt("2026-10-18"), buildLegacyAnalyticsSystemPrompt("2026-10-18", "database"), buildLegacyAnalyticsSystemPrompt("2026-10-18", "report")]) {
    assert.match(prompt, /小福/);
    assert.doesNotMatch(prompt, /submit_analysis|calculate_analysis|simulate_analysis|present_analysis_chart|review_analysis|analysis-answer\/v2/);
  }
});
