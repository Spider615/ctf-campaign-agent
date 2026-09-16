import assert from "node:assert/strict";
import test from "node:test";

import { deriveFill } from "../app/lib/campaign/ics1811/derive.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { renderPromo } from "../app/lib/campaign/ics1811/promo.ts";

const TODAY = "2026-09-16";

// T1：2027 年 5 月 1 日到 5 月 5 日，闽深区 7590 门店，一般足金类每克减 15 元。
function t1Draft() {
  const t1 = EXAMPLES[0];
  return applyFactWrites(createEmptyDraft("promo", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft;
}

test("promo doc takes the creative part from the model and every fact from the draft", () => {
  const base = t1Draft();
  const draft = { ...base, promo: { headline: "黄金每克减15", highlights: ["一般足金类每克立减15元"], source: "ai" as const } };
  const doc = renderPromo(draft, deriveFill(draft));
  assert.ok(doc);

  // 模型供给的创意原样保留。
  assert.equal(doc.headline, "黄金每克减15");
  assert.deepEqual(doc.highlights, ["一般足金类每克立减15元"]);

  // 事实部分一律由代码渲染，模型碰不到：数字有守卫，但「闽深区」写成「华南区」守卫拦不住。
  // 同一年不把年份写两遍。
  assert.match(doc.period, /^2027 年 5 月 1 日至 5 月 5 日$/);
  // 对外要写店名，不写内部门店编号：fill 里 branches 只有「7590」，消费者不认这个。
  // 措辞是「东门鸿展店」，不是「东门鸿展门店」。
  assert.match(doc.stores, /^东门鸿展店$/);
  assert.doesNotMatch(doc.stores, /7590/, "门店编号是内部代码，不能出现在对外文案里");
  // region 在 fill 里是「214)闽深区」，代码前缀同样不能露出去。
  assert.doesNotMatch(doc.stores, /214\)/);
  assert.ok(doc.offer.length > 0, "优惠说明要从明细渲染出来");
  assert.ok(doc.offer.some((line) => line.includes("15")), "优惠力度来自事实层");

  // SOP 里标语必须法务确认过才能对外用，这份文案是给运营的草稿。
  // 把提示做进结构里，而不是指望谁记得加。
  assert.ok(doc.notes.some((note) => note.includes("法务")), "注意事项里要有法务确认提示");
});

test("promo doc is nothing until the model has drafted the creative part", () => {
  const draft = t1Draft();
  assert.equal(draft.promo, null);
  // 只有事实、没有主张的文案不是文案，不如不出。
  assert.equal(renderPromo(draft, deriveFill(draft)), null);
});
