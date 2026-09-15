import assert from "node:assert/strict";
import test from "node:test";

import { applyCardAnswers } from "../app/lib/campaign/ics1811/card.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import * as P from "../app/lib/campaign/ics1811/phrases.ts";
import { gapsOf } from "../app/lib/campaign/ics1811/questions.ts";

const today = "2026-09-16";
const write = (text: string, writes: Parameters<typeof applyFactWrites>[1], openQuestions: Parameters<typeof applyFactWrites>[2]["openQuestions"] = []) =>
  applyFactWrites(createEmptyDraft("g", text), writes, { text, today, openQuestions });

test("Chinese phrases convert to 1811 values", () => {
  assert.deepEqual(["9", "95", "9.5", "99"].map(P.discountValue), [0.9, 0.95, 0.95, 0.99]);
  assert.deepEqual(P.ratesFrom("没有让扣点和回款率"), { concession: 0, collection: 0 });
  assert.deepEqual(P.ratesFrom("让扣点12个点，回款率98%"), { concession: 0.12, collection: 0.98 });
  assert.equal(P.ratesFrom("让扣点2，回款率98"), null, "不带单位又大于 1 的数不猜");
  assert.deepEqual(P.goldTiersFrom("换大50%的工费打8折，换大100%的免工费"), [{ upgradeRatio: 0.5, discount: 0.8 }, { upgradeRatio: 1, discount: 0 }]);
  assert.deepEqual(P.diamondGoldFrom("钻石不打折，黄金每克减20元"), { discount: 1, amount: 20 });
  assert.deepEqual([P.weekdaysFrom("每周二"), P.weekdaysFrom("周三周四"), P.weekdaysFrom("周大福黄金")], [[2], [3, 4], null]);
  assert.deepEqual([P.thresholdRepeatFrom("每满5000都减500"), P.thresholdRepeatFrom("只减一次"), P.thresholdRepeatFrom("上不封顶")], ["every", "once", "every"]);
  assert.deepEqual(P.dateRangeFrom("5月4号到10号", today), { start: "2027-05-04", end: "2027-05-10" }, "没写年份取今天之后最近的日期");
  assert.deepEqual(P.dateRangeFrom("12月30日到1月3日", today), { start: "2026-12-30", end: "2027-01-03" });
});

test("a quote that is not in the user's words is dropped", () => {
  const result = write("钻石类打9折", [{ key: "offer", quote: "打8折" }]);
  assert.equal(result.draft.facts.offer, null);
  assert.match(result.dropped[0].reason, /原话片段不在/);
});

test("numbers come from the quote, not from the model", () => {
  const result = write("钻石类打9折", [{ key: "offer", quote: "打9折", value: { items: [{ discount: 0.8 }] } }]);
  assert.equal(result.draft.facts.offer?.value.items[0].discount, 0.9);
});

test("stacking words do not answer the commission question, and holidays are not dates", () => {
  const text = "国庆可以折上折，也可以叠加";
  const result = write(text, [{ key: "commission", quote: "可以折上折，也可以叠加" }, { key: "dates", quote: "国庆" }]);
  assert.equal(result.draft.facts.commission, null);
  assert.equal(result.draft.facts.dates, null);
  assert.deepEqual(result.dropped.map((item) => item.key), ["commission", "dates"]);
});

test("short yes/no answers only count while that question is open", () => {
  assert.equal(write("可以", [{ key: "discountEditable", quote: "可以" }]).draft.facts.discountEditable, null);
  assert.equal(write("可以", [{ key: "discountEditable", quote: "可以" }], ["Q3b"]).draft.facts.discountEditable?.value, true);
  assert.equal(write("没有", [{ key: "rates", quote: "没有" }], ["Q5a"]).draft.facts.rates?.value.concession, 0);
});

test("the model cannot write a slogan the user did not give", () => {
  const result = write("帮我想句标语", [{ key: "slogan", quote: "帮我想句标语", value: { wanted: true, text: "足金闪耀" } }]);
  assert.equal(result.draft.facts.slogan, null);
});

test("unresolved stores and ambiguous categories become questions with candidates", () => {
  const text = "闽深区黄金每克减15元";
  const result = write(text, [{ key: "stores", quote: "闽深区", value: ["闽深区"] }, { key: "categories", quote: "黄金", value: ["黄金"] }]);
  assert.equal(result.draft.facts.stores, null);
  assert.equal(result.draft.facts.categories, null);
  const gaps = gapsOf(result.draft);
  assert.ok(gaps.find((gap) => gap.id === "Q2")?.candidates?.includes("7590 深圳东门解放路鸿展珠宝店"));
  assert.deepEqual(gaps.find((gap) => gap.id === "Q4")?.candidates, ["一般足金类", "一般金条/金章"]);
});

test("later messages fill in missing offer parameters without losing earlier ones", () => {
  const first = write("铂金以旧换新，开单9折", [{ key: "offer", quote: "铂金以旧换新，开单9折" }]).draft;
  const text = "换大2倍";
  const merged = applyFactWrites(first, [{ key: "offer", quote: "换大2倍" }], { text, today }).draft;
  assert.deepEqual([merged.facts.offer?.value.pattern, merged.facts.offer?.value.items[0].discount, merged.facts.offer?.value.items[0].multiple], ["platinum_tradein", 0.9, 2]);
});

test("follow-up facts said in the same sentence are recorded with the offer", () => {
  const result = write("每满1000减100", [{ key: "offer", quote: "每满1000减100" }]);
  assert.equal(result.draft.facts.thresholdRepeat?.value, "every");
  assert.ok(result.applied.includes("thresholdRepeat"));
});

test("card answers are validated before they reach the draft", () => {
  const draft = createEmptyDraft("c", "打9折");
  const result = applyCardAnswers(draft, {
    Q1: { start: "2026-10-07", end: "2026-10-01" },
    Q2: { stores: ["9999"] },
    Q5a: { concession: 2, collection: 0.98 },
    Q6a: { wanted: true, text: "足金闪耀" },
    Q9: { anything: true },
  });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.ignored.map((item) => item.id).sort(), ["Q1", "Q2", "Q5a", "Q6a", "Q9"]);
  const ok = applyCardAnswers(draft, { Q1: { start: "2026-10-01", end: "2026-10-07" }, Q5a: { none: true }, Q6a: { wanted: false } });
  assert.deepEqual(ok.applied, ["Q1", "Q5a", "Q6a"]);
  assert.equal(ok.draft.facts.rates?.via, "card");
});
