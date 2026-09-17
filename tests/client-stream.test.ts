import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../app/lib/client/api.ts";
import { consumeTurnStream } from "../app/lib/client/stream.ts";
import type { Snapshot } from "../app/lib/server/turns.ts";
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
const snapshot = { session: { id: "session-1" } } as unknown as Snapshot;

const responseFrom = (chunks: string[], init: ResponseInit = {}) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}), { headers: { "content-type": "application/x-ndjson" }, ...init });

test("browser decoder handles split JSON lines and returns the final snapshot", async () => {
  const chunks = [
    '{"type":"trace","event":',
    `${JSON.stringify(completedEvent)}}\n{"type":"snapshot","snapshot":${JSON.stringify(snapshot)}}\n`,
  ];
  const seen: AgentTraceEvent[] = [];

  const result = await consumeTurnStream(responseFrom(chunks), { onTrace: (event) => seen.push(event) });

  assert.deepEqual(seen, [completedEvent]);
  assert.deepEqual(result, snapshot);
});

test("browser decoder accepts a final snapshot line without a trailing newline", async () => {
  const result = await consumeTurnStream(responseFrom([JSON.stringify({ type: "snapshot", snapshot })]), {});
  assert.deepEqual(result, snapshot);
});

test("browser decoder surfaces HTTP and streamed errors as ApiError", async () => {
  await assert.rejects(
    () => consumeTurnStream(new Response(JSON.stringify({ error: "页面已更新" }), { status: 409, headers: { "content-type": "application/json" } }), {}),
    (error: unknown) => error instanceof ApiError && error.status === 409 && error.message === "页面已更新",
  );
  await assert.rejects(
    () => consumeTurnStream(responseFrom([`${JSON.stringify({ type: "error", error: "Agent 超时了" })}\n`]), {}),
    (error: unknown) => error instanceof ApiError && error.message === "Agent 超时了",
  );
});

test("browser decoder rejects a stream that ends before its snapshot", async () => {
  await assert.rejects(
    () => consumeTurnStream(responseFrom([`${JSON.stringify({ type: "trace", event: completedEvent })}\n`]), {}),
    /没有返回最终结果/,
  );
});

test("browser decoder forwards phases, reply deltas, and resets in order", async () => {
  const chunks = [[
    JSON.stringify({ type: "phase", phase: "analyzing", at: 100 }),
    JSON.stringify({ type: "text_delta", delta: "活动已" }),
    JSON.stringify({ type: "text_delta", delta: "建好。" }),
    JSON.stringify({ type: "text_reset" }),
    JSON.stringify({ type: "phase", phase: "writing", at: 130 }),
    JSON.stringify({ type: "snapshot", snapshot }),
  ].join("\n") + "\n"];
  const seen: string[] = [];

  await consumeTurnStream(responseFrom(chunks), {
    onPhase: (phase) => seen.push(`phase:${phase}`),
    onTextDelta: (delta) => seen.push(`delta:${delta}`),
    onTextReset: () => seen.push("reset"),
  });

  assert.deepEqual(seen, ["phase:analyzing", "delta:活动已", "delta:建好。", "reset", "phase:writing"]);
});

test("browser decoder treats errors as terminal", async () => {
  await assert.rejects(
    () => consumeTurnStream(responseFrom([[
      JSON.stringify({ type: "error", error: "Agent 超时了" }),
      JSON.stringify({ type: "snapshot", snapshot }),
    ].join("\n") + "\n"]), {}),
    /Agent 超时了/,
  );
});
