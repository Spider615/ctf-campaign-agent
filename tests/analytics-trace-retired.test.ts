import assert from "node:assert/strict";
import test from "node:test";
import { isAgentTraceEvent } from "../app/lib/tool-trace.ts";
import { publicAnalyticsTrace } from "../app/lib/analytics/trace.ts";
import { RETIRED_GENERAL_ANALYTICS_TOOLS } from "../app/lib/analytics/tool-names.ts";

const event = (tool: string) => ({ id: `step-${tool}`, tool, title: "旧会话步骤", status: "completed", initiatedBy: "model", startedAt: 1, summary: "已完成", durationMs: 5 });

test("已下线的通用分析工具名仍能解码旧会话里存档的过程记录", () => {
  assert.ok(RETIRED_GENERAL_ANALYTICS_TOOLS.includes("submit_analysis" as never));
  for (const tool of RETIRED_GENERAL_ANALYTICS_TOOLS) {
    assert.equal(isAgentTraceEvent(event(tool)), true, tool);
    assert.equal(publicAnalyticsTrace(event(tool)).tool, tool);
  }
});

test("不在白名单里的工具名过程记录被拒绝", () => {
  assert.equal(isAgentTraceEvent(event("not_a_real_tool")), false);
  assert.throws(() => publicAnalyticsTrace(event("not_a_real_tool")));
});
