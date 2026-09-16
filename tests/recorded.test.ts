import assert from "node:assert/strict";
import test from "node:test";

import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { recordedSoFar } from "../app/lib/campaign/ics1811/recorded.ts";

const t1 = EXAMPLES[0];
const draftOf = (writes: typeof t1.firstWrites, text: string) =>
  applyFactWrites(createEmptyDraft("r", text), writes, { text, today: "2026-09-16" }).draft;

test("a fresh activity has nothing recorded yet", () => {
  assert.deepEqual(recordedSoFar(createEmptyDraft("empty", "想做个活动")), []);
});

test("追问时能说清已经记下了什么，用户才看得见进度", () => {
  const recorded = recordedSoFar(draftOf(t1.firstWrites, t1.first));
  // 用 FACT_LABEL 的中文标签，不是 key，运营才看得懂。
  for (const label of ["活动日期", "门店", "优惠", "货类", "让扣点和回款率", "提成口径", "活动标语"]) {
    assert.ok(recorded.includes(label), `应该记下了「${label}」：${recorded.join("、")}`);
  }
  // 没说过的不许出现。
  for (const label of ["结算说明函", "会员级别", "售价类型"]) {
    assert.ok(!recorded.includes(label), `没说过的「${label}」不该出现`);
  }
});

test("顺序固定，不随对象键的枚举顺序漂移", () => {
  const draft = draftOf(t1.firstWrites, t1.first);
  assert.deepEqual(recordedSoFar(draft), recordedSoFar(structuredClone(draft)));
  // 日期排在门店前面，和问题目录的顺序一致。
  const recorded = recordedSoFar(draft);
  assert.ok(recorded.indexOf("活动日期") < recorded.indexOf("门店"));
});
