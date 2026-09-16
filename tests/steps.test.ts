import assert from "node:assert/strict";
import test from "node:test";

import { campaignSteps } from "../app/lib/campaign/ics1811/steps.ts";

const at = (steps: ReturnType<typeof campaignSteps>, key: string) => steps.find((step) => step.key === key)!;

test("the step rail shows which stage the activity is being built in", () => {
  // 刚建会话，还在理解首句。
  const interpreting = campaignSteps({ phase: "interpreting", roundsUsed: 0, missingCount: 0 });
  assert.deepEqual(interpreting.map((step) => step.key), ["brief", "analyze", "collect", "review", "output"]);
  assert.equal(at(interpreting, "brief").state, "done");
  assert.equal(at(interpreting, "analyze").state, "current");
  assert.equal(at(interpreting, "collect").state, "todo");

  // 追问中：说清在第几轮，最多两轮。
  const asking = campaignSteps({ phase: "asking", roundsUsed: 1, missingCount: 4 });
  assert.equal(at(asking, "brief").state, "done");
  assert.equal(at(asking, "collect").state, "current");
  assert.equal(at(asking, "collect").detail, "第 1 轮 · 最多 2 轮");

  // 两轮用完仍缺：停在补齐这一步，并说明还差几项。
  const blocked = campaignSteps({ phase: "blocked", roundsUsed: 2, missingCount: 1 });
  assert.equal(at(blocked, "collect").state, "current");
  assert.equal(at(blocked, "collect").detail, "还差 1 项");
  assert.equal(at(blocked, "review").state, "todo");

  // 复述待确认。
  const readback = campaignSteps({ phase: "readback", roundsUsed: 1, missingCount: 0 });
  assert.equal(at(readback, "collect").state, "done");
  assert.equal(at(readback, "review").state, "current");
  assert.equal(at(readback, "output").state, "todo");

  // 已确认，填写值已生成。
  const confirmed = campaignSteps({ phase: "confirmed", roundsUsed: 1, missingCount: 0 });
  for (const key of ["brief", "analyze", "collect", "review", "output"]) {
    assert.equal(at(confirmed, key).state, "done", `${key} 应为已完成`);
  }
});

test("an out-of-scope activity does not pretend the build is under way", () => {
  const steps = campaignSteps({ phase: "out_of_scope", roundsUsed: 0, missingCount: 0 });
  assert.equal(at(steps, "brief").state, "current");
  for (const key of ["analyze", "collect", "review", "output"]) {
    assert.equal(at(steps, key).state, "todo", `${key} 不该显示为进行中`);
  }
});

test("every step carries a label a 运营 can read", () => {
  for (const step of campaignSteps({ phase: "asking", roundsUsed: 1, missingCount: 2 })) {
    assert.ok(step.label.length > 0, `${step.key} 缺标签`);
    assert.ok([...step.label].length <= 6, `${step.key} 标签太长：${step.label}`);
  }
});
