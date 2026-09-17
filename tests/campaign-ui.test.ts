import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CAMPAIGN_STAGE_LABEL,
  DEFAULT_WORKSPACE_TAB,
  communicationAction,
  sessionStatusLabel,
  workspaceVersionEntries,
} from "../app/lib/client/campaign-workspace.ts";

const emptyStateSource = readFileSync(new URL("../app/components/chat/empty-state.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../app/components/chat/composer.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const conversationSource = readFileSync(new URL("../app/components/chat/conversation.tsx", import.meta.url), "utf8");
const thinkingSource = readFileSync(new URL("../app/components/chat/thinking-indicator.tsx", import.meta.url), "utf8");
const globalsSource = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("streaming turns expose a real stop control and keep the wave below tool traces", () => {
  assert.match(composerSource, /Square/);
  assert.match(composerSource, /停止生成/);
  assert.match(conversationSource, /new AbortController\(\)/);
  assert.match(conversationSource, /onStop=/);
  assert.match(conversationSource, /继续理解/);
  assert.match(conversationSource, /inFlightTurn/);
  assert.match(conversationSource, /setInput\(\(current\)/);
  assert.match(conversationSource, /caught instanceof ApiError && caught\.status === 409/);
  assert.match(conversationSource, /latestUserText\(next\) === text/);
  assert.match(conversationSource, /trim\(\)\.slice\(0, 1000\)/);
  assert.match(composerSource, /maxLength=\{1000\}/);
  assert.match(conversationSource, /!stopping && !liveReply\.text && waiting/);
  assert.doesNotMatch(conversationSource, /!liveTrace\.length\s*&&\s*!liveReply\.text\s*&&\s*waiting/);
  assert.match(thinkingSource, /thinking-wave-dot/);
  assert.match(globalsSource, /@keyframes thinking-wave/);
});

test("成功回合与 409 对账会清掉首次理解的停止状态", () => {
  const loadSource = conversationSource.slice(conversationSource.indexOf("const load ="), conversationSource.indexOf("  useEffect(() => {\n    let cancelled"));
  const sendSource = conversationSource.slice(conversationSource.indexOf("const send ="), conversationSource.indexOf("const sendRef ="));
  const clearsStoppedInterpretation = /setSnapshot\(next\);\s+if \(next\.flow\.pendingInterpretation === false\) setInterpretationStopped\(false\);/;
  assert.match(loadSource, clearsStoppedInterpretation, "409 对账后的已完成结果应清除停止状态");
  assert.match(sendSource, clearsStoppedInterpretation, "补充内容成功后应清除停止状态");
  assert.match(sendSource, /caught instanceof ApiError && caught\.status === 409\) return await load\(\)/);
});

test("home starts a general marketing conversation without an activity-description length gate", () => {
  assert.match(emptyStateSource, /周大福营销活动 Agent/);
  assert.match(emptyStateSource, /从一句[“\"]你好[”\"]开始也可以/);
  assert.doesNotMatch(emptyStateSource, /trim\(\)\.length\s*<\s*4/);
  assert.doesNotMatch(emptyStateSource, /请用一句话说明活动/);
  assert.match(composerSource, /value\.trim\(\)\.length\s*>\s*0/);
  assert.doesNotMatch(composerSource, /value\.trim\(\)\.length\s*>\s*[1-9]/);
  assert.match(layoutSource, /title:\s*["']周大福营销活动 AI 工作台["']/);
  assert.doesNotMatch(layoutSource, /title:\s*["'][^"']*ICS-1811/);
});

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
