import assert from "node:assert/strict";
import test from "node:test";

import { thinkingLabel } from "../app/lib/campaign/ics1811/thinking.ts";

test("the waiting line says what the system will do with this turn, not just 正在思考", () => {
  // 理解首句：还没有任何事实，说清要从这句话里找什么。
  assert.equal(
    thinkingLabel({ turnKind: "interpret", phase: "interpreting", openQuestions: [], missingIds: [] }),
    "正在读你这句话，找日期、门店、优惠和货类",
  );

  // 追问开着：说清这句话会被对到几个还没答的问题上。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "asking", openQuestions: ["Q1", "Q5a", "Q6a"], missingIds: [] }),
    "正在把你这句话对到还没答的 3 个问题上",
  );

  // 两轮用完、只缺一项：直接点名缺的是什么，用 questions.ts 的题面，不现编。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "blocked", openQuestions: [], missingIds: ["Q2"] }),
    "正在看这句能不能补上：哪些门店参加？",
  );

  // 缺多项时不堆题面，只报数，免得这行字比对话还长。
  assert.equal(
    thinkingLabel({ turnKind: "text", phase: "blocked", openQuestions: [], missingIds: ["Q2", "Q5a", "Q6a"] }),
    "正在看这句能补上哪几项（还缺 3 项）",
  );

  // 已经复述过：这一轮是在改，改完会重新复述。
  for (const phase of ["readback", "confirmed"] as const) {
    assert.equal(
      thinkingLabel({ turnKind: "text", phase, openQuestions: [], missingIds: [] }),
      "正在按你说的改，改完会重新复述",
    );
  }

  // 确认：说清接下来按什么顺序产出。
  assert.equal(
    thinkingLabel({ turnKind: "confirm", phase: "readback", openQuestions: [], missingIds: [] }),
    "正在按 1811 页面顺序生成逐项填写值",
  );
});

test("a long question title is trimmed so the waiting line stays one line", () => {
  // Q3b 的题面是一整句话，直接拼进去会比对话还长。
  const label = thinkingLabel({ turnKind: "text", phase: "blocked", openQuestions: [], missingIds: ["Q3b"] });
  assert.ok(label.startsWith("正在看这句能不能补上："), label);
  assert.ok([...label].length <= 36, `等待文案不能超过 36 字，现在 ${[...label].length} 字：${label}`);
  assert.ok(label.endsWith("…"), "截断要留省略号");
});
