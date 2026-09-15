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

test("seed retains provenance and evidence vintage", () => {
  const draft = createMotherDaySeed();

  assert.equal(draft.intent.occasion.value, "日历节点");
  assert.equal(draft.intent.occasion.provenance, "user");
  assert.equal(draft.scope.channels.vintage?.year, 2021);
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
      before: 0.8,
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

