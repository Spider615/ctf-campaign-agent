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

test("计折上折按页面选项说也算回答提成口径，问句和只说能叠加不算", () => {
  // 1811 这一栏叫「计折上折」，运营按选项名回答是最自然的说法。
  assert.deepEqual([P.commissionFrom("不计算折上折"), P.commissionFrom("这次不算折上折"), P.commissionFrom("要计算折上折")], ["actual_price", "actual_price", "price_times_discount"]);
  // 只说选项的短回答，只在正在问提成口径时才算（实测：Agent 解释完计折上折，用户回「那就不计算」）。
  assert.deepEqual([P.commissionFrom("那就不计算", true), P.commissionFrom("计算", true)], ["actual_price", "price_times_discount"]);
  assert.equal(P.commissionFrom("那就不计算"), null, "没在问提成口径时，「不计算」不知道在说哪一栏");
  // 问句和「可以折上折」都不是在选口径。
  assert.deepEqual([P.commissionFrom("计折上折是什么意思", true), P.commissionFrom("要不要计算折上折？", true), P.commissionFrom("可以折上折")], [null, null, null]);
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

test("用户对提议点头才算同意；在说具体值、换话题、犹豫的都不算", () => {
  // 纯点头：编排器不等模型，直接按提议记。
  for (const text of ["行", "对", "好的", "对，就这样", "嗯，可以", "都按你说的", "行，没问题", "就这样吧", "ok", "对的对的", "嗯嗯"]) {
    assert.equal(P.agreesToProposal(text), true, `「${text}」是同意`);
    assert.equal(P.isPureAgreement(text), true, `「${text}」是纯点头`);
  }
  // 点头又夹带了别的：同意，但要模型拆开记（同意的采纳，改的按原话记）。
  for (const text of ["对，不过提成按乘折扣算", "好的，门店是7590"]) {
    assert.equal(P.agreesToProposal(text), true, `「${text}」开头是同意`);
    assert.equal(P.isPureAgreement(text), false, `「${text}」不是纯点头`);
  }
  // 否定、改值、换话题、说具体内容、犹豫：一律不算同意。
  for (const text of ["不对", "不行", "不用", "改成每克减20", "对了，门店改成3319", "是按实际克重", "可以改价", "行吧我再问问", "不知道", ""]) {
    assert.equal(P.agreesToProposal(text), false, `「${text}」不是同意`);
    assert.equal(P.isPureAgreement(text), false, `「${text}」不是纯点头`);
  }
});

test("提成口径的否定说法不能记反，问句不算回答", () => {
  // 验证工作流实测：「不需要计算折上折」曾被记成「计算折上折」，和原话正好相反。
  for (const text of ["不需要计算折上折", "不用算折上折", "无需计算折上折", "不要计折上折", "别算折上折", "没有计算折上折", "提成不需要计算折上折", "不需要计折上折，按实际售价"]) {
    assert.equal(P.commissionFrom(text), "actual_price", `「${text}」是不计算折上折`);
    assert.equal(P.commissionFrom(text, true), "actual_price", `「${text}」在问提成口径时也是不计算`);
  }
  // 「不」没有直接否定「计算」时不算否定。
  assert.equal(P.commissionFrom("不过要计算折上折"), "price_times_discount");
  for (const text of ["要不要计算折上折", "是否计算折上折"]) {
    assert.equal(P.commissionFrom(text, true), null, `「${text}」是在问，不是回答`);
  }
});

test("带问号的、求证式的「对吧」不算点头", () => {
  for (const text of ["嗯？", "对？", "OK?", "行？？", "好的?", "对吧", "是吧", "是嘛", "嗯是吧"]) {
    assert.equal(P.agreesToProposal(text), false, `「${text}」不是同意`);
    assert.equal(P.isPureAgreement(text), false, `「${text}」不是纯点头`);
  }
  for (const text of ["好吧", "行吧", "那行吧"]) {
    assert.equal(P.isPureAgreement(text), true, `「${text}」是点头`);
  }
  assert.equal(P.isPureAgreement("行吧我再问问"), false);
});

const storesDraft = (text: string, quote: string, value: string[]) =>
  applyFactWrites(createEmptyDraft("s", text), [{ key: "stores", quote, value }], { text, today }).draft;
const changeStores = (base: ReturnType<typeof storesDraft>, text: string, value: string[] = []) =>
  applyFactWrites(base, [{ key: "stores", quote: text, value }], { text, today });

test("门店可以在已有的基础上加减，说「改成」「只做」才整体替换", () => {
  const two = storesDraft("7590和3810两家店", "7590和3810", ["7590", "3810"]);
  assert.deepEqual(two.facts.stores?.value, ["7590", "3810"]);
  // 验证工作流实测：「3810不做了」曾把门店改成只剩 3810，正好反了。
  const removed = changeStores(two, "3810不做了", ["3810"]).draft;
  assert.deepEqual(removed.facts.stores?.value, ["7590"]);
  // 模型只把「3810」取成片段时，增减按用户原话那一小句判断。
  assert.deepEqual(applyFactWrites(two, [{ key: "stores", quote: "3810", value: ["3810"] }], { text: "3810不做了", today }).draft.facts.stores?.value, ["7590"]);
  // 验证工作流实测：「门店再加一个3319」曾把原来的 7590 换掉。
  const added = changeStores(removed, "门店再加一个3319", ["3319"]).draft;
  assert.deepEqual(added.facts.stores?.value, ["7590", "3319"]);
  assert.deepEqual(changeStores(added, "改成3319", ["3319"]).draft.facts.stores?.value, ["3319"]);
  assert.deepEqual(changeStores(added, "改成3319，再加一个3810", ["3319", "3810"]).draft.facts.stores?.value, ["3319", "3810"], "改成加上再加，提到的都算");
  assert.deepEqual(changeStores(removed, "算了还是两家都做，7590和3810", ["7590", "3810"]).draft.facts.stores?.value, ["7590", "3810"]);

  // 全去掉不行；一句里又加又减，分不清哪家是加哪家是减，要用户说出改完后的全部门店。
  const allGone = changeStores(removed, "7590不做了", ["7590"]);
  assert.deepEqual(allGone.draft.facts.stores?.value, ["7590"]);
  assert.match(allGone.dropped[0]?.reason ?? "", /至少要留 1 家/);
  const mixed = changeStores(two, "去掉3810，再加一个3319", ["3810", "3319"]);
  assert.deepEqual(mixed.draft.facts.stores?.value, ["7590", "3810"]);
  assert.equal(mixed.dropped.length, 1);
});

test("标语原文只取引号里的内容，不带前缀和引号", () => {
  const quoted = "标语原文就是「以旧焕新 金选五一」，法务还没确认";
  assert.deepEqual(P.sloganFrom(quoted), { wanted: true, text: "以旧焕新 金选五一", legalConfirmed: false });
  assert.deepEqual(P.sloganFrom("要标语，原文是“足金每克立减十五元”"), { wanted: true, text: "足金每克立减十五元", legalConfirmed: null });
  assert.deepEqual(P.sloganFrom("活动标语用：足金每克立减十五元"), { wanted: true, text: "足金每克立减十五元", legalConfirmed: null });
  assert.deepEqual(P.sloganFrom("要标语，原文是足金每克立减十五元"), { wanted: true, text: "足金每克立减十五元", legalConfirmed: null });

  const recorded = write(quoted, [{ key: "slogan", quote: quoted }]).draft.facts.slogan?.value;
  assert.deepEqual(recorded, { wanted: true, text: "以旧焕新 金选五一", legalConfirmed: false });
  // 引号没配对时解析不干净，宁可不记。
  const broken = "标语原文就是「以旧焕新 金选五一，法务还没确认";
  const result = write(broken, [{ key: "slogan", quote: broken }]);
  assert.equal(result.draft.facts.slogan, null);
  assert.equal(result.dropped[0]?.key, "slogan");
});

test("让扣点、回款率可以单独改一项，另一项沿用已记下的值", () => {
  const ratesDraft = (text: string) => applyFactWrites(createEmptyDraft("r", text), [{ key: "rates", quote: text }], { text, today }).draft;
  const change = (base: ReturnType<typeof ratesDraft>, text: string) => applyFactWrites(base, [{ key: "rates", quote: text }], { text, today });

  assert.deepEqual(change(ratesDraft("没有让扣点和回款率"), "让扣点改成3个点").draft.facts.rates?.value, { concession: 0.03, collection: 0 });
  assert.deepEqual(change(ratesDraft("让扣点2%，回款率98%"), "回款率是97%").draft.facts.rates?.value, { concession: 0.02, collection: 0.97 });
  assert.deepEqual(P.ratesFrom("让扣点有的 2个点 回款率98%"), { concession: 0.02, collection: 0.98 });
  // 没有已记下的值时，只说一项仍然不记：两项要一起给出。
  assert.equal(write("让扣点2%", [{ key: "rates", quote: "让扣点2%" }]).draft.facts.rates, null);
});

test("带提议的题，「不对」「不是」这种短回答不按是否换算，极性会反", () => {
  const withContext = (text: string, key: "rates" | "settlementLetter", open: ("Q5a" | "Q5c")[], proposed: ("Q5a" | "Q5c")[]) =>
    applyFactWrites(createEmptyDraft("y", text), [{ key, quote: text }], { text, today, openQuestions: open, proposed });
  // 提议是「一般没有，这次也这样吗？」，回「不对」意思是「有」，不能记成没有。
  assert.equal(withContext("不对", "rates", ["Q5a"], ["Q5a"]).draft.facts.rates, null);
  assert.deepEqual(withContext("没有", "rates", ["Q5a"], []).draft.facts.rates?.value, { concession: 0, collection: 0 });
  assert.deepEqual(withContext("没有", "rates", ["Q5a"], ["Q5a"]).draft.facts.rates?.value, { concession: 0, collection: 0 }, "「没有」本身说清了，不看极性");
  assert.equal(withContext("不是", "settlementLetter", ["Q5c"], ["Q5c"]).draft.facts.settlementLetter, null);
  assert.equal(withContext("不是", "settlementLetter", ["Q5c"], []).draft.facts.settlementLetter?.value, false);
});

test("面板和提议里的日期必须真实存在", () => {
  const draft = createEmptyDraft("d", "打9折");
  for (const [start, end] of [["2026-02-30", "2026-03-05"], ["2026-13-01", "2026-13-05"], ["2026-09-31", "2026-10-07"]]) {
    const result = applyCardAnswers(draft, { Q1: { start, end } });
    assert.deepEqual(result.ignored.map((item) => item.reason), ["日期不存在"], `${start} 至 ${end}`);
  }
  assert.deepEqual(applyCardAnswers(draft, { Q1: { start: "2028-02-29", end: "2028-03-01" } }).applied, ["Q1"]);
});

test("proposal answers keep the user's words as the source", () => {
  const draft = createEmptyDraft("p", "7590门店钻石类打9折");
  const result = applyCardAnswers(draft, { Q5a: { none: true } }, { quote: "行", via: "proposal" });
  assert.deepEqual(result.applied, ["Q5a"]);
  assert.deepEqual([result.draft.facts.rates?.via, result.draft.facts.rates?.quote], ["proposal", "行"]);
});

test("只说了玩法没说力度，先认下玩法，接着只问力度", () => {
  // 原来认不出，Agent 会反过来问「打折还是满减」，用户明明说过了。
  const discount = write("国庆钻石打折", [{ key: "offer", quote: "国庆钻石打折" }]).draft;
  assert.equal(discount.facts.offer?.value.pattern, "discount");
  assert.equal(gapsOf(discount).find((gap) => gap.id === "Q3a")?.title, "还差：打几折？");
  assert.equal(gapsOf(discount).some((gap) => gap.id === "Q3"), false);

  const threshold = write("帮我弄个满减", [{ key: "offer", quote: "帮我弄个满减" }]).draft;
  assert.equal(threshold.facts.offer?.value.pattern, "threshold");
  assert.equal(gapsOf(threshold).find((gap) => gap.id === "Q3a")?.title, "还差：满多少、减多少？");

  // 「不打折」不是打折。
  assert.equal(write("这次不打折，做满减", [{ key: "offer", quote: "这次不打折，做满减" }]).draft.facts.offer?.value.pattern, "threshold");
  assert.equal(write("钻石不打折", [{ key: "offer", quote: "钻石不打折" }]).draft.facts.offer, null);
});
