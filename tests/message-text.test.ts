import assert from "node:assert/strict";
import test from "node:test";

import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { decodeMessage, messageToText, summarizeFactChanges } from "../app/lib/campaign/ics1811/messages.ts";
import { finishTraceEvent, startTraceEvent } from "../app/lib/tool-trace.ts";

test("chat messages copy what the chat shows", () => {
  assert.equal(messageToText({ v: 2, kind: "user_text", text: "7590门店钻石类打9折" }), "7590门店钻石类打9折");
  assert.equal(
    messageToText({ v: 2, kind: "agent_round_card", round: 2, questions: [{ id: "Q1", title: "活动从哪天到哪天？" }, { id: "Q6a", title: "要不要活动标语？法务确认过没有？" }] }),
    "第 2 轮，还需要你补充：\n- 活动从哪天到哪天？\n- 要不要活动标语？法务确认过没有？",
  );
  assert.equal(
    messageToText({
      v: 2,
      kind: "agent_change",
      title: "改了 2 处",
      items: [{ label: "活动日期", before: "未填", after: "2026-10-01 至 2026-10-07" }, { label: "活动标语", before: "未填", after: "不加" }],
      versionSeq: 3,
    }),
    "改了 2 处\n活动日期：未填 → 2026-10-01 至 2026-10-07\n活动标语：未填 → 不加",
  );
});

test("change summaries name code-table values instead of showing codes", () => {
  const text = "只做outlet货品";
  const before = createEmptyDraft("m", text);
  const after = applyFactWrites(before, [{ key: "productScope", quote: text }], { text, today: "2026-09-16" }).draft;
  const [item] = summarizeFactChanges(before, after);
  assert.equal(item.label, "货品范围");
  assert.doesNotMatch(item.after, /^\d+$/);
  assert.match(item.after, /outlet/i);
});

test("stored tool traces copy as a short history line", () => {
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

  assert.equal(messageToText({ v: 2, kind: "agent_tool_trace", trace }), "AI 完成 1 个工具步骤 · 0.1 秒");
});

test("malformed stored tool traces fall back to a safe legacy message", () => {
  const decoded = decodeMessage("assistant", JSON.stringify({
    v: 2,
    kind: "agent_tool_trace",
    trace: { status: "completed", durationMs: -1, steps: [] },
  }));

  assert.equal(decoded.kind, "agent_text");
});
