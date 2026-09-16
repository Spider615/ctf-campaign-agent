import assert from "node:assert/strict";
import test from "node:test";

import { finishTraceEvent, mergeTraceEvent, startTraceEvent, traceCardSummary, traceSummary, type AgentTraceEvent, type ToolTraceStatus } from "../app/lib/tool-trace.ts";

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

  assert.equal(traceSummary(trace), "AI 完成 1 个工具步骤 · 0.1 秒");
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

  assert.deepEqual(traceCardSummary(failedTrace), { tone: "failed", label: "执行失败 · 已完成 2 步" });
  assert.deepEqual(traceCardSummary(warningTrace), { tone: "warning", label: "完成 3 步 · 1 项需注意" });
  assert.deepEqual(traceCardSummary(completedTrace), { tone: "success", label: "完成 4 个工具步骤 · 3.8 秒" });
});
