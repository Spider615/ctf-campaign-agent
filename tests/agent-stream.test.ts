import assert from "node:assert/strict";
import test from "node:test";

import { advanceAgentStreamLifecycle, decodeAgentStreamLine, encodeAgentStreamEvent, type AgentStreamEvent } from "../app/lib/agent/stream.ts";
import { createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
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

test("agent stream accepts public phase and reply events", () => {
  const events: AgentStreamEvent[] = [
    { type: "phase", phase: "analyzing", at: 100 },
    { type: "phase", phase: "writing", at: 120 },
    { type: "text_delta", delta: "活动已建好。" },
    { type: "text_reset" },
  ];

  for (const event of events) {
    assert.deepEqual(decodeAgentStreamLine(encodeAgentStreamEvent(event).trim()), event);
  }
});

test("agent stream error can carry same-process timing", () => {
  const source: AgentStreamEvent = {
    type: "error",
    error: "Agent 超时了，请重试",
    timing: { totalMs: 3_000, analysisWaitingMs: 2_900, skillsToolsMs: 100 },
  };

  assert.deepEqual(decodeAgentStreamLine(encodeAgentStreamEvent(source).trim()), source);
});

test("agent stream rejects every event after a terminal result", () => {
  const result = decodeAgentStreamLine(encodeAgentStreamEvent({
    type: "result",
    result: {
      draft: createEmptyDraft("draft", "测试活动"),
      applied: [],
      dropped: [],
      reply: "好",
      copyDrafted: false,
      undo: false,
      asking: null,
      proposals: [],
      tools: [],
      trace: null,
    },
  }).trim());

  assert.equal(advanceAgentStreamLifecycle("open", result), "result");
  assert.throws(
    () => advanceAgentStreamLifecycle("result", { type: "text_delta", delta: "不该再出现" }),
    /最终结果之后/,
  );
  assert.throws(
    () => advanceAgentStreamLifecycle("result", { type: "error", error: "也不能反悔" }),
    /最终结果之后/,
  );
});

test("agent stream rejects private or malformed reply events", () => {
  assert.throws(() => decodeAgentStreamLine('{"type":"thinking_delta","delta":"secret"}'), /事件/);
  assert.throws(() => decodeAgentStreamLine('{"type":"text_delta","delta":""}'), /事件/);
  assert.throws(() => decodeAgentStreamLine('{"type":"phase","phase":"thinking","at":1}'), /事件/);
});

test("decoder rejects a result without the existing AgentResult guards", () => {
  assert.throws(() => decodeAgentStreamLine('{"type":"result","result":{}}'), /不完整/);
});

test("decoder rejects unknown and oversized stream lines", () => {
  assert.throws(() => decodeAgentStreamLine('{"type":"secret","value":"nope"}'), /事件/);
  assert.throws(() => decodeAgentStreamLine(`{"type":"error","error":"${"x".repeat(300_000)}"}`), /过长/);
});
