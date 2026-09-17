import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_STAGE_LABEL,
  DEFAULT_WORKSPACE_TAB,
  communicationAction,
  sessionStatusLabel,
  workspaceVersionEntries,
} from "../app/lib/client/campaign-workspace.ts";

test("campaign workspace uses honest parent-stage labels and opens on Brief", () => {
  assert.equal(DEFAULT_WORKSPACE_TAB, "brief");
  assert.equal(CAMPAIGN_STAGE_LABEL.briefing, "整理 Brief");
  assert.equal(CAMPAIGN_STAGE_LABEL.preparing, "准备产物");
  assert.equal(CAMPAIGN_STAGE_LABEL.needs_confirmation, "待上线确认");
  assert.equal(CAMPAIGN_STAGE_LABEL.blocked, "存在阻断");
  assert.equal(CAMPAIGN_STAGE_LABEL.planning, "规划执行轨");
  assert.doesNotMatch(Object.values(CAMPAIGN_STAGE_LABEL).join(" "), /活动建好了|已建好/);
});

test("communication entry remains useful before and after generation", () => {
  assert.equal(communicationAction({ briefReady: false, hasCommunication: false, activeTab: "brief" }), "disabled");
  assert.equal(communicationAction({ briefReady: true, hasCommunication: false, activeTab: "brief" }), "generate");
  assert.equal(communicationAction({ briefReady: true, hasCommunication: true, activeTab: "brief" }), "view");
  assert.equal(communicationAction({ briefReady: true, hasCommunication: true, activeTab: "communications" }), "continue");
});

test("legacy session statuses map to truthful 1811 wording", () => {
  assert.equal(sessionStatusLabel("confirmed"), "1811 已就绪");
  assert.equal(sessionStatusLabel("ics_ready"), "1811 已就绪");
  assert.equal(sessionStatusLabel("preparing"), "准备产物");
  assert.notEqual(sessionStatusLabel("confirmed"), "已建好");
});

test("没有 1811 子单时仍保留 Campaign 版本恢复入口", () => {
  const snapshot = {
    latest: { draft: null },
    versions: [
      { seq: 1, source: "初始需求", createdAt: "2026-09-17T01:00:00.000Z", diffCount: 0 },
      { seq: 2, source: "完善 Brief", createdAt: "2026-09-17T01:01:00.000Z", diffCount: 2 },
    ],
  };
  const entries = workspaceVersionEntries(snapshot);

  assert.deepEqual(entries, [
    { seq: 2, source: "完善 Brief", createdAt: "2026-09-17T01:01:00.000Z", diffCount: 2, current: true },
    { seq: 1, source: "初始需求", createdAt: "2026-09-17T01:00:00.000Z", diffCount: 0, current: false },
  ]);
});
