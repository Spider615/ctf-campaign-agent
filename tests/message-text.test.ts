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

  assert.equal(messageToText({ v: 2, kind: "agent_tool_trace", trace }), "AI 完成 1 个工具步骤 · 步骤跨度 80ms");
});

test("malformed stored tool traces fall back to a safe legacy message", () => {
  const decoded = decodeMessage("assistant", JSON.stringify({
    v: 2,
    kind: "agent_tool_trace",
    trace: { status: "completed", durationMs: -1, steps: [] },
  }));

  assert.equal(decoded.kind, "agent_text");
});

test("让扣点回款率写成人说的百分数，换大比例也是；名称改动写实际文字，货类分组分开写", async () => {
  const { EXAMPLES } = await import("../app/lib/campaign/ics1811/examples.ts");
  const { factText } = await import("../app/lib/campaign/ics1811/messages.ts");
  const { deriveFill } = await import("../app/lib/campaign/ics1811/derive.ts");
  const today = "2026-09-16";
  const t1 = EXAMPLES[0];
  const base = applyFactWrites(createEmptyDraft("t1", t1.first), t1.firstWrites, { text: t1.first, today }).draft;

  const text = "让扣点2%，回款率98%";
  const rated = applyFactWrites(base, [{ key: "rates", quote: text }], { text, today }).draft;
  assert.equal(factText("rates", rated.facts.rates), "让扣点 2%（填 0.02），回款率 98%（填 0.98）");
  assert.equal(factText("rates", base.facts.rates), "让扣点 0，回款率 0", "没有就写 0，不写成 0%（填 0）");

  // 起草名称时，改前写模板拼出来的实际名称，不写「按模板生成」。
  const drafted = { ...base, copy: { name: "足金每克减15元", content: "一般足金类黄金每克减15元", source: "ai" as const } };
  assert.deepEqual(summarizeFactChanges(base, drafted), [{ label: "活动名称", before: "黄金每克减15", after: "足金每克减15元" }]);
  // 没起草过时，模板名称跟着优惠变不单独算一处改动。
  const t1Twenty = "改成每克减20元";
  const twenty = applyFactWrites(base, [{ key: "offer", quote: "每克减20元" }], { text: t1Twenty, today }).draft;
  assert.deepEqual(summarizeFactChanges(base, twenty).map((item) => item.label), ["优惠"]);

  // 黄金以旧换新：换大比例存 0.5，给人看写 50%。
  const t3 = EXAMPLES.find((item) => item.id === "T3")!;
  const tradein = applyFactWrites(createEmptyDraft("t3", t3.first), t3.firstWrites, { text: t3.first, today }).draft;
  assert.match(deriveFill(tradein).info.content.value, /换大50%工费8折换大100%免工费/);
  assert.match(factText("offer", tradein.facts.offer), /换大 50%/);

  // 买钻石享黄金克减的两组货类分开写，提议和改动里才看得出是哪一组。
  assert.equal(factText("categories", { value: { diamond: ["钻石类"], gold: ["一般足金类"] }, quote: "卡片：Q4", via: "card" }), "钻石：钻石类；黄金：一般足金类");
  assert.equal(factText("categories", { value: { all: ["一般足金类"] }, quote: "一般足金类", via: "text" }), "一般足金类");
});
