import assert from "node:assert/strict";
import test from "node:test";

import { applyCardAnswers } from "../app/lib/campaign/ics1811/card.ts";
import { checkDraft } from "../app/lib/campaign/ics1811/checks.ts";
import { deriveFill } from "../app/lib/campaign/ics1811/derive.ts";
import { EXAMPLE_TODAY, EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { renderFillSheet } from "../app/lib/campaign/ics1811/fill-sheet.ts";
import type { FillModel, Ics1811Draft, QuestionId } from "../app/lib/campaign/ics1811/types.ts";

const today = EXAMPLE_TODAY;
const ALL_OPEN: QuestionId[] = ["Q1", "Q2", "Q3", "Q3a", "Q3b", "Q3c", "Q3d", "Q3e", "Q4", "Q4a", "Q5a", "Q5b", "Q5c", "Q6a", "Q6b"];

// 走完某个用例的全部回答，得到一份没有任何阻断的草稿，再在上面构造违规。
function completed(id: string): Ics1811Draft {
  const example = EXAMPLES.find((item) => item.id === id)!;
  let draft = applyFactWrites(createEmptyDraft(id, example.first), example.firstWrites, { text: example.first, today }).draft;
  for (const turn of example.turns) {
    draft = turn.kind === "text" ? applyFactWrites(draft, turn.writes, { text: turn.text, today, openQuestions: ALL_OPEN }).draft : applyCardAnswers(draft, turn.answers).draft;
  }
  return draft;
}

const found = (draft: Ics1811Draft, adjust?: (fill: FillModel) => void) => {
  const fill = deriveFill(draft);
  adjust?.(fill);
  return checkDraft(draft, fill, today).map((check) => `${check.severity}:${check.id}`);
};

test("completed acceptance cases have no blockers", () => {
  for (const example of EXAMPLES) {
    assert.deepEqual(found(completed(example.id)).filter((id) => id.startsWith("blocker")), [], example.id);
  }
});

test("activity name length and special characters are blockers", () => {
  const long = completed("T1");
  long.copy = { name: "黄金每克减十五元活动名称太长了", content: "一般足金类黄金每克减15元", source: "ai" };
  assert.ok(found(long).includes("blocker:V-A01"));
  const special = completed("T1");
  special.copy = { name: "黄金<每克减15>", content: "一般足金类黄金每克减15元", source: "ai" };
  assert.ok(found(special).includes("blocker:V-A02"));
});

test("cycle values must be 0 or distinct weekdays", () => {
  const draft = completed("T1");
  draft.facts.weekdays = { value: [2, 2], quote: "每周二", via: "text" };
  assert.ok(found(draft).includes("blocker:V-A06"));
});

test("human answers still missing block confirmation", () => {
  const draft = completed("T1");
  draft.facts.commission = null;
  assert.ok(found(draft).includes("blocker:V-A08"));
});

test("payment methods keep GLP only when the campaign supports it", () => {
  const draft = completed("T1");
  draft.facts.paymentRemove = { value: ["GLP积分抵现"], quote: "不支持GLP积分抵现", via: "text" };
  assert.equal(deriveFill(draft).info.paymentMethods.value.includes("GLP积分抵现"), false);
  assert.ok(found(draft, (fill) => fill.info.paymentMethods.value.push("GLP积分抵现")).includes("blocker:V-A13"));
});

test("billing discount 0 is only legal for gold trade-in (free labor)", () => {
  const platinum = completed("T2");
  platinum.facts.offer!.value.items[0].discount = 0;
  assert.ok(found(platinum).includes("blocker:V-D03"));
  assert.equal(found(completed("T3")).includes("blocker:V-D03"), false);
});

test("platinum values outside the SOP list only warn", () => {
  const draft = completed("T2");
  draft.facts.offer!.value.items[0].discount = 0.85;
  const ids = found(draft);
  assert.ok(ids.includes("warning:V-D04"));
  assert.equal(ids.some((id) => id.startsWith("blocker")), false);
});

test("special campaigns keep their fixed goods, and gold trade-in ratios do not repeat", () => {
  assert.ok(found(completed("T2"), (fill) => (fill.details[0].categories.value = ["钻石类"])).includes("blocker:V-D05"));
  const gold = completed("T3");
  gold.facts.offer!.value.items[1].upgradeRatio = 0.5;
  assert.ok(found(gold).includes("blocker:V-D06"));
});

test("rates must be decimals between 0 and 1", () => {
  const draft = completed("T1");
  draft.facts.rates = { value: { concession: 2, collection: 0.98 }, quote: "卡片：Q5a", via: "card" };
  assert.ok(found(draft).includes("blocker:V-D11"));
});

test("restriction formats are checked, and unresolved restrictions block until dismissed", () => {
  const draft = completed("T1");
  draft.facts.restrictions = {
    value: [
      { field: "allowModelCategory", value: "EOFX", text: "允许模号货类EOFX" },
      { field: "denyGoodsGroup", value: "15A,16A", text: "不允许货组15A,16A" },
      { field: null, value: null, text: "不参加传承系列" },
    ],
    quote: "限制条件",
    via: "text",
  };
  const ids = found(draft);
  assert.ok(ids.includes("blocker:V-R02"));
  assert.ok(ids.includes("warning:V-R03"));
  assert.ok(ids.includes("blocker:note:restriction:2"));
  draft.dismissedNotes = ["restriction:2"];
  assert.equal(found(draft).includes("blocker:note:restriction:2"), false);
});

test("unsupported offer types and multiple brands block confirmation", () => {
  const text = "7590门店满5000打9折";
  const unsupported = applyFactWrites(createEmptyDraft("u", text), [{ key: "offer", quote: "满5000打9折" }], { text, today }).draft;
  assert.ok(found(unsupported).includes("blocker:note:unsupported_offer"));

  const brands = completed("T1");
  brands.facts.brands = { value: ["周大福", "SOINLOVE"], quote: "周大福和SOINLOVE", via: "text" };
  const fill = deriveFill(brands);
  assert.equal(fill.info.approvalFlow.value, null, "多品牌时审批流不选");
  assert.ok(found(brands).includes("blocker:note:multi_brand"));
});

test("the self-check list reflects failing checks", () => {
  const draft = completed("T1");
  draft.copy = { name: "黄金每克减十五元活动名称太长了", content: "一般足金类黄金每克减15元", source: "ai" };
  const fill = deriveFill(draft);
  const sheet = renderFillSheet(fill, checkDraft(draft, fill, today));
  assert.equal(sheet.selfCheck.find((item) => item.item === "活动名称")?.status, "不通过");
  assert.equal(sheet.selfCheck.find((item) => item.item === "特殊活动分组")?.status, "不适用");
});
