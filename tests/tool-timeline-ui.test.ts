import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanelContext } from "../app/components/workspace/workspace-panel-context.ts";
import type { HistoryMessage } from "../app/lib/client/history-conversation.ts";
import type { Snapshot } from "../app/lib/server/turns.ts";
import type { AgentTraceEvent, ToolTrace } from "../app/lib/tool-trace.ts";
import { loadReactComponent } from "./helpers/react-component.ts";
import { simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";
import type { PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";

const step = (id: string, title: string, extra: Partial<AgentTraceEvent> = {}): AgentTraceEvent => ({ id, title, tool: "analyze_campaign_plan", status: "completed", initiatedBy: "model", startedAt: 1000, durationMs: 2000, summary: "已整理活动目标", ...extra });
const skill = (id: string, title: string, extra: Partial<AgentTraceEvent> = {}) => step(id, `加载业务规则：${title}`, { tool: "load_campaign_skill", ...extra });
const provider = (child: ReturnType<typeof createElement>) => createElement(WorkspacePanelContext.Provider, { value: { panelId: "panel", activeId: null, togglePanel() {}, closePanel() {}, dismissPanel() {} } }, child);

test("成功 Skill 合并中文参考行并去重，真实业务工具保持顺序和摘要", async (t) => {
  const { ToolTimeline } = await loadReactComponent(t, "app/components/chat/tool-timeline.tsx");
  const steps = [skill("s1", "活动编排方法"), skill("s2", "1811 开单流程"), skill("s3", "活动编排方法"), skill("s4", "营销分析方法", { tool: "load_analytics_skill" }), step("b1", "整理活动目标"), step("b2", "检查活动准备", { initiatedBy: "orchestrator", summary: "有一项需要确认" })];
  const html = renderToStaticMarkup(createElement(ToolTimeline, { steps, live: true, startedAt: Date.now() }));
  assert.match(html, /参考了：活动编排方法、1811 开单流程、营销分析方法/);
  assert.equal((html.match(/活动编排方法/g) ?? []).length, 1);
  assert.equal((html.match(/<li\b/g) ?? []).length, 2);
  assert.ok(html.indexOf("整理活动目标") < html.indexOf("检查活动准备"));
  assert.match(html, /已整理活动目标/); assert.match(html, /有一项需要确认/);
  assert.doesNotMatch(html, /load_campaign_skill|load_analytics_skill|analyze_campaign_plan|加载业务规则|确定性执行|系统补跑|Skill\/工具/);
});

test("失败和警告的 Skill 不进入成功参考行，仍保留异常步骤", async (t) => {
  const { ToolTimeline } = await loadReactComponent(t, "app/components/chat/tool-timeline.tsx");
  const steps = [skill("s1", "活动编排方法"), skill("s2", "会员运营方法", { status: "failed", summary: "规则未能加载" }), skill("s3", "传播写作方法", { status: "warning", summary: "规则尚待确认" })];
  const html = renderToStaticMarkup(createElement(ToolTimeline, { steps, live: false, status: "failed", durationMs: 2400 }));
  assert.match(html, /参考了：活动编排方法<\/p>/);
  assert.match(html, /会员运营方法/); assert.match(html, /规则未能加载/); assert.match(html, /规则尚待确认/);
  assert.equal((html.match(/<li\b/g) ?? []).length, 2);
  assert.match(html, /执行失败/); assert.doesNotMatch(html, /已完成/);
});

test("总状态区分完成、警告、失败与取消，完成默认折叠且按钮可由键盘展开", async (t) => {
  const { ToolTimeline } = await loadReactComponent(t, "app/components/chat/tool-timeline.tsx");
  for (const [status, label] of [["completed", "已完成"], ["warning", "需注意"], ["failed", "执行失败"], ["cancelled", "已停止"]] as const) {
    const html = renderToStaticMarkup(createElement(ToolTimeline, { steps: [step("b1", "整理活动目标")], live: false, status, durationMs: 8765 }));
    assert.ok(html.includes(label), status); assert.match(html, /8\.8s/);
    assert.match(html, /<button[^>]*type="button"[^>]*aria-expanded="(?:true|false)"[^>]*aria-controls=/);
    assert.match(html, /select-text/); assert.match(html, /focus-visible:ring/);
    if (status === "completed") { assert.match(html, /aria-expanded="false"/); assert.match(html, /hidden=""/); }
    else assert.doesNotMatch(html, /已完成/);
  }
});

test("停止或失败后未结束的步骤不继续显示进行中或转圈", async (t) => {
  const { ToolTimeline } = await loadReactComponent(t, "app/components/chat/tool-timeline.tsx");
  const pending = step("pending", "读取历史销售", { status: "started", durationMs: undefined, summary: undefined });
  const cancelled = renderToStaticMarkup(createElement(ToolTimeline, { steps: [pending], live: false, status: "cancelled", durationMs: 3000 }));
  assert.match(cancelled, /读取历史销售/); assert.match(cancelled, /已停止/); assert.doesNotMatch(cancelled, /进行中|animate-spin|已完成/);
  const failed = renderToStaticMarkup(createElement(ToolTimeline, { steps: [pending], live: false, status: "failed", durationMs: 3000 }));
  assert.match(failed, /未完成/); assert.doesNotMatch(failed, /进行中|animate-spin|已完成/);
});

test("活动用活动准备标题，已存轨迹使用整轮总耗时", async (t) => {
  const { ToolTimeline } = await loadReactComponent(t, "app/components/chat/tool-timeline.tsx");
  const live = renderToStaticMarkup(createElement(ToolTimeline, { steps: [step("b1", "检查活动准备")], live: true, context: "campaign", startedAt: Date.now() }));
  assert.match(live, /正在准备活动/); assert.match(live, /aria-label="活动准备过程"/); assert.doesNotMatch(live, /正在分析/);
  const { MessageList } = await loadReactComponent(t, "app/components/chat/message-view.tsx");
  const trace: ToolTrace = { status: "warning", durationMs: 500, timing: { totalMs: 8765, analysisWaitingMs: 8265, skillsToolsMs: 500 }, steps: [skill("s1", "活动编排方法"), step("b1", "检查活动准备", { status: "warning", summary: "待确认门店准备" })] };
  const snapshot = { messages: [{ id: "trace", role: "assistant", createdAt: "2026-10-25T01:00:00Z", content: { kind: "agent_tool_trace", trace } }] } as unknown as Snapshot;
  const html = renderToStaticMarkup(createElement(MessageList, { snapshot, actions: { busy: false, onUndo() {}, onRetry() {}, onOpenPanel() {}, onGeneratePromo() {} } }));
  assert.match(html, /参考了：活动编排方法/); assert.match(html, /8\.8s/); assert.match(html, /需注意/); assert.match(html, /活动准备过程/);
  assert.doesNotMatch(html, /AI 工具执行记录|确定性执行|系统补跑|Skill\/工具/);
});

test("活动实时过程与已存过程使用同一个时间线组件", () => {
  const source = readFileSync(new URL("../app/components/chat/conversation.tsx", import.meta.url), "utf8");
  assert.match(source, /<ToolTimeline[^>]*steps=\{liveTrace\}[^>]*live[^>]*startedAt=\{runStartedAt\}[^>]*context="campaign"/);
  assert.doesNotMatch(source, /ToolRunCard|tool-run-card/);
});

test("问答失败与取消的总状态真实保留，尚未完成的工具也可查看", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  for (const [status, label] of [["failed", "执行失败"], ["cancelled", "已停止"]] as const) {
    const message: HistoryMessage = { id: status, role: "assistant", text: "本次未完成", createdAt: "2026-10-25T01:00:00Z", status, trace: [step("b1", "读取历史销售", { status: "started", durationMs: undefined, summary: undefined })], durationMs: 4500 };
    const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message, busy: false, onRetry() {} })));
    assert.match(html, new RegExp(label)); assert.match(html, /读取历史销售/); assert.match(html, /4\.5s/); assert.doesNotMatch(html, /已完成|进行中/);
  }
});

test("问答部分结果和没有最终答案的警告步骤不会显示为全部完成", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const message: HistoryMessage = { id: "warning", role: "assistant", text: "只得到部分结果", createdAt: "2026-10-25T01:00:00Z", status: "done", trace: [step("warning", "读取历史销售", { status: "warning", summary: "部分维度不支持" })], durationMs: 4500 };
  const render = (m: HistoryMessage) => renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: m, busy: false, onRetry() {} })));
  assert.match(render(message), /需注意/); assert.doesNotMatch(render(message), /已完成/);
  const answer: PlanAnswerV4 = { ...simulatedPlanAnswerV4(), status: "partial", trace: { status: "completed", durationMs: 2000, steps: [step("query", "读取历史销售")] } };
  const partial = render({ ...message, answer }); assert.match(partial, /需注意/); assert.doesNotMatch(partial, /已完成/);
});

test("活动停止后保留当时真实轨迹并显示取消状态", () => {
  const source = readFileSync(new URL("../app/components/chat/conversation.tsx", import.meta.url), "utf8");
  assert.match(source, /<ToolTimeline[^>]*steps=\{stoppedTrace\.steps\}[^>]*live=\{false\}[^>]*status="cancelled"/);
  assert.match(source, /setStoppedTrace\(\{[\s\S]*?steps: current\.state\.trace/);
});

test("新问答整理回答不宣称核验，附件继续展示真实核验", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const message: HistoryMessage = { id: "writing", role: "assistant", text: "", createdAt: "2026-10-25T01:00:00Z", status: "running", phase: "writing" };
  const render = (m: HistoryMessage) => renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: m, busy: true, onRetry() {} })));
  const plain = render(message); assert.match(plain, /正在整理回答/); assert.doesNotMatch(plain, /核验/);
  const file = render({ ...message, request: { conversationId: "files", question: "分析附件", attachmentIds: ["file"], history: [] } });
  assert.match(file, /正在核验并整理回答/);
});
