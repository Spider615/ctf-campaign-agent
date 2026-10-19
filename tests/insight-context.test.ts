import assert from "node:assert/strict";
import test from "node:test";
import { conversationRoute } from "../app/lib/analytics/intent.ts";
import { draftFor, focusContext, focusLabel, focusSearch, locateAnswer, parseFocus } from "../app/lib/insight/context.ts";

const focus = { metric: "give_per_gram" as const, offer: "克减类", category: "一般足金类", dimension: "cityTier" as const, value: "一线城市" };

test("标签和问答上下文写清范围", () => {
  assert.equal(focusLabel(focus), "克减类 × 城市级别（一线城市） → 每克让利");
  // 问答的语义层不认识「克减类」和派生指标名，上下文要换成它能算的写法。
  const context = focusContext(focus);
  assert.match(context, /货类 一般足金类 里优惠名称含「克减」的各项优惠/);
  assert.match(context, /每克实收/);
  assert.match(context, /按城市级别看，重点是「一线城市」/);
  assert.doesNotMatch(context, /优惠 克减类/);
  assert.match(focusContext({ ...focus, offer: "H-克减50元", metric: "grams_per_item" }), /克重 ÷ 件数.*优惠「H-克减50元」/);
});

test("草稿话不带日期和力度，以冒号结尾留给用户补", () => {
  const text = draftFor(focus, "cityTier", "一线城市");
  assert.doesNotMatch(text, /\d{1,2}月\d{1,2}日|\d{4}-\d{2}|克减\d/);
  assert.ok(text.endsWith("："));
  // 用户补完再发出去时要走活动执行，不能被当成分析问题。
  assert.equal(conversationRoute(text), "execution");
  assert.equal(conversationRoute(`${text}9月1日到9月7日，全国门店，每克减30元`), "execution");
});

test("URL 参数互相还原，未知值整条拒绝，过长取值截断", () => {
  assert.deepEqual(parseFocus(focusSearch(focus)), focus);
  assert.equal(parseFocus("metric=unknown"), null);
  assert.equal(parseFocus("metric=give_per_gram&dim=nope"), null);
  assert.equal(parseFocus("offer=随便写"), null);
  assert.equal(parseFocus(""), null);
  assert.equal(parseFocus(`metric=give_per_gram&dim=region&value=${"长".repeat(60)}`)?.value?.length, 40);
});

test("回答用到的维度定位到图上", () => {
  assert.equal(locateAnswer(["store", "cityTier"]), "cityTier");
  assert.equal(locateAnswer(["offer"]), "offerDepth");
  assert.equal(locateAnswer(["store", "day"]), null);
});

test("问答上下文写明「这个关系」指什么，计划复核能看到", async () => {
  const { planReviewPrompt } = await import("../app/lib/analytics/plan/prompt.ts");
  const context = focusContext({ metric: "lift_per_store_day", offer: "克减类", category: "一般足金类", dimension: "cityTier" });
  assert.match(context, /「这个关系」「这条线」指城市级别的不同取值对每店日均实收的影响/);
  assert.match(focusContext({ metric: "lift_per_store_day", offer: "克减类", category: "一般足金类" }), /指各因素对每店日均实收的影响/);
  assert.match(planReviewPrompt("你帮我分析一下这个关系", "{}", undefined, [context]), /原问题里的指代按这里理解[\s\S]*城市级别/);
});
