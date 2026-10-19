import assert from "node:assert/strict";
import test from "node:test";
import { planAnswerText, validatePlanAnswer } from "../app/lib/analytics/plan/answer.ts";
import type { PlanAnswer } from "../app/lib/analytics/analysis-v2-types.ts";
import { simulatedPlanAnswer } from "./helpers/plan-answer.ts";

// v3 答案的组装已下线（新答案是 v4 正文），这里只保留旧会话显示要用的校验和纯文本。
const answer = (): PlanAnswer => ({
  ...simulatedPlanAnswer(),
  headline: { text: "七夕日均实收高 +50.00元/日", factIds: ["amount"], confidence: "kept" },
  claims: [{ text: "单数也增加", factIds: ["amount"], confidence: "unchecked" }],
  actions: ["备货"], cannotConclude: ["缺少门店口径"], questions: [], assumptions: ["口径待确认：单数，成交单数"],
});

test("validatePlanAnswer 拒绝引用不存在事实、旧版本与超限", () => {
  const roundTrip = validatePlanAnswer(JSON.parse(JSON.stringify(answer())));
  assert.equal(roundTrip.headline!.text, "七夕日均实收高 +50.00元/日");
  const copy = () => JSON.parse(JSON.stringify(answer()));
  const bad = copy(); bad.claims[0].factIds = ["nope"]; assert.throws(() => validatePlanAnswer(bad), /不存在的事实/);
  const badSchema = copy(); badSchema.schema = "analysis-answer/v2"; assert.throws(() => validatePlanAnswer(badSchema), /版本/);
  const v4 = copy(); v4.schema = "analysis-answer/v4"; assert.throws(() => validatePlanAnswer(v4), /版本/);
  const tooMany = copy(); tooMany.cannotConclude = ["1", "2", "3", "4", "5", "6"]; assert.throws(() => validatePlanAnswer(tooMany), /最多/);
  const nonString = copy(); nonString.actions = [1]; assert.throws(() => validatePlanAnswer(nonString), /文字/);
  const manyClaims = copy(); manyClaims.claims = Array.from({ length: 6 }, () => manyClaims.headline); assert.throws(() => validatePlanAnswer(manyClaims), /最多/);
  const badEvidence = copy(); badEvidence.evidence.facts[0].frameId = "missing"; assert.throws(() => validatePlanAnswer(badEvidence));
  const noHeadline = copy(); delete noHeadline.headline; assert.throws(() => validatePlanAnswer(noHeadline), /状态与主结论不一致/);
  const badFigure = copy(); badFigure.figures.rows[0].factIds = ["ghost"]; assert.throws(() => validatePlanAnswer(badFigure), /不存在的事实/);
});

test("planAnswerText 依次拼出主结论、关键数据、结论、行动、不能下结论和待确认口径", () => {
  const text = planAnswerText(answer());
  assert.ok(text.startsWith("七夕日均实收高 +50.00元/日"));
  for (const part of ["1,234.56元", "单数也增加", "备货", "缺少门店口径", "口径待确认：单数"]) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf("备货") < text.indexOf("缺少门店口径"));
});
