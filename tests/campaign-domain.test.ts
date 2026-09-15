import assert from "node:assert/strict";
import test from "node:test";

import {
  createMotherDaySeed,
  createVisibilityOnlySeed,
} from "../app/lib/campaign/demo-seeds.ts";
import {
  buildIcsDrafts,
  calculateOrderCount,
} from "../app/lib/campaign/split-orders.ts";
import { applyPatch, diffDrafts } from "../app/lib/campaign/patcher.ts";
import { validateDraft } from "../app/lib/campaign/validator.ts";
import { mergeInterpretation, rehydrateSessionVersions } from "../app/lib/campaign/workspace-state.ts";

test("seed retains provenance and evidence vintage", () => {
  const draft = createMotherDaySeed();

  assert.equal(draft.intent.occasion.value, "日历节点");
  assert.equal(draft.intent.occasion.provenance, "user");
  assert.equal(draft.scope.channels.vintage?.year, 2021);
  assert.equal(draft.offer.tiers[0].discountRate, null);
  assert.equal(draft.offer.tiers[0].amountOff, 300);
});

test("ICS count is the product of all explicit split dimensions", () => {
  const draft = createMotherDaySeed();
  draft.schedule.batches = [
    draft.schedule.batches[0],
    { ...draft.schedule.batches[0], id: "batch-2" },
  ];
  draft.scope.markets.value = ["内地", "港澳"];
  draft.scope.channels.value = ["线下", "线上"];
  draft.offer.tiers = [
    draft.offer.tiers[0],
    { ...draft.offer.tiers[0], id: "tier-2", thresholdAmount: 5000 },
  ];

  const summary = calculateOrderCount(draft);

  assert.equal(summary.total, 16);
  assert.deepEqual(summary.factors, {
    batches: 2,
    markets: 2,
    channels: 2,
    scopeUnits: 1,
    offerTiers: 2,
  });
});

test("visibility-only campaigns never create ICS orders", () => {
  const draft = createVisibilityOnlySeed();

  assert.equal(calculateOrderCount(draft).total, 0);
  assert.deepEqual(buildIcsDrafts(draft), []);
});

test("changing a discount produces one isolated diff", () => {
  const before = createMotherDaySeed();
  const after = applyPatch(before, [
    {
      op: "replace",
      path: "/offer/tiers/0/discountRate",
      value: 0.82,
      reason: "用户改为 8.2 折",
      provenance: "user",
    },
  ]);

  assert.equal(after.offer.tiers[0].discountRate, 0.82);
  assert.equal(after.brief.externalName, before.brief.externalName);
  assert.deepEqual(diffDrafts(before, after), [
    {
      path: "/offer/tiers/0/discountRate",
      before: null,
      after: 0.82,
    },
  ]);
});

test("patcher rejects prototype traversal", () => {
  const draft = createMotherDaySeed();

  assert.throws(
    () =>
      applyPatch(draft, [
        {
          op: "replace",
          path: "/__proto__/polluted",
          value: true,
          reason: "invalid",
          provenance: "user",
        },
      ]),
    /不允许修改该字段/,
  );
});

test("validator blocks missing operational constants", () => {
  const draft = createMotherDaySeed();
  draft.operations.concessionRate.value = null;
  draft.operations.collectionRate.value = null;

  const issues = validateDraft(draft, buildIcsDrafts(draft));

  assert.deepEqual(
    issues.filter((issue) => issue.severity === "blocker").map((issue) => issue.ruleId),
    ["R13", "R13"],
  );
});

test("validator warns, but does not block, when a rate exceeds one", () => {
  const draft = createMotherDaySeed();
  draft.operations.collectionRate.value = 1.1;

  const issues = validateDraft(draft, buildIcsDrafts(draft));

  assert.equal(issues.some((issue) => issue.ruleId === "R14" && issue.severity === "warning"), true);
  assert.equal(issues.some((issue) => issue.ruleId === "R14" && issue.severity === "blocker"), false);
});

test("validator catches assigned item master switch silent failure", () => {
  const draft = createMotherDaySeed();
  draft.products.assignedItems = ["A1024"];
  draft.products.assignedItemMode = false;

  const issues = validateDraft(draft, buildIcsDrafts(draft));

  assert.equal(issues.some((issue) => issue.ruleId === "R12" && issue.severity === "blocker"), true);
});

test("AI interpretation prefills only understood fields and keeps explicit values", () => {
  const draft = mergeInterpretation("华东母亲节满3000减300", {
    summary: "华东母亲节满减",
    fields: {
      occasion: "日历节点",
      reason: "母亲节",
      customerAction: "下单",
      productCategories: ["黄金类"],
      offerMechanism: "门槛型",
      thresholdAmount: 3000,
      amountOff: 300,
      region: "华东区",
      markets: ["内地"],
      channels: ["线下"],
    },
    unresolved: ["结束日期"],
  });

  assert.equal(draft.offer.tiers[0].thresholdAmount, 3000);
  assert.equal(draft.offer.tiers[0].amountOff, 300);
  assert.equal(draft.offer.tiers[0].discountRate, null);
  assert.equal(draft.scope.regionCode, "华东区（请在生产界面选择）");
  assert.equal(draft.intent.occasion.provenance, "user");
  assert.deepEqual(draft.audience.segments.value, []);
  assert.equal(draft.audience.segments.provenance, "pending");
  assert.equal(draft.products.series, "");
  assert.equal(draft.audience.membership.value, "还没定");
  assert.equal(draft.schedule.batches[0].startDate, "");
  assert.equal(draft.schedule.batches[0].endDate, "");
  assert.deepEqual(draft.unresolved, ["结束日期", "区域编码需在 1811 生产界面确认"]);
});

test("saved session rows rehydrate immutable version history", () => {
  const first = createMotherDaySeed();
  const second = applyPatch(first, [{
    op: "replace",
    path: "/brief/externalName",
    value: "她的光芒",
    reason: "用户修改活动名",
    provenance: "ai",
  }]);

  const versions = rehydrateSessionVersions([
    { seq: 1, draft: first, orders: buildIcsDrafts(first), createdBy: "human", createdAt: "2026-09-15T08:00:00.000Z" },
    { seq: 2, draft: second, orders: buildIcsDrafts(second), createdBy: "ai", createdAt: "2026-09-15T08:01:00.000Z" },
  ]);

  assert.equal(versions.length, 2);
  assert.equal(versions[1].source, "ai");
  assert.equal(versions[1].diffs[0].path, "/brief/externalName");
});
