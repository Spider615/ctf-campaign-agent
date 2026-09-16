import assert from "node:assert/strict";
import test from "node:test";

import { applyCardAnswers } from "../app/lib/campaign/ics1811/card.ts";
import { deriveFill } from "../app/lib/campaign/ics1811/derive.ts";
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

test("colloquial wording converts the same way, and unsure answers never count", () => {
  assert.equal(P.normalizeText("满3,000减300"), "满3000减300");
  assert.equal(P.normalizeText("满 2000 减 200，12 月 30 日"), "满 2000 减 200，12 月 30 日", "分句的中文逗号不能把前后两个数字粘在一起");
  assert.deepEqual(
    ["九五折", "满五千减五百", "5千减5百", "回款率百分之九十八", "一千零五元", "三百八块", "只减一次", "一般足金类", "双十一钻石类"].map(P.digitize),
    ["95折", "满5000减500", "5000减500", "回款率98%", "1005元", "380块", "只减一次", "一般足金类", "双十一钻石类"],
  );
  assert.deepEqual(P.dateRangeFrom("十月八号到十五号", today), { start: "2026-10-08", end: "2026-10-15" });
  assert.deepEqual(P.dateRangeFrom("10.8-10.15", today), { start: "2026-10-08", end: "2026-10-15" });
  assert.deepEqual(P.dateRangeFrom("12月25日到明年1月3日", today), { start: "2026-12-25", end: "2027-01-03" });
  assert.deepEqual([P.perGramAmountFrom("每克便宜20块"), P.perGramAmountFrom("黄金一克减20"), P.perGramAmountFrom("克减20元")], [20, 20, 20]);
  assert.deepEqual(P.ratesFrom("没扣点也没回款率"), { concession: 0, collection: 0 });
  assert.deepEqual([P.commissionFrom("提成就按实际卖的价算"), P.commissionFrom("提成按售价乘折扣")], ["actual_price", "price_times_discount"]);
  assert.deepEqual([P.discountEditableFrom("门店可以改"), P.discountEditableFrom("固定的"), P.discountEditableFrom("可以改成9折")], [true, false, null]);
  assert.equal(write("都没有", [{ key: "rates", quote: "都没有" }], ["Q5a"]).draft.facts.rates?.value.collection, 0);
  assert.equal(write("不知道", [{ key: "rates", quote: "不知道" }], ["Q5a"]).draft.facts.rates, null, "不知道不等于没有");
  assert.equal(write("还不确定", [{ key: "commission", quote: "还不确定" }], ["Q5b"]).draft.facts.commission, null);
});

test("an unlimited-stores answer is refused with the 1811 reason, not a parse error", () => {
  const result = write("是不限制门店的", [{ key: "stores", quote: "是不限制门店的", value: ["不限制门店"] }]);
  assert.equal(result.draft.facts.stores, null, "「不限门店」不能当成门店写进去");
  assert.match(result.dropped[0]?.reason ?? "", /分行至少要选 1 家/, "理由要说是 1811 的限制，不能说成没认出来");
  assert.deepEqual(result.draft.unresolvedStores, [], "这句话不该被当成待澄清的门店名留下来当候选");

  for (const text of ["全部门店都参加", "闽深区所有门店", "每家店都参加"]) {
    assert.match(write(text, [{ key: "stores", quote: text, value: [text] }]).dropped[0]?.reason ?? "", /分行至少要选 1 家/, text);
  }

  // 两轮追问结束后 openQuestions 为空，用户补打门店仍然要能记下，否则复述里的缺项永远补不上。
  const filled = write("7590门店", [{ key: "stores", quote: "7590门店", value: ["7590"] }]);
  assert.deepEqual(filled.draft.facts.stores?.value, ["7590"]);
  assert.equal(gapsOf(filled.draft).some((gap) => gap.id === "Q2"), false, "补上门店后 Q2 不再是缺项");
});

test("a special-campaign quote that leaves out the campaign name is judged by the whole sentence", () => {
  const gold = "国庆在7590门店做黄金以旧换新，换大50%的工费打8折，换大100%的免工费。";
  const goldOffer = write(gold, [{ key: "offer", quote: "换大50%的工费打8折，换大100%的免工费" }]).draft.facts.offer?.value;
  assert.equal(goldOffer?.pattern, "gold_tradein");
  assert.deepEqual(goldOffer?.items.map((item) => [item.upgradeRatio, item.discount]), [[0.5, 0.8], [1, 0]]);

  const platinum = "7590门店做铂金以旧换新，2倍，开单9折。";
  const platinumOffer = write(platinum, [{ key: "offer", quote: "2倍，开单9折" }]).draft.facts.offer?.value;
  assert.deepEqual([platinumOffer?.pattern, platinumOffer?.items[0].multiple, platinumOffer?.items[0].discount], ["platinum_tradein", 2, 0.9]);

  const changed = "铂金不做以旧换新了，改成打9折";
  assert.equal(write(changed, [{ key: "offer", quote: "打9折" }]).draft.facts.offer?.value.pattern, "discount", "改口时按片段判定");
});

test("offers 1811 has no detail type for are recorded as unsupported and explained", () => {
  for (const [text, type] of [["第二件半价", "第二件优惠"], ["满3000送300", "满送"], ["买一送一", "买一送一"]]) {
    const draft = write(text, [{ key: "offer", quote: text }]).draft;
    assert.deepEqual([draft.facts.offer?.value.pattern, draft.facts.offer?.value.unsupportedType], ["unsupported", type]);
    assert.match(deriveFill(draft).notes.find((note) => note.id === "unsupported_offer")?.text ?? "", /没有对应选项/);
  }
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
