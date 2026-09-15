import assert from "node:assert/strict";
import test from "node:test";

import { applyCardAnswers } from "../app/lib/campaign/ics1811/card.ts";
import { checkDraft } from "../app/lib/campaign/ics1811/checks.ts";
import { deriveFill } from "../app/lib/campaign/ics1811/derive.ts";
import { EXAMPLE_TODAY, EXAMPLES, type Example } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { ACTIVITY_FIELDS, DETAIL_READBACK_PROBES, renderFillSheet } from "../app/lib/campaign/ics1811/fill-sheet.ts";
import { planNext } from "../app/lib/campaign/ics1811/questions.ts";
import { buildReadback } from "../app/lib/campaign/ics1811/readback.ts";
import type { Ics1811Draft, QuestionId } from "../app/lib/campaign/ics1811/types.ts";

const today = EXAMPLE_TODAY;

function evaluate(draft: Ics1811Draft, roundsUsed: number, asked: QuestionId[]) {
  const fill = deriveFill(draft);
  const checks = checkDraft(draft, fill, today);
  return { fill, checks, plan: planNext(draft, fill, checks, roundsUsed, asked) };
}

// 不接模型：夹具里的 writes 代替模型抽取，按轮次把回答交给守卫或卡片。
function simulate(example: Example) {
  let draft = applyFactWrites(createEmptyDraft(example.id, example.first), example.firstWrites, { text: example.first, today }).draft;
  const rounds: QuestionId[][] = [];
  let roundsUsed = 0;
  let asked: QuestionId[] = [];
  let state = evaluate(draft, roundsUsed, asked);
  for (const turn of example.turns) {
    assert.equal(state.plan.action, "ask", `${example.id}：还有回答没用上就进入了复述`);
    if (state.plan.action !== "ask") break;
    asked = state.plan.questions.map((question) => question.id);
    rounds.push(asked);
    roundsUsed = state.plan.round;
    draft = turn.kind === "text"
      ? applyFactWrites(draft, turn.writes, { text: turn.text, today, openQuestions: asked }).draft
      : applyCardAnswers(draft, turn.answers).draft;
    state = evaluate(draft, roundsUsed, asked);
  }
  const missing = state.plan.action === "readback" ? state.plan.missing : [];
  return { draft, rounds, ...state, readback: buildReadback(draft, state.fill, state.checks, missing) };
}

const run = (id: string) => simulate(EXAMPLES.find((example) => example.id === id)!);

const EXPECTED_ROUNDS: Record<string, QuestionId[][]> = {
  T1: [],
  T2: [["Q1", "Q5a", "Q5b", "Q6a"]],
  T3: [["Q1", "Q4", "Q5a", "Q5b", "Q6a"]],
  T4: [["Q4", "Q5a", "Q5b", "Q6a"]],
  T5: [["Q3", "Q5a", "Q5b", "Q6a"], ["Q3b"]],
  T6: [["Q3c", "Q5a", "Q5b", "Q6a"]],
  T7: [["Q4", "Q5a", "Q5b", "Q6a"], ["Q4a"]],
  T8: [["Q3d", "Q5b", "Q5c", "Q6a"]],
  T9: [["Q6b"]],
  T10: [["Q3b"]],
};

test("every acceptance case asks the SOP questions in at most two rounds and ends in a confirmable readback", () => {
  for (const example of EXAMPLES) {
    const result = simulate(example);
    assert.deepEqual(result.rounds, EXPECTED_ROUNDS[example.id], example.id);
    assert.ok(result.rounds.length <= 2, example.id);
    assert.equal(result.plan.action, "readback", example.id);
    assert.equal(result.plan.action === "readback" && result.plan.canConfirm, true, `${example.id}：${JSON.stringify(result.checks)}`);
  }
});

test("T1 matches the SOP readback example field by field", () => {
  const { fill, readback } = run("T1");
  const info = fill.info;
  assert.deepEqual(
    [info.name.value, info.content.value, info.startDate.value, info.endDate.value, info.channel.value, info.offerNature.value, info.brand.value, info.approvalFlow.value, info.cycle.value, info.region.value, info.branches.value, info.commission.value, info.slogan.value],
    ["黄金每克减15", "一般足金类黄金每克减15元", "2027-05-01", "2027-05-05", "2)线下活动", "1)营销活动", "周大福", "1 周大福审批", "0", "214)闽深区", ["7590"], "不计算折上折", ""],
  );
  const [detail] = fill.details;
  assert.equal(fill.details.length, 1);
  assert.deepEqual([detail.mode.value, detail.offerType.value, detail.params[0].value.value, detail.categories.value, detail.businessCategory.value, detail.concessionRate.value, detail.collectionRate.value], ["固定折扣模式", "金价每克减免", 15, ["一般足金类"], "黄金类", 0, 0]);
  assert.equal(fill.activityGroup.value, "3)其它优惠");
  for (const phrase of ["优惠类型「金价每克减免」", "按实际克重每克减 15 元", "不是按整克计算", "周期填 0", "闽深区 7590 门店", "付款方式按默认（含 GLP 积分抵现）", "销售提成按实际售价计算", "不加活动标语", "活动分组保持默认", "2027 年 5 月 1 日至 5 月 5 日"]) {
    assert.ok(readback.paragraph.includes(phrase), phrase);
  }
});

test("special campaigns get fixed options, split details and 1815 follow-ups", () => {
  const platinum = run("T2");
  const [p] = platinum.fill.details;
  assert.deepEqual([p.offerType.value, p.params.map((param) => [param.label, param.value.value]), p.categories.value, p.headCodes.value, p.businessCategory.value], ["铂金换购特殊营销折扣", [["开单折扣", 0.9], ["判断金额", 2]], ["不适用"], ["HP"], "素金类"]);
  assert.equal(platinum.fill.info.commission.value, "计算折上折");
  assert.equal(platinum.fill.activityGroup.value, "17)货品回购");
  assert.ok(platinum.fill.postActions.some((action) => action.id === "group_17"));

  const gold = run("T3");
  assert.deepEqual(gold.fill.details.map((detail) => detail.params.map((param) => param.value.value)), [[0.5, 0.8], [1, 0]], "免工费的开单折扣 0 合法");
  assert.ok(gold.fill.postActions.some((action) => action.id === "group_19"));

  const diamondGold = run("T4");
  assert.deepEqual(diamondGold.fill.details.map((detail) => [detail.offerType.value, detail.params[0].value.value, detail.categories.value]), [["买钻石享黄金克减", 1, ["钻石类"]], ["金价每克减免", 20, ["一般足金类"]]]);
});

test("follow-up answers decide the discount mode, the threshold type and the menu conversion", () => {
  const discount = run("T5");
  assert.deepEqual([discount.fill.details[0].mode.value, discount.fill.details[0].priceTypes], ["浮动折扣模式", null]);

  const threshold = run("T6");
  const [detail] = threshold.fill.details;
  assert.equal(detail.offerType.value, "每满减");
  assert.ok(detail.params.every((param) => param.inferred), "满减类参数栏标推断");
  assert.deepEqual(detail.restrictions.map((item) => [item.label, item.value.value]), [["整单金额下限", "0"]]);
  assert.ok(threshold.readback.paragraph.includes("每满 5000 减 500，满 10000 减 1000"));

  const outlet = run("T7");
  assert.deepEqual([outlet.fill.info.productScope.value, outlet.fill.info.menuConversion.value, outlet.fill.info.menuConversion.source], ["1 outlet货品", "1 outlet餐牌", "user"]);
});

test("multi-store settlement letters, verbatim slogans and float-mode price types", () => {
  const stores = run("T8");
  assert.deepEqual(stores.fill.settlement?.fileNames, ["闽深A区7590东门鸿展11月", "闽深A区3145东莞国贸11月", "闽深A区3154惠州华贸11月"]);
  assert.ok(stores.fill.postActions.some((action) => action.id === "upload_settlement"));

  assert.equal(run("T9").fill.info.slogan.value, "足金每克立减十五元");

  const t10 = EXAMPLES.find((example) => example.id === "T10")!;
  const priceTypes = simulate(t10);
  const first = applyFactWrites(createEmptyDraft("T10", t10.first), t10.firstWrites, { text: t10.first, today }).draft;
  const firstPlan = evaluate(first, 0, []).plan;
  assert.ok(firstPlan.action === "ask" && firstPlan.questions[0].hint?.includes("限定不了售价类型"));
  assert.ok(priceTypes.readback.paragraph.includes("「一口价」这条限定录不进去"));
  assert.equal(priceTypes.readback.paragraph.includes("不限号头、会员级别、售价类型"), false);
});

test("a third card is never issued; missing human answers block the readback", () => {
  const text = "7590门店钻石类打9折";
  const draft = applyFactWrites(createEmptyDraft("x", text), [
    { key: "stores", quote: "7590门店", value: ["7590门店"] },
    { key: "categories", quote: "钻石类", value: ["钻石类"] },
    { key: "offer", quote: "打9折" },
  ], { text, today }).draft;
  const first = evaluate(draft, 0, []).plan;
  assert.ok(first.action === "ask" && first.round === 1);
  const second = evaluate(draft, 1, first.action === "ask" ? first.questions.map((question) => question.id) : []).plan;
  assert.ok(second.action === "ask" && second.round === 2 && second.questions.every((question) => question.repeated));
  const third = evaluate(draft, 2, []).plan;
  assert.equal(third.action, "readback");
  assert.ok(third.action === "readback" && !third.canConfirm && third.missing.length > 0);
  assert.ok(third.action === "readback" && third.blockers.some((check) => check.id === "V-A08"));
});

test("human-decided fields never come from defaults or rules", () => {
  const human = ACTIVITY_FIELDS.filter((spec) => spec.owner === "人定").map((spec) => spec.key);
  for (const example of EXAMPLES) {
    const { fill } = simulate(example);
    for (const key of human) assert.ok(["user", "pending"].includes(fill.info[key].source), `${example.id} ${key}`);
    for (const detail of fill.details) {
      for (const param of detail.params) assert.equal(param.value.source, "user", `${example.id} ${param.label}`);
      if (!detail.categories.basis.includes("固定")) assert.equal(detail.categories.source, "user", `${example.id} 货类`);
      assert.deepEqual([detail.concessionRate.source, detail.collectionRate.source], ["user", "user"], example.id);
    }
  }
});

test("the readback mentions every AI-decided and to-be-confirmed field", () => {
  for (const example of EXAMPLES) {
    const { readback } = simulate(example);
    for (const probe of [...ACTIVITY_FIELDS.map((spec) => spec.readbackProbe), ...DETAIL_READBACK_PROBES]) {
      assert.ok(readback.paragraph.includes(probe), `${example.id} 复述缺少「${probe}」`);
    }
  }
});

test("the fill sheet follows the 1811 page order and carries the self-check list", () => {
  const { fill, checks } = run("T1");
  const sheet = renderFillSheet(fill, checks);
  assert.deepEqual(sheet.info.map((item) => item.label), ACTIVITY_FIELDS.map((spec) => spec.label));
  assert.deepEqual(sheet.details[0].rows.map((item) => item.label).slice(0, 4), ["折扣模式", "优惠类型", "优惠金额", "货类"]);
  assert.deepEqual(sheet.selfCheck.map((item) => item.item), ["活动名称", "活动标语", "支付方式", "周期", "让扣点、回款率", "不允许货组", "完成新增", "特殊活动分组"]);
});

test("a request without any priced rule is out of scope", () => {
  const text = "国庆节做个抽奖活动";
  const draft = createEmptyDraft("y", text);
  assert.equal(evaluate(draft, 0, []).plan.action, "out_of_scope");
});
