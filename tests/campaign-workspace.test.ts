import assert from "node:assert/strict";
import test from "node:test";

import { applyCampaignBriefWrites, createEmptyCampaignBrief } from "../app/lib/campaign/brief.ts";
import type { CampaignDraft } from "../app/lib/campaign/types.ts";
import { buildCampaignWorkspace, createCampaignDraft, normalizeCampaignDraft, routeCampaign } from "../app/lib/campaign/workspace.ts";
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
    { key: "name", quote: "传福新章", value: "别的名字" },
    { key: "objective", quote: "提升新品认知", value: "提升销量100%" },
    { key: "audience", quote: "年轻情侣", value: "所有消费者" },
    { key: "theme", quote: "福启新章", value: "别的主题" },
    { key: "channels", quote: "门店和微信", value: ["ecommerce"] },
    { key: "timing", quote: "十月", value: "全年" },
    { key: "scope", quote: "深圳", value: "全国" },
  ], { text });

  assert.deepEqual(result.applied, ["name", "objective", "audience", "theme", "channels", "timing", "scope"]);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.brief.name?.value, "传福新章");
  assert.equal(result.brief.objective?.value, "提升新品认知");
  assert.equal(result.brief.audience?.value, "年轻情侣");
  assert.equal(result.brief.theme?.value, "福启新章");
  assert.deepEqual(result.brief.channels?.value, ["store", "wechat"]);
  assert.equal(result.brief.timing?.value, "十月");
  assert.equal(result.brief.scope?.value, "深圳");
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
  const external = workspace.readiness.gates.find((gate) => gate.id === "external_readiness");
  assert.match(external?.nextAction ?? "", /^如适用，人工确认审阅\/审批、库存、物料、渠道配置和发布时间$/);
});
