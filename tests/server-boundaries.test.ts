import assert from "node:assert/strict";
import test from "node:test";

import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";
import { createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { isCampaignDraft, isIcs1811Draft, parseCampaignDocument } from "../app/lib/server/request-validation.ts";

test("session routes only accept ics1811/v1 drafts", () => {
  const draft = createEmptyDraft("d", "7590门店钻石类打9折");
  assert.equal(isIcs1811Draft({ id: "partial" }), false);
  assert.equal(isIcs1811Draft({ ...draft, schema: "campaign/v0" }), false);
  assert.equal(isIcs1811Draft(JSON.parse(JSON.stringify(draft))), true, "存进 D1 再读出来的草稿仍然有效");
});

test("campaign/v1 accepts a null or valid optional 1811 child", () => {
  const brand = createCampaignDraft("brand", "策划一场新品发布会");
  const transaction = createCampaignDraft("transaction", "7590门店钻石类打9折");

  assert.equal(brand.ics1811, null);
  assert.equal(isCampaignDraft(JSON.parse(JSON.stringify(brand))), true);
  assert.equal(transaction.ics1811?.schema, "ics1811/v1");
  assert.equal(isCampaignDraft(JSON.parse(JSON.stringify(transaction))), true);
});

test("parseCampaignDocument validates current documents and stably adapts legacy 1811 drafts", () => {
  const current = createCampaignDraft("current", "策划一场会员私域活动");
  assert.deepEqual(parseCampaignDocument(JSON.parse(JSON.stringify(current))), current);

  const legacy = createEmptyDraft("legacy", "7590门店钻石类打9折");
  const before = structuredClone(legacy);
  const first = parseCampaignDocument(legacy);
  const second = parseCampaignDocument(legacy);

  assert.equal(first?.schema, "campaign/v1");
  assert.equal(first?.id, "campaign:legacy");
  assert.deepEqual(first?.ics1811, legacy);
  assert.deepEqual(first, second);
  assert.deepEqual(legacy, before, "适配一份历史版本不能改写原始对象");
});

test("invalid optional children and pre-1811 documents remain legacy", () => {
  const current = createCampaignDraft("current", "7590门店钻石类打9折");
  const invalidChild = {
    ...current,
    ics1811: { ...createEmptyDraft("partial-child", "钻石类打9折"), facts: {} },
  };
  const pre1811 = {
    schema: "campaign/v0",
    id: "old-plan",
    requestText: "旧营销方案",
    proposals: [],
    orders: [],
  };

  assert.equal(isCampaignDraft(invalidChild), false);
  assert.equal(parseCampaignDocument(invalidChild), null);
  assert.equal(parseCampaignDocument(pre1811), null);
  assert.equal(parseCampaignDocument({ ...current, brief: null }), null);
});
