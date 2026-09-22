import assert from "node:assert/strict";
import test from "node:test";

import { applyCampaignBriefWrites, createEmptyCampaignBrief } from "../app/lib/campaign/brief.ts";
import type { CampaignDraft } from "../app/lib/campaign/types.ts";
import { buildCampaignWorkspace, createCampaignDraft, ensureIcs1811Child, normalizeCampaignDraft, routeCampaign } from "../app/lib/campaign/workspace.ts";
import { EXAMPLES, EXAMPLE_TODAY } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";

const T1 = EXAMPLES.find((example) => example.id === "T1")!;

function readyIcs1811() {
  return applyFactWrites(createEmptyDraft("legacy-1811", T1.first), T1.firstWrites, {
    text: T1.first,
    today: EXAMPLE_TODAY,
  }).draft;
}

function completeBrief(draft: CampaignDraft): CampaignDraft {
  const text = "活动叫金耀五月，目标是拉动到店成交，面向深圳年轻情侣，主题是为爱添金，通过门店和微信发布，时间是五月初，范围是深圳7590门店。";
  const result = applyCampaignBriefWrites(draft.brief, [
    { key: "name", quote: "金耀五月", value: "模型擅自改名" },
    { key: "objective", quote: "拉动到店成交", value: "模型臆造的目标" },
    { key: "audience", quote: "深圳年轻情侣", value: "模型臆造的人群" },
    { key: "theme", quote: "为爱添金", value: "模型臆造的主题" },
    { key: "channels", quote: "门店和微信", value: ["social"] },
    { key: "timing", quote: "五月初", value: "全年" },
    { key: "scope", quote: "深圳7590门店", value: "全国" },
  ], { text });
  assert.deepEqual(result.dropped, []);
  return { ...draft, brief: result.brief };
}

test("legacy 1811 drafts normalize into one stable campaign parent without changing the child", () => {
  const legacy = readyIcs1811();
  const before = structuredClone(legacy);

  const first = normalizeCampaignDraft(legacy);
  const second = normalizeCampaignDraft(legacy);

  assert.equal(first.schema, "campaign/v1");
  assert.equal(first.id, `campaign:${legacy.id}`);
  assert.equal(first.requestText, legacy.requestText);
  assert.deepEqual(first.ics1811, legacy);
  assert.deepEqual(first, second);
  assert.deepEqual(legacy, before, "兼容适配不能改写旧草稿");
});

test("routing is derived without creating an 1811 child for brand-only or member-only work", () => {
  const brand = createCampaignDraft("brand", "为传福系列策划一场新品发布会和品牌内容传播");
  assert.equal(brand.ics1811, null);
  assert.deepEqual(routeCampaign(brand), {
    tracks: ["brand_launch"],
    status: "decided",
    basis: ["原始需求提到新品、品牌或内容传播"],
  });

  const member = createCampaignDraft("member", "给会员做积分主题的私域 CRM 触达");
  assert.equal(member.ics1811, null);
  assert.deepEqual(routeCampaign(member), {
    tracks: ["member_crm"],
    status: "decided",
    basis: ["原始需求提到会员、私域、积分或 CRM 触达"],
  });
});

test("routing can select multiple tracks and creates at most one deterministic 1811 child", () => {
  const mixed = createCampaignDraft("mixed", "为传福系列做新品发布，活动期间门店钻石类打9折");

  assert.deepEqual(routeCampaign(mixed).tracks, ["brand_launch", "transaction_offer"]);
  assert.equal(routeCampaign(mixed).status, "decided");
  assert.equal(mixed.ics1811?.id, "mixed:ics1811");
  assert.equal(mixed.ics1811?.requestText, mixed.requestText);
});

test("vague requests stay at needs_confirmation and do not default to 1811", () => {
  const vague = createCampaignDraft("vague", "想做一个十月活动");

  assert.equal(vague.ics1811, null);
  assert.deepEqual(routeCampaign(vague), {
    tracks: [],
    status: "needs_confirmation",
    basis: ["当前信息不足，尚不能判断活动执行轨"],
  });
});

test("campaign brief writes require current-message quotes and derive channels from the quote", () => {
  const text = "活动叫传福新章，目标是提升新品认知，面向年轻情侣，主题是福启新章，投放门店和微信，时间是十月，范围是深圳。";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    // 描述类：模型可以归纳措辞，但数字必须是用户说过的。
    { key: "name", quote: "传福新章", value: "传福新章" },
    { key: "objective", quote: "提升新品认知", value: "提升销量100%" },
    { key: "audience", quote: "年轻情侣", value: "年轻备婚情侣" },
    { key: "theme", quote: "福启新章", value: "福启新章" },
    // 渠道由代码从原话识别，不看 value。
    { key: "channels", quote: "门店和微信", value: ["ecommerce"] },
    // 边界类：改写等于偷偷改执行范围，一律拒绝。
    { key: "timing", quote: "十月", value: "全年" },
    { key: "scope", quote: "深圳", value: "全国" },
  ], { text });

  assert.deepEqual(result.applied, ["name", "objective", "audience", "theme", "channels", "timing", "scope"]);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.brief.name?.value, "传福新章");
  assert.equal(result.brief.objective?.value, "提升新品认知", "100 不在原话里，整个 value 作废");
  assert.equal(result.brief.audience?.value, "年轻备婚情侣");
  assert.equal(result.brief.theme?.value, "福启新章");
  assert.deepEqual(result.brief.channels?.value, ["store", "wechat"]);
  assert.equal(result.brief.timing?.value, "十月", "边界类不许改写");
  assert.equal(result.brief.scope?.value, "深圳", "边界类不许改写");
});

test("campaign brief drops invented quotes and unsupported channel claims", () => {
  const brief = createEmptyCampaignBrief();
  const invented = applyCampaignBriefWrites(brief, [{ key: "scope", quote: "全国", value: "全国" }], { text: "范围是深圳" });
  assert.equal(invented.brief.scope, null);
  assert.match(invented.dropped[0]?.reason ?? "", /原话片段/);

  const unsupported = applyCampaignBriefWrites(brief, [{ key: "channels", quote: "电视", value: ["social"] }], { text: "通过电视发布" });
  assert.equal(unsupported.brief.channels, null);
  assert.match(unsupported.dropped[0]?.reason ?? "", /支持的渠道/);
});

test("channel updates distinguish adding another channel from replacing the channel plan", () => {
  const initial = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "channels", quote: "先在微信公众号发布" },
  ], { text: "先在微信公众号发布" });

  const added = applyCampaignBriefWrites(initial.brief, [
    { key: "channels", quote: "再加小红书" },
  ], { text: "再加小红书" });
  assert.deepEqual(added.brief.channels?.value, ["wechat", "social"]);

  const replaced = applyCampaignBriefWrites(added.brief, [
    { key: "channels", quote: "改成只做门店" },
  ], { text: "改成只做门店" });
  assert.deepEqual(replaced.brief.channels?.value, ["store"]);

  const naturalReplacement = applyCampaignBriefWrites(initial.brief, [
    { key: "channels", quote: "把微信公众号改成小红书" },
  ], { text: "把微信公众号改成小红书" });
  assert.deepEqual(naturalReplacement.brief.channels?.value, ["social"]);

  for (const text of ["别用微信了，改用小红书", "微信改小红书"]) {
    const correction = applyCampaignBriefWrites(initial.brief, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(correction.brief.channels?.value, ["social"], text);
  }

  const removeThenAdd = applyCampaignBriefWrites(initial.brief, [
    { key: "channels", quote: "取消微信，增加小红书" },
  ], { text: "取消微信，增加小红书" });
  assert.deepEqual(removeThenAdd.brief.channels?.value, ["social"]);

  const negatedAddition = applyCampaignBriefWrites(initial.brief, [
    { key: "channels", quote: "小红书" },
  ], { text: "不再加小红书" });
  assert.deepEqual(negatedAddition.brief.channels?.value, ["wechat"]);
  assert.deepEqual(negatedAddition.applied, []);
  assert.match(negatedAddition.dropped[0]?.reason ?? "", /没有变化/);

  const storeAndWechat = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "channels", quote: "门店和微信" },
  ], { text: "门店和微信" }).brief;
  const contentEditAndAddition = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "小红书也发" },
  ], { text: "修改一下微信文案，小红书也发" });
  assert.deepEqual(contentEditAndAddition.brief.channels?.value, ["store", "wechat", "social"]);

  for (const [text, quote] of [
    ["微信文案改一下，小红书也发", "小红书也发"],
    ["微信文案只要简洁，小红书也发", "小红书也发"],
    ["改一下活动主题，小红书也发", "小红书也发"],
    ["微信不用改，小红书也发", "小红书也发"],
    ["不要只发微信，也发小红书", "也发小红书"],
    ["修改一下微信发布文案，小红书也发", "小红书也发"],
  ]) {
    const contentOnlyEditAndAddition = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote },
    ], { text });
    assert.deepEqual(contentOnlyEditAndAddition.brief.channels?.value, ["store", "wechat", "social"], text);

    const broadContentEditAndAddition = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(broadContentEditAndAddition.brief.channels?.value, ["store", "wechat", "social"], `${text}（宽原话）`);
  }

  for (const text of [
    "取消微信增加小红书",
    "去掉微信加上小红书",
    "增加小红书取消微信",
    "再加小红书去掉微信",
    "别用微信改用小红书",
  ]) {
    const compactRemoveAndAdd = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(compactRemoveAndAdd.brief.channels?.value, ["store", "social"], text);
  }

  const negativeThenPositive = applyCampaignBriefWrites(initial.brief, [
    { key: "channels", quote: "不要增加小红书但增加门店" },
  ], { text: "不要增加小红书但增加门店" });
  assert.deepEqual(negativeThenPositive.brief.channels?.value, ["wechat", "store"]);

  const replaceOneOfMany = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "把微信改成小红书" },
  ], { text: "把微信改成小红书，其他渠道不变" });
  assert.deepEqual(replaceOneOfMany.brief.channels?.value, ["store", "social"]);

  const broadQuote = "通过微信发布，活动范围是深圳7590门店";
  const channelNotScope = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "channels", quote: broadQuote },
  ], { text: broadQuote });
  assert.deepEqual(channelNotScope.brief.channels?.value, ["wechat"]);

  const coverageQuote = "通过微信发布，覆盖深圳7590家门店";
  const coverageNotChannel = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "channels", quote: coverageQuote },
  ], { text: coverageQuote });
  assert.deepEqual(coverageNotChannel.brief.channels?.value, ["wechat"]);

  const allChannels = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "再加小红书" },
  ], { text: "再加小红书" }).brief;
  const keepAfterRemoval = applyCampaignBriefWrites(allChannels, [
    { key: "channels", quote: "取消微信，小红书不变" },
  ], { text: "取消微信，小红书不变" });
  assert.deepEqual(keepAfterRemoval.brief.channels?.value, ["store", "social"]);

  const keepAfterReplacement = applyCampaignBriefWrites(allChannels, [
    { key: "channels", quote: "改用小红书，微信保留" },
  ], { text: "改用小红书，微信保留" });
  assert.deepEqual(keepAfterReplacement.brief.channels?.value, ["social", "wechat"]);

  const absoluteReplacement = applyCampaignBriefWrites(allChannels, [
    { key: "channels", quote: "取消微信，改成只做门店" },
  ], { text: "取消微信，改成只做门店" });
  assert.deepEqual(absoluteReplacement.brief.channels?.value, ["store"]);

  for (const text of ["只保留微信", "仅保留微信"]) {
    const keepOnlyWechat = applyCampaignBriefWrites(allChannels, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(keepOnlyWechat.brief.channels?.value, ["wechat"], text);
  }

  const removeInsteadOfKeep = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "不保留微信，增加小红书" },
  ], { text: "不保留微信，增加小红书" });
  assert.deepEqual(removeInsteadOfKeep.brief.channels?.value, ["store", "social"]);

  for (const text of ["通过微信发布覆盖深圳7590家门店", "通过微信发布，适用于深圳7590门店"]) {
    const storeCoverageNotChannel = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(storeCoverageNotChannel.brief.channels?.value, ["wechat"], text);
  }

  const explicitContentPlacement = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "内容只投小红书" },
  ], { text: "内容只投小红书" });
  assert.deepEqual(explicitContentPlacement.brief.channels?.value, ["social"]);

  const channelDeliverables = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "channels", quote: "渠道做门店海报和微信文案" },
  ], { text: "渠道做门店海报和微信文案" });
  assert.deepEqual(channelDeliverables.brief.channels?.value, ["store", "wechat"]);

  for (const text of ["不加小红书同时门店也发", "不加小红书而且门店也发"]) {
    const negatedThenAdded = applyCampaignBriefWrites(initial.brief, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(negatedThenAdded.brief.channels?.value, ["wechat", "store"], text);
  }

  for (const text of ["不要取消微信", "微信不要取消", "不要再加小红书"]) {
    const negatedMutation = applyCampaignBriefWrites(allChannels, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(negatedMutation.brief.channels?.value, ["store", "wechat", "social"], text);
  }
  for (const text of ["别再新增小红书", "无需再增加小红书"]) {
    const negatedAdditionWithoutExistingChannel = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(negatedAdditionWithoutExistingChannel.brief.channels?.value, ["store", "wechat"], text);
  }

  for (const text of ["原渠道不变，只加小红书", "在原有基础上加小红书", "其他不变，加一个小红书"]) {
    const naturalAddition = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(naturalAddition.brief.channels?.value, ["store", "wechat", "social"], text);
  }

  const bareReplacement = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "微信换小红书" },
  ], { text: "微信换小红书" });
  assert.deepEqual(bareReplacement.brief.channels?.value, ["store", "social"]);

  const continuedChannel = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "把微信改成小红书，门店继续" },
  ], { text: "把微信改成小红书，门店继续" });
  assert.deepEqual(continuedChannel.brief.channels?.value, ["store", "social"]);

  for (const text of ["小红书文案也发一版", "同时在小红书发一版文案"]) {
    const contentWithChannelAction = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(contentWithChannelAction.brief.channels?.value, ["store", "wechat", "social"], text);
  }

  const adjacentScopeAndChannel = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "channels", quote: "活动范围是深圳7590门店渠道是微信" },
  ], { text: "活动范围是深圳7590门店渠道是微信" });
  assert.deepEqual(adjacentScopeAndChannel.brief.channels?.value, ["wechat"]);

  const exceptExisting = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "除微信外，再加小红书" },
  ], { text: "除微信外，再加小红书" });
  assert.deepEqual(exceptExisting.brief.channels?.value, ["store", "wechat", "social"]);

  for (const text of ["面向会员，通过微信发布", "面向小红书用户，通过微信发布", "目标是办新品发布会，通过微信宣传"]) {
    const audienceAndObjectiveNotChannels = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(audienceAndObjectiveNotChannels.brief.channels?.value, ["wechat"], text);
  }

  for (const text of ["同时加小红书", "同时投小红书", "同时在小红书", "小红书也要", "再上小红书", "同步发小红书"]) {
    const additionalChannel = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(additionalChannel.brief.channels?.value, ["store", "wechat", "social"], text);
  }

  for (const text of ["小红书不发了", "小红书删了", "小红书别发"]) {
    const removedChannel = applyCampaignBriefWrites(allChannels, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(removedChannel.brief.channels?.value, ["store", "wechat"], text);
  }

  for (const text of ["加小红书", "新增小红书文案", "增加小红书海报"]) {
    const bareAddition = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(bareAddition.brief.channels?.value, ["store", "wechat", "social"], text);
  }

  for (const text of ["不用加小红书", "不需要加小红书", "不用再加小红书", "不需要再加小红书"]) {
    const colloquialNegatedAddition = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(colloquialNegatedAddition.brief.channels?.value, ["store", "wechat"], text);

    const colloquialNegatedExistingAddition = applyCampaignBriefWrites(allChannels, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(colloquialNegatedExistingAddition.brief.channels?.value, ["store", "wechat", "social"], `${text}（已存在）`);
  }
  for (const text of ["不用取消微信", "不需要取消微信"]) {
    const colloquialNegatedRemoval = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(colloquialNegatedRemoval.brief.channels?.value, ["store", "wechat"], text);
  }

  for (const text of [
    "面向会员通过微信发布",
    "面向小红书用户通过微信发布",
    "目标是办新品发布会通过微信宣传",
    "目标是提升门店销售通过微信发布",
    "覆盖深圳门店通过微信发布",
    "面向会员渠道是微信",
  ]) {
    const adjacentBusinessField = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(adjacentBusinessField.brief.channels?.value, ["wechat"], text);
  }

  for (const text of ["取消微信，然后加小红书", "别取消微信但加小红书"]) {
    const commonCompoundMutation = applyCampaignBriefWrites(storeAndWechat, [
      { key: "channels", quote: text },
    ], { text });
    const expected = text.startsWith("取消") ? ["store", "social"] : ["store", "wechat", "social"];
    assert.deepEqual(commonCompoundMutation.brief.channels?.value, expected, text);
  }

  for (const text of ["保留微信，其他都取消", "除了微信其他都不要", "除微信外其他都不要"]) {
    const keepOnlyNamed = applyCampaignBriefWrites(allChannels, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(keepOnlyNamed.brief.channels?.value, ["wechat"], text);
  }
  for (const text of ["保留微信，其他渠道不要改", "保留微信，其他都不要取消"]) {
    const keepAllUnchanged = applyCampaignBriefWrites(allChannels, [
      { key: "channels", quote: text },
    ], { text });
    assert.deepEqual(keepAllUnchanged.brief.channels?.value, ["store", "wechat", "social"], text);
  }

  const transition = applyCampaignBriefWrites(storeAndWechat, [
    { key: "channels", quote: "从微信转到小红书" },
  ], { text: "从微信转到小红书" });
  assert.deepEqual(transition.brief.channels?.value, ["store", "social"]);

  const keepUntouched = applyCampaignBriefWrites(allChannels, [
    { key: "channels", quote: "取消微信，门店照旧" },
  ], { text: "取消微信，门店照旧" });
  assert.deepEqual(keepUntouched.brief.channels?.value, ["store", "social"]);
});

test("a ready 1811 child yields a sheet artifact but never makes the campaign launch-ready", () => {
  const campaign = completeBrief(normalizeCampaignDraft(readyIcs1811()));
  const workspace = buildCampaignWorkspace(campaign, EXAMPLE_TODAY);

  assert.deepEqual(workspace.routing.tracks, ["transaction_offer"]);
  assert.equal(workspace.brief.status, "ready");
  assert.equal(workspace.artifacts.ics1811.status, "sheet_ready");
  assert.equal(workspace.artifacts.ics1811.missingCount, 0);
  assert.equal(workspace.artifacts.ics1811.blockerCount, 0);
  assert.equal(workspace.stage, "needs_confirmation");
  assert.equal(workspace.readiness.status, "needs_confirmation");
  assert.ok(workspace.readiness.gates.some((gate) => gate.status === "needs_confirmation"), "发布前仍须人工确认外部执行准备");
});

test("workspaces without a transaction track mark the 1811 artifact not applicable", () => {
  const workspace = buildCampaignWorkspace(createCampaignDraft("brand", "做传福新品发布会"), EXAMPLE_TODAY);

  assert.equal(workspace.artifacts.ics1811.status, "not_applicable");
  assert.equal(workspace.artifacts.ics1811.missingCount, 0);
  assert.equal(workspace.artifacts.ics1811.blockerCount, 0);
});

test("only objective, audience, theme, and channels block Brief readiness", () => {
  const draft = createCampaignDraft("member-core", "策划一次会员私域触达");
  const text = "目标是促进会员回访，面向沉睡会员，主题是久别重逢，通过微信和私域触达。";
  const result = applyCampaignBriefWrites(draft.brief, [
    { key: "objective", quote: "促进会员回访" },
    { key: "audience", quote: "沉睡会员" },
    { key: "theme", quote: "久别重逢" },
    { key: "channels", quote: "微信和私域" },
  ], { text });
  const workspace = buildCampaignWorkspace({ ...draft, brief: result.brief }, EXAMPLE_TODAY);

  assert.equal(workspace.brief.status, "ready");
  assert.deepEqual(workspace.brief.missing, []);
  assert.equal(workspace.brief.completeCount, 4);
  assert.equal(workspace.brief.totalCount, 4);
  assert.equal(workspace.brief.items.find((item) => item.key === "name")?.required, false);
});

test("brand and member routing share one communication track and keep external checks conditional", () => {
  const draft = createCampaignDraft("brand-member", "做一场会员私域新品发布");
  const text = "目标是促进会员回访，面向沉睡会员，主题是久别重逢，通过微信和私域触达。";
  const result = applyCampaignBriefWrites(draft.brief, [
    { key: "objective", quote: "促进会员回访" },
    { key: "audience", quote: "沉睡会员" },
    { key: "theme", quote: "久别重逢" },
    { key: "channels", quote: "微信和私域" },
  ], { text });
  const workspace = buildCampaignWorkspace({ ...draft, brief: result.brief }, EXAMPLE_TODAY);
  const communicationTracks = workspace.executionTracks.filter((track) => track.kind === "communications");

  assert.equal(communicationTracks.length, 1);
  assert.ok(workspace.executionTracks.some((track) => track.kind === "member_crm"));
  const communications = workspace.readiness.gates.find((gate) => gate.id === "communications");
  assert.equal(workspace.readiness.status, "blocked");
  assert.equal(communications?.status, "blocked");
  assert.match(communications?.nextAction ?? "", /传播方案/);
  const member = workspace.readiness.gates.find((gate) => gate.id === "member_crm");
  assert.equal(member?.status, "needs_confirmation");
  assert.match(member?.nextAction ?? "", /CRM/);
  const external = workspace.readiness.gates.find((gate) => gate.id === "external_readiness");
  assert.equal(external?.status, "pending");
  assert.match(external?.nextAction ?? "", /先完成/);
});

test("a reviewable communication plan clears the machine artifact gate but never auto-approves launch", () => {
  const draft = completeBrief(createCampaignDraft("brand-ready", "做一场新品发布和品牌传播"));
  draft.communication = {
    concept: {
      headline: "为爱添金",
      subheadline: "让心意被看见",
      coreMessage: "面向深圳年轻情侣讲述新品故事",
    },
    channelOutputs: [
      { channel: "store", format: "门店海报", copy: "为爱添金", cta: "到店了解" },
      { channel: "wechat", format: "微信推文", copy: "让心意被看见", cta: "查看新品" },
    ],
    visualDirection: "克制留白，突出珠宝细节",
    source: "ai",
  };

  const workspace = buildCampaignWorkspace(draft, EXAMPLE_TODAY);
  const communications = workspace.readiness.gates.find((gate) => gate.id === "communications");
  const external = workspace.readiness.gates.find((gate) => gate.id === "external_readiness");

  assert.equal(workspace.readiness.status, "needs_confirmation");
  assert.equal(communications?.status, "needs_confirmation");
  assert.match(communications?.nextAction ?? "", /人工审核/);
  assert.equal(external?.status, "needs_confirmation");
});

test("a Brief change that invalidates old channel copy blocks readiness until communication is regenerated", () => {
  const draft = completeBrief(createCampaignDraft("brand-stale", "做一场新品发布和品牌传播"));
  draft.communication = {
    concept: { headline: "为爱添金", subheadline: "让心意被看见", coreMessage: "讲述新品故事" },
    channelOutputs: [
      { channel: "store", format: "门店海报", copy: "为爱添金", cta: "到店了解" },
      { channel: "wechat", format: "微信推文", copy: "让心意被看见", cta: "查看新品" },
    ],
    visualDirection: "克制留白，突出珠宝细节",
    source: "ai",
  };
  const changed = applyCampaignBriefWrites(draft.brief, [
    { key: "channels", quote: "再加小红书" },
  ], { text: "再加小红书" });

  const workspace = buildCampaignWorkspace({ ...draft, brief: changed.brief }, EXAMPLE_TODAY);
  const communicationsGate = workspace.readiness.gates.find((gate) => gate.id === "communications");
  const communicationsTrack = workspace.executionTracks.find((track) => track.kind === "communications");

  assert.equal(workspace.artifacts.communications.status, "draft");
  assert.equal(workspace.readiness.status, "blocked");
  assert.equal(communicationsGate?.status, "blocked");
  assert.match(communicationsGate?.nextAction ?? "", /重新生成/);
  assert.equal(communicationsTrack?.status, "blocked");
});

test("an applicable store-readiness track blocks the launch gate until store scope is known", () => {
  const draft = createCampaignDraft("brand-store", "做一场新品发布和品牌传播");
  const text = "目标是提升新品认知，面向年轻情侣，主题是福启新章，通过门店和微信传播。";
  const brief = applyCampaignBriefWrites(draft.brief, [
    { key: "objective", quote: "提升新品认知" },
    { key: "audience", quote: "年轻情侣" },
    { key: "theme", quote: "福启新章" },
    { key: "channels", quote: "门店和微信" },
  ], { text }).brief;
  const campaign: CampaignDraft = {
    ...draft,
    brief,
    communication: {
      concept: { headline: "福启新章", subheadline: "让心意被看见", coreMessage: "讲述新品故事" },
      channelOutputs: [
        { channel: "store", format: "门店海报", copy: "福启新章", cta: "到店了解" },
        { channel: "wechat", format: "微信推文", copy: "让心意被看见", cta: "查看新品" },
      ],
      visualDirection: "克制留白，突出珠宝细节",
      source: "ai",
    },
  };

  const workspace = buildCampaignWorkspace(campaign, EXAMPLE_TODAY);
  const storeTrack = workspace.executionTracks.find((track) => track.kind === "store_readiness");
  const storeGate = workspace.readiness.gates.find((gate) => gate.id === "store_readiness");

  assert.equal(storeTrack?.status, "blocked");
  assert.equal(storeGate?.status, "blocked");
  assert.equal(workspace.readiness.status, "blocked");
  assert.equal(workspace.stage, "blocked");
});

test("a transaction campaign exposes the communication track once communication was explicitly generated", () => {
  const draft = completeBrief(normalizeCampaignDraft(readyIcs1811()));
  draft.communication = {
    concept: { headline: "为爱添金", subheadline: "让心意被看见", coreMessage: "讲述钻石甄选故事" },
    channelOutputs: [
      { channel: "store", format: "门店海报", copy: "为爱添金", cta: "到店了解" },
      { channel: "wechat", format: "微信推文", copy: "让心意被看见", cta: "查看活动" },
    ],
    visualDirection: "克制留白，突出珠宝细节",
    source: "ai",
  };

  const workspace = buildCampaignWorkspace(draft, EXAMPLE_TODAY);
  const communicationsTrack = workspace.executionTracks.find((track) => track.kind === "communications");
  const communicationsGate = workspace.readiness.gates.find((gate) => gate.id === "communications");

  assert.equal(communicationsTrack?.status, "needs_confirmation");
  assert.equal(communicationsGate?.status, "needs_confirmation");
  assert.equal(workspace.artifacts.communications.status, "needs_review");
});

test("Brief 文本值从原话里剥掉口语壳，依据仍保留整句", () => {
  const text = "我觉得国潮与家国情怀这条路线吧，主要是回馈老会员，受众就是现有会员";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "theme", quote: "我觉得国潮与家国情怀这条路线吧" },
    { key: "objective", quote: "主要是回馈老会员" },
    { key: "audience", quote: "现有会员" },
  ], { text });

  assert.equal(result.brief.theme?.value, "国潮与家国情怀");
  assert.equal(result.brief.theme?.quote, "我觉得国潮与家国情怀这条路线吧");
  assert.equal(result.brief.objective?.value, "回馈老会员");
  // 本来就没有口语壳的照原样，不能越剥越短。
  assert.equal(result.brief.audience?.value, "现有会员");
});

test("剥到空或只剩一个字时退回原话，宁可啰嗦也不能丢内容", () => {
  const text = "就这样吧，主题是新中式";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "scope", quote: "就这样吧" },
  ], { text });
  assert.equal(result.brief.scope?.value, "就这样吧");
});

test("模型整理过的值可以改错别字，原话仍留作依据", () => {
  const text = "1. 主要是品牌曝光 2. 年轻课群吧 3. 门店";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "audience", quote: "年轻课群吧", value: "年轻客群" },
  ], { text });
  assert.equal(result.brief.audience?.value, "年轻客群");
  assert.equal(result.brief.audience?.quote, "年轻课群吧");
});

test("模型可以结合上下文改写措辞，用原话里没有的行业词", () => {
  const text = "1. 希望是能拉到一些新的用户 2. 主要是年轻人情侣结婚 4. 门店";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "objective", quote: "希望是能拉到一些新的用户", value: "拉新" },
    { key: "audience", quote: "主要是年轻人情侣结婚", value: "年轻备婚情侣" },
  ], { text });
  assert.equal(result.brief.objective?.value, "拉新");
  assert.equal(result.brief.audience?.value, "年轻备婚情侣");
});

test("模型不能把用户没说过的数字洗进 Brief", () => {
  const text = "希望是能拉到一些新的用户";
  const invented = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "objective", quote: "希望是能拉到一些新的用户", value: "拉新5000人" },
  ], { text });
  assert.equal(invented.brief.objective?.value, "拉到一些新的用户");

  // 用户自己说过的数字可以带上。
  const said = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "objective", quote: "想拉到5000个新用户", value: "拉新5000人" },
  ], { text: "想拉到5000个新用户" });
  assert.equal(said.brief.objective?.value, "拉新5000人");
});

test("Brief 值是短语不是段落，超长退回剥壳", () => {
  const text = "受众是年轻人";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "audience", quote: "年轻人", value: "一二线城市二十五到三十五岁有稳定收入的年轻女性白领群体" },
  ], { text });
  assert.equal(result.brief.audience?.value, "年轻人");
});

test("模型原样回传整句时按剥壳处理，不退化成原话", () => {
  const text = "我觉得国潮与家国情怀这条路线吧";
  const result = applyCampaignBriefWrites(createEmptyCampaignBrief(), [
    { key: "theme", quote: "我觉得国潮与家国情怀这条路线吧", value: "我觉得国潮与家国情怀这条路线吧" },
  ], { text });
  assert.equal(result.brief.theme?.value, "国潮与家国情怀");
});

test("Brief 原话里出现优惠玩法时就补建 1811，不用等用户再说一遍", () => {
  const draft = createCampaignDraft("guide", "国庆想做个婚嫁体验活动");
  assert.equal(draft.ics1811, null, "首句没提优惠，一开始不建");

  draft.brief.objective = { value: "满2000减300拉新", quote: "满2000减300拉新", via: "text" };
  // 当前这一轮用户只是点头，原话里没有优惠词——旧实现在这里建不出来。
  const ensured = ensureIcs1811Child(draft, "对", () => "ics-1");
  assert.ok(ensured.ics1811, "Brief 里已经有优惠说法，应该补建子草稿");
});

test("判出优惠轨和有没有 1811 子草稿不再自相矛盾", () => {
  const draft = createCampaignDraft("consistent", "国庆想做个婚嫁体验活动");
  draft.brief.objective = { value: "满2000减300拉新", quote: "满2000减300拉新", via: "text" };
  const ensured = ensureIcs1811Child(draft, "", () => "ics-2");

  const routed = routeCampaign(ensured).tracks.includes("transaction_offer");
  const hasChild = ensured.ics1811 !== null;
  assert.equal(routed, hasChild, "判出优惠轨就必须有子草稿，反之亦然");

  const ws = buildCampaignWorkspace(ensured, EXAMPLE_TODAY);
  assert.notEqual(ws.artifacts.ics1811.status, "not_applicable", "不能一边说要配 1811 一边说本活动不需要");
});

test("纯品牌活动仍然不建 1811", () => {
  const draft = createCampaignDraft("brand", "国庆做个新品发布的品牌传播");
  draft.brief.theme = { value: "国潮新品", quote: "国潮新品", via: "text" };
  const ensured = ensureIcs1811Child(draft, "对 跟着品牌发布走", () => "ics-3");
  assert.equal(ensured.ics1811, null);
  assert.ok(!routeCampaign(ensured).tracks.includes("transaction_offer"));
});
