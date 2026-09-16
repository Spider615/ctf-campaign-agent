import assert from "node:assert/strict";
import test from "node:test";

import { decodeAgentStreamLine, encodeAgentStreamEvent, type AgentStreamEvent } from "../app/lib/agent/stream.ts";
import type { AgentTraceEvent } from "../app/lib/tool-trace.ts";

const completedEvent: AgentTraceEvent = {
  id: "trace-1",
  tool: "extract_campaign_facts",
  title: "提取活动信息",
  status: "completed",
  initiatedBy: "model",
  startedAt: 100,
  durationMs: 80,
  summary: "识别并核验 8 项信息",
};

test("agent stream events survive line encoding", () => {
  const source: AgentStreamEvent = { type: "trace", event: completedEvent };

  assert.deepEqual(decodeAgentStreamLine(encodeAgentStreamEvent(source).trim()), source);
});

test("decoder rejects a result without the existing AgentResult guards", () => {
  assert.throws(() => decodeAgentStreamLine('{"type":"result","result":{}}'), /不完整/);
});

test("decoder rejects unknown and oversized stream lines", () => {
  assert.throws(() => decodeAgentStreamLine('{"type":"secret","value":"nope"}'), /事件/);
  assert.throws(() => decodeAgentStreamLine(`{"type":"error","error":"${"x".repeat(300_000)}"}`), /过长/);
});
