import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_TOOL_NAMES,
  SKILL_TRACE_TOOL,
  finishTraceEvent,
  formatDuration,
  harnessTimingSummary,
  intervalUnionDurationMs,
  mergeTraceEvent,
  parseAgentTraceEvent,
  parseToolTrace,
  startTraceEvent,
  traceCardSummary,
  traceSummary,
  type AgentTraceEvent,
  type ToolTraceStatus,
} from "../app/lib/tool-trace.ts";

test("trace events replace an in-flight step by id", () => {
  const started = startTraceEvent({
    id: "t1",
    tool: "extract_campaign_facts",
    title: "提取活动信息",
    initiatedBy: "model",
    at: 100,
  });
  const completed = finishTraceEvent(started, {
    status: "completed",
    summary: "识别并核验 8 项信息",
    at: 180,
  });
  const events = mergeTraceEvent(mergeTraceEvent([], started), completed);

  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 80);
  assert.equal(events[0].summary, "识别并核验 8 项信息");
});

test("stored traces become a short history line", () => {
  const trace = {
    status: "completed" as const,
    durationMs: 80,
    steps: [
      finishTraceEvent(
        startTraceEvent({
          id: "t1",
          tool: "extract_campaign_facts",
          title: "提取活动信息",
          initiatedBy: "model",
          at: 100,
        }),
        { status: "completed", summary: "识别 8 项", at: 180 },
      ),
    ],
  };

  assert.equal(traceSummary(trace), "AI 完成 1 个工具步骤 · 步骤跨度 80ms");
  assert.doesNotMatch(traceSummary(trace), /总用时/);
});

test("formatDuration 按毫秒精度诚实显示短耗时", () => {
  assert.equal(formatDuration(0), "<1ms");
  assert.equal(formatDuration(0.9), "<1ms");
  assert.equal(formatDuration(1), "1ms");
  assert.equal(formatDuration(14.4), "14ms");
  assert.equal(formatDuration(14.6), "15ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1_000), "1.0s");
  assert.equal(formatDuration(3_450), "3.5s");
});

test("intervalUnionDurationMs 合并重叠、相邻和乱序的本地相对区间", () => {
  assert.equal(intervalUnionDurationMs([]), 0);
  assert.equal(intervalUnionDurationMs([
    { offsetMs: 20, durationMs: 10 },
    { offsetMs: 0, durationMs: 15 },
    { offsetMs: 10, durationMs: 15 },
    { offsetMs: 40, durationMs: 0 },
  ]), 30);
});

test("harnessTimingSummary 用区间并集计算分析等待并截断到非负", () => {
  assert.deepEqual(harnessTimingSummary(100, [
    { offsetMs: 0, durationMs: 30 },
    { offsetMs: 20, durationMs: 30 },
    { offsetMs: 80, durationMs: 10 },
  ]), {
    totalMs: 100,
    analysisWaitingMs: 40,
    skillsToolsMs: 60,
  });
  assert.deepEqual(harnessTimingSummary(20, [{ offsetMs: 0, durationMs: 50 }]), {
    totalMs: 20,
    analysisWaitingMs: 0,
    skillsToolsMs: 20,
  });
});

test("新 timing 摘要显示总用时、分析等待和 Skill 工具用时", () => {
  const trace = parseToolTrace({
    status: "completed",
    durationMs: 80,
    timing: {
      totalMs: 3_450,
      analysisWaitingMs: 3_370,
      skillsToolsMs: 80,
    },
    steps: [event("timed", "completed")],
  });

  assert.equal(
    traceSummary(trace),
    "AI 完成 1 个工具步骤 · 总用时 3.5s · 分析与等待 3.4s · Skill/工具 80ms",
  );
  assert.equal(
    traceCardSummary(trace).label,
    "完成 1 个工具步骤 · 总用时 3.5s · 分析与等待 3.4s · Skill/工具 80ms",
  );
});

test("首个工具前失败也能保存诚实的整轮耗时", () => {
  const trace = parseToolTrace({
    status: "failed",
    durationMs: 0,
    timing: {
      totalMs: 2_500,
      analysisWaitingMs: 2_500,
      skillsToolsMs: 0,
    },
    steps: [],
  });

  assert.equal(
    traceSummary(trace),
    "AI 执行失败 · 已完成 0 步 · 总用时 2.5s · 分析与等待 2.5s · Skill/工具 <1ms",
  );
  assert.deepEqual(traceCardSummary(trace), {
    tone: "failed",
    label: "执行失败 · 已完成 0 步 · 总用时 2.5s · 分析与等待 2.5s · Skill/工具 <1ms",
  });
});

const event = (id: string, status: ToolTraceStatus): AgentTraceEvent => ({
  id,
  tool: "analyze_campaign_state",
  title: "运行 1811 规则分析",
  status,
  initiatedBy: "model",
  startedAt: 0,
  durationMs: status === "started" ? undefined : 100,
  summary: status === "started" ? undefined : "完成规则分析",
});

test("trace card summary prioritizes failures and warnings", () => {
  const failedTrace = { status: "failed" as const, durationMs: 300, steps: [event("1", "completed"), event("2", "completed"), event("3", "failed")] };
  const warningTrace = { status: "warning" as const, durationMs: 300, steps: [event("1", "completed"), event("2", "completed"), event("3", "warning")] };
  const completedTrace = { status: "completed" as const, durationMs: 3_800, steps: [event("1", "completed"), event("2", "completed"), event("3", "completed"), event("4", "completed")] };

  assert.deepEqual(traceCardSummary(failedTrace), { tone: "failed", label: "执行失败 · 已完成 2 步 · 步骤跨度 300ms" });
  assert.deepEqual(traceCardSummary(warningTrace), { tone: "warning", label: "完成 3 步 · 1 项需注意 · 步骤跨度 300ms" });
  assert.deepEqual(traceCardSummary(completedTrace), { tone: "success", label: "完成 4 个工具步骤 · 步骤跨度 3.8s" });
});

test("Skill start/finish trace 可以解码并按 id 合并", () => {
  const started = parseAgentTraceEvent(startTraceEvent({
    id: "skill-1",
    tool: SKILL_TRACE_TOOL,
    title: "加载业务规则：ICS-1811 字段解释",
    initiatedBy: "model",
    at: 1_000,
  }));
  const finished = parseAgentTraceEvent(finishTraceEvent(started, {
    status: "completed",
    summary: "已读取这份规则",
    at: 1_075,
  }));
  const steps = mergeTraceEvent(mergeTraceEvent([], started), finished);
  const trace = parseToolTrace({ status: "completed", durationMs: 75, steps });

  assert.equal(trace.steps.length, 1);
  assert.deepEqual(trace.steps[0], {
    id: "skill-1",
    tool: "load_campaign_skill",
    title: "加载业务规则：ICS-1811 字段解释",
    status: "completed",
    initiatedBy: "model",
    startedAt: 1_000,
    summary: "已读取这份规则",
    durationMs: 75,
  });
});

test("Skill warning 计入 warning 卡片摘要", () => {
  const skillWarning = finishTraceEvent(startTraceEvent({
    id: "skill-warning",
    tool: SKILL_TRACE_TOOL,
    title: "加载业务规则：未知规则",
    initiatedBy: "model",
    at: 2_000,
  }), {
    status: "warning",
    summary: "规则没有加载成功",
    at: 2_010,
  });
  const trace = parseToolTrace({
    status: "warning",
    durationMs: 10,
    steps: [skillWarning],
  });

  assert.deepEqual(traceCardSummary(trace), {
    tone: "warning",
    label: "完成 1 步 · 1 项需注意 · 步骤跨度 10ms",
  });
});

test("旧 trace 仍可解码，Skill trace 工具不进入活动工具名单", () => {
  const legacy = parseAgentTraceEvent({
    id: "legacy",
    tool: "build_campaign_readback",
    title: "生成活动复述",
    status: "completed",
    initiatedBy: "orchestrator",
    startedAt: 10,
    summary: "已生成",
    durationMs: 5,
  });

  assert.equal(legacy.tool, "build_campaign_readback");
  assert.equal(CAMPAIGN_TOOL_NAMES.includes(SKILL_TRACE_TOOL as never), false);
});
