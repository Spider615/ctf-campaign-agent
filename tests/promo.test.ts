import assert from "node:assert/strict";
import test from "node:test";

import { deriveFill } from "../app/lib/campaign/ics1811/derive.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { renderPromo } from "../app/lib/campaign/ics1811/promo.ts";
import { communicationGate, renderCommunicationPlan, validateCommunicationCreative } from "../app/lib/campaign/communication.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";
import type { CampaignDraft, CommunicationCreative } from "../app/lib/campaign/types.ts";

const TODAY = "2026-09-16";

// T1：2027 年 5 月 1 日到 5 月 5 日，闽深区 7590 门店，一般足金类每克减 15 元。
function t1Draft() {
  const t1 = EXAMPLES[0];
  return applyFactWrites(createEmptyDraft("promo", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft;
}

function t9Draft() {
  const t9 = EXAMPLES.find((example) => example.id === "T9");
  assert.ok(t9);
  return applyFactWrites(createEmptyDraft("promo-slogan", t9.first), t9.firstWrites, { text: t9.first, today: TODAY }).draft;
}

function confirmedT9Draft() {
  const t9 = EXAMPLES.find((example) => example.id === "T9");
  assert.ok(t9);
  const first = t9Draft();
  const followUp = t9.turns[0];
  assert.equal(followUp.kind, "text");
  return applyFactWrites(first, followUp.writes, { text: followUp.text, today: TODAY }).draft;
}

function completeBrandCampaign(): CampaignDraft {
  const campaign = createCampaignDraft("brand", "面向年轻情侣做新品发布，通过小红书和门店传播东方美学主题");
  return {
    ...campaign,
    brief: {
      ...campaign.brief,
      objective: { value: "为新品系列建立认知", quote: "为新品系列建立认知", via: "text" },
      audience: { value: "年轻情侣", quote: "年轻情侣", via: "text" },
      theme: { value: "东方美学新生", quote: "东方美学新生", via: "text" },
      channels: { value: ["social", "store"], quote: "小红书和门店", via: "text" },
    },
  };
}

function completeCreative(): CommunicationCreative {
  return {
    concept: {
      headline: "一见东方",
      subheadline: "为年轻情侣呈现东方美学新生",
      coreMessage: "让东方美学走进每一次相见",
    },
    channelOutputs: [
      { channel: "social", format: "小红书图文", copy: "东方美学新生，邀年轻情侣一起发现心意之选。", cta: "到店探索新品" },
      { channel: "store", format: "门店海报", copy: "东方美学新生，于店内与心意相见。", cta: "欢迎到店品鉴" },
    ],
    visualDirection: "以东方留白为主，产品特写居中，暖金色点亮标题层级。",
    source: "ai",
  };
}

test("communication gate names every missing core Brief field", async () => {
  const campaign = createCampaignDraft("brand-missing", "做一场新品发布");
  assert.deepEqual(communicationGate(campaign), {
    ready: false,
    missing: ["brief.objective", "brief.audience", "brief.theme", "brief.channels"],
  });
  assert.deepEqual(communicationGate(completeBrandCampaign()), { ready: true, missing: [] });
});

test("transaction communication also requires date, store scope, offer and categories from 1811 facts", () => {
  const campaign = completeBrandCampaign();
  campaign.ics1811 = createEmptyDraft("offer", "做成交优惠");

  assert.deepEqual(communicationGate(campaign), {
    ready: false,
    missing: ["ics1811.dates", "ics1811.stores", "ics1811.offer", "ics1811.categories"],
  });

  campaign.ics1811 = t1Draft();
  assert.deepEqual(communicationGate(campaign), { ready: true, missing: [] });
});

test("communication creative accepts a complete multi-channel draft grounded in the Brief", () => {
  assert.deepEqual(validateCommunicationCreative(completeBrandCampaign(), completeCreative()), { ok: true, errors: [] });
});

test("communication creative rejects output for an unconfirmed channel", () => {
  const creative = completeCreative();
  creative.channelOutputs.push({ channel: "wechat", format: "公众号推文", copy: "东方美学新生。", cta: "阅读全文" });

  const checked = validateCommunicationCreative(completeBrandCampaign(), creative);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /未确认.*wechat/);
});

test("communication creative requires one output for every confirmed channel", () => {
  const creative = completeCreative();
  creative.channelOutputs = creative.channelOutputs.filter((output) => output.channel !== "store");

  const checked = validateCommunicationCreative(completeBrandCampaign(), creative);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /缺少.*store/);
});

test("communication creative rejects a number absent from confirmed facts", () => {
  const creative = completeCreative();
  creative.concept.coreMessage = "连续 7 天发现东方美学新生";

  const checked = validateCommunicationCreative(completeBrandCampaign(), creative);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /数字.*7/);
});

test("communication creative rejects an unsupported consumer right", () => {
  const creative = completeCreative();
  creative.channelOutputs[0] = { ...creative.channelOutputs[0], copy: "到店即赠限定好礼，发现东方美学新生。" };

  const checked = validateCommunicationCreative(completeBrandCampaign(), creative);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /权益.*赠.*好礼/);
});

test("communication creative rejects an audience that is absent from the confirmed Brief", () => {
  const creative = completeCreative();
  creative.concept.subheadline = "为职场女性呈现东方美学新生";

  const checked = validateCommunicationCreative(completeBrandCampaign(), creative);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /目标人群.*职场.*女性/);
});

test("communication creative rejects the user's slogan until legal confirmation is recorded", () => {
  const campaign = completeBrandCampaign();
  campaign.ics1811 = t9Draft();
  const creative = completeCreative();
  creative.concept.headline = "足金每克立减十五元";

  const checked = validateCommunicationCreative(campaign, creative);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("；"), /标语.*法务确认/);
});

test("communication plan renders concept, core message, channel outputs, visual direction and confirmed Brief facts", () => {
  const campaign = { ...completeBrandCampaign(), communication: completeCreative() };
  const plan = renderCommunicationPlan(campaign);

  assert.ok(plan);
  assert.equal(plan.status, "needs_review");
  assert.deepEqual(plan.concept, campaign.communication?.concept);
  assert.equal(plan.concept.coreMessage, "让东方美学走进每一次相见");
  assert.deepEqual(plan.channelOutputs, campaign.communication?.channelOutputs);
  assert.equal(plan.visualDirection, campaign.communication?.visualDirection);
  assert.deepEqual(plan.facts, {
    name: null,
    objective: "为新品系列建立认知",
    audience: "年轻情侣",
    theme: "东方美学新生",
    channels: ["social", "store"],
    timing: null,
    scope: null,
    period: null,
    stores: null,
    offer: [],
    slogan: null,
  });
  assert.ok(plan.reviewNotes.some((note) => note.includes("人工审核")));
});

test("transaction communication facts render period, public store names and offer only from the 1811 child", () => {
  const campaign = completeBrandCampaign();
  campaign.ics1811 = t1Draft();
  campaign.communication = completeCreative();

  const plan = renderCommunicationPlan(campaign);
  assert.ok(plan);
  assert.equal(plan.facts.period, "2027 年 5 月 1 日至 5 月 5 日");
  assert.equal(plan.facts.stores, "东门鸿展店");
  assert.doesNotMatch(plan.facts.stores, /7590|214\)/);
  assert.deepEqual(plan.facts.offer, ["一般足金类每克立减 15 元"]);
  assert.equal(plan.facts.slogan, null);
});

test("communication plan omits an unconfirmed slogan and surfaces a legal-review reminder", () => {
  const campaign = completeBrandCampaign();
  campaign.ics1811 = t9Draft();
  campaign.communication = completeCreative();

  const plan = renderCommunicationPlan(campaign);
  assert.ok(plan);
  assert.equal(plan.facts.slogan, null);
  assert.ok(plan.reviewNotes.some((note) => /标语.*法务确认/.test(note)));
});

test("communication plan renders only the user's verbatim legally confirmed slogan", () => {
  const campaign = completeBrandCampaign();
  campaign.ics1811 = confirmedT9Draft();
  campaign.communication = completeCreative();

  const plan = renderCommunicationPlan(campaign);
  assert.ok(plan);
  assert.equal(plan.facts.slogan, "足金每克立减十五元");
  assert.equal(plan.reviewNotes.some((note) => note.includes("标语尚未经")), false);
});

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
