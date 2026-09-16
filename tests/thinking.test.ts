import assert from "node:assert/strict";
import test from "node:test";

import { thinkingLabel } from "../app/lib/campaign/ics1811/thinking.ts";

test("the waiting line says what the system will do with this turn, not just 正在思考", () => {
  // 理解首句：还没有任何事实，说清要先把能记的记下来。
  assert.equal(
    thinkingLabel({ turnKind: "interpret", phase: "interpreting", asking: [], hasProposals: false }),
    "正在读你这句话，把能记的先记下来",
  );

  // 上一句有提议：这句话多半是在点头或改提议。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "collecting", asking: ["Q5a", "Q5b"], hasProposals: true }),
    "正在看你同不同意刚才的提议",
  );

  // 只问了一项：直接点名，用 questions.ts 的题面，不现编。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "collecting", asking: ["Q2"], hasProposals: false }),
    "正在把你这句话对到：哪些门店参加？",
  );

  // 问了多项时不堆题面，只报数，免得这行字比对话还长。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "collecting", asking: ["Q1", "Q5a", "Q6a"], hasProposals: false }),
    "正在把你这句话对到刚才问的 3 件事上",
  );

  // 没在问什么：记下来，再看还差什么。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "blocked", asking: [], hasProposals: false }),
    "正在记下来，看看还差什么",
  );

  // 已经建好：这一轮是在改，填写值跟着变，不再说「重新复述」。
  const ready = thinkingLabel({ turnKind: "text", phase: "ready", asking: [], hasProposals: false });
  assert.equal(ready, "正在按你说的改，填写值会跟着更新");
  assert.doesNotMatch(ready, /复述|确认/);
});

test("a long question title is trimmed so the waiting line stays one line", () => {
  // Q3b 的题面是一整句话，直接拼进去会比对话还长。
  const label = thinkingLabel({ turnKind: "text", phase: "collecting", asking: ["Q3b"], hasProposals: false });
  assert.ok(label.startsWith("正在把你这句话对到："), label);
  assert.ok([...label].length <= 36, `等待文案不能超过 36 字，现在 ${[...label].length} 字：${label}`);
  assert.ok(label.endsWith("…"), "截断要留省略号");
});
