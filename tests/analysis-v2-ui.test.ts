import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as history from "../app/lib/client/history-conversation.ts";
import type { AnalysisAnswer, AnalysisConclusion } from "../app/lib/analytics/analysis-v2-types.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";
import { analysisAnswerText } from "../app/lib/analytics/analysis-v2-format.ts";
import { loadReactComponent } from "./helpers/react-component.ts";
import { WorkspacePanelContext } from "../app/components/workspace/workspace-panel-context.ts";

async function component(t: { after(fn: () => void): void }, name = "AnalysisAnswerView") {
  const path = resolve("app/components/analytics/analysis-answer.tsx");
  assert.equal(existsSync(path), true, "v2 正文组件应存在");
  const loaded = await loadReactComponent(t, path) as Record<string, ComponentType<{ answer: AnalysisAnswer; conclusion?: AnalysisConclusion }>>;
  assert.equal(typeof loaded[name], "function");
  return function AnswerInWorkspace(props: { answer: AnalysisAnswer; conclusion?: AnalysisConclusion }) { return createElement(WorkspacePanelContext.Provider, { value: { panelId: "workspace-preview", activeId: null, togglePanel() {}, closePanel() {}, dismissPanel() {} } }, createElement(loaded[name], props)); };
}

test("v2 连贯正文内联显示引用和缺失，字面对象名不能注入 Markdown 或 HTML", async (t) => {
  const view = await component(t); const answer = simulatedAnswer();
  answer.evidence.objects[0].label = "模拟[甲店](https://example.invalid)<img onerror=alert(1)>";
  const html = renderToStaticMarkup(createElement(view, { answer }));
  assert.match(html, /模拟\[甲店\]\(https:\/\/example.invalid\)&lt;img/);
  assert.doesNotMatch(html, /<img|href="https:\/\/example.invalid|<table/);
  assert.match(html, /1,234\.56/); assert.match(html, /暂无可计算值|未提供|未计算/); assert.match(html, /2025.*2.*1.*2025.*2.*28/);
  assert.match(html, /查看数据出处1/); assert.match(html, /select-text/);
});

test("UI 正文和复制文字共享邻接单位去重，保留比率与合法词", async (t) => {
  const view = await component(t); const answer = simulatedAnswer();
  answer.evidence.facts[0].unit = "CNY/单"; answer.evidence.facts[0].value = 17.125;
  answer.evidence.facts.push({ ...answer.evidence.facts[0], id: "orders", metricId: "orders", value: 19, unit: "单" });
  answer.blocks = [{ kind: "paragraph", nodes: [{ kind: "text", text: "均额" }, { kind: "fact_ref", factId: "amount" }, { kind: "text", text: "" }, { kind: "text", text: "元，订单" }, { kind: "fact_ref", factId: "orders" }, { kind: "text", text: "单；" }, { kind: "fact_ref", factId: "orders" }, { kind: "text", text: "单笔金额待核对。" }] }];
  const original = structuredClone(answer);
  const html = renderToStaticMarkup(createElement(view, { answer }));
  const body = /<div data-analysis-body="true"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  assert.ok(body, "客户正文应真实渲染");
  const rendered = body.replace(/<[^>]*>/g, "");
  assert.equal(rendered, "均额17.13元/单，订单19单；19单单笔金额待核对。");
  assert.equal(rendered, analysisAnswerText(answer).split("\n\n")[0]);
  assert.deepEqual(answer, original);
});

test("分析正文呈现标题、跨引用加粗和连续列表，复制不带格式标记", async (t) => {
  const view = await component(t); const answer = simulatedAnswer(); delete answer.conclusions[0].action;
  answer.blocks = [
    { kind: "heading", nodes: [{ kind: "text", text: "## 先看结论" }] },
    { kind: "paragraph", conclusionId: "conclusion", nodes: [{ kind: "text", text: "**优先核对" }, { kind: "object_ref", objectId: "store" }, { kind: "text", text: "**，销售额为**" }, { kind: "fact_ref", factId: "amount" }, { kind: "text", text: "**元。成本还需确认。" }] },
    { kind: "heading", nodes: [{ kind: "text", text: "### 下一步" }] },
    { kind: "bullet", conclusionId: "conclusion", nodes: [{ kind: "text", text: "**核对口径**，再判断是否试点。" }] },
    { kind: "bullet", conclusionId: "conclusion", nodes: [{ kind: "text", text: "记录实际变化，不承诺未来收益。" }] },
  ];
  const original = structuredClone(answer); const html = renderToStaticMarkup(createElement(view, { answer }));
  assert.match(html, /<h2[^>]*>[\s\S]*?先看结论[\s\S]*?<\/h2>/);
  assert.match(html, /<h3[^>]*>[\s\S]*?下一步[\s\S]*?<\/h3>/);
  assert.match(html, /<strong[^>]*>[\s\S]*?优先核对[\s\S]*?模拟甲店[\s\S]*?<\/strong>/);
  assert.match(html, /<strong[^>]*>[\s\S]*?1,234\.56元[\s\S]*?<\/strong>/);
  assert.equal((html.match(/<ul\b/g) ?? []).length, 1, "连续事项应作为同一列表，保留各自出处");
  assert.doesNotMatch(html, /\*\*|## /);
  const copied = analysisAnswerText(answer);
  assert.match(copied, /优先核对模拟甲店，销售额为1,234\.56元。成本还需确认。/);
  assert.doesNotMatch(copied, /\*\*|## /);
  assert.deepEqual(answer, original, "排版不改变已核验回答或来源");
});

test("加粗内的业务对象仍按字面展示，不能注入标题、列表或链接", async (t) => {
  const view = await component(t); const answer = simulatedAnswer(); delete answer.conclusions[0].action;
  const label = "**模拟甲店**\n## 伪标题\n- [来源](https://example.invalid)<img onerror=alert(1)>";
  answer.evidence.objects[0].label = label;
  answer.blocks = [{ kind: "paragraph", nodes: [{ kind: "text", text: "核对**" }, { kind: "object_ref", objectId: "store" }, { kind: "text", text: "**后再决定。" }] }];
  const html = renderToStaticMarkup(createElement(view, { answer }));
  assert.match(html, /<strong[^>]*>[\s\S]*?\*\*模拟甲店\*\*[\s\S]*?<\/strong>/);
  assert.doesNotMatch(html, /<h[1-6]\b|<ul\b|<a\b|<img\b/);
  assert.ok(analysisAnswerText(answer).includes(label), "复制保留对象原名，不把名称中的标记当排版");
});

test("动作已通过加粗和对象引用表达时不再次补写相同动作", async (t) => {
  const view = await component(t); const answer = simulatedAnswer();
  answer.conclusions[0].action = "在模拟甲店核对口径";
  answer.blocks = [{ kind: "bullet", conclusionId: "conclusion", nodes: [{ kind: "text", text: "在**" }, { kind: "object_ref", objectId: "store" }, { kind: "text", text: "**核对口径。" }] }];
  const html = renderToStaticMarkup(createElement(view, { answer }));
  assert.doesNotMatch(html, /建议动作：/);
  assert.equal(analysisAnswerText(answer).split("在模拟甲店核对口径").length - 1, 1);
});

test("出处只列引用数据和必要来源信息，不重复结论、方法及解释", async (t) => {
  const source = await component(t, "AnalysisSourceData"); const answer = simulatedAnswer();
  answer.evidence.frames.push({ ...answer.evidence.frames[0], id: "second-frame", scope: { ...answer.evidence.frames[0].scope, filters: {} } });
  answer.evidence.facts[1].frameId = "second-frame";
  const original = structuredClone(answer);
  const html = renderToStaticMarkup(createElement(source, { answer, conclusion: answer.conclusions[0] }));
  assert.match(html, /<table/); assert.match(html, /销售额/); assert.match(html, /1,234\.56元/); assert.match(html, /暂无可计算值/);
  assert.equal((html.match(/2025-02-01/g) ?? []).length, 1, "相同来源周期不要逐个重复解释");
  assert.equal((html.match(/synthetic-version/g) ?? []).length, 1, "相同数据版本只保留一份");
  assert.doesNotMatch(html, /对应结论|验证办法|本方法已完成|币种核对|尚未与业务对数|不能视为活动增量/);
  assert.deepEqual(answer, original, "仅精简展示，不删改来源记录");
});

test("精简出处仍保留计算依据，并将不同周期的数据分开列出", async (t) => {
  const source = await component(t, "AnalysisSourceData"); const answer = simulatedAnswer();
  answer.evidence.frames.push({ ...answer.evidence.frames[0], id: "prior-frame", datasetVersion: "prior-version", scope: { ...answer.evidence.frames[0].scope, period: { start: "2025-01-01", end: "2025-01-31" } } });
  answer.evidence.facts.push({ ...answer.evidence.facts[0], id: "prior-amount", frameId: "prior-frame", label: "参照期销售额", value: 1000 }, { ...answer.evidence.facts[0], id: "difference", label: "销售额差值", value: 234.56, derivation: { op: "subtract", args: [{ factId: "amount" }, { factId: "prior-amount" }] } });
  answer.conclusions[0].factIds = ["difference"];
  const html = renderToStaticMarkup(createElement(source, { answer, conclusion: answer.conclusions[0] }));
  assert.equal((html.match(/<table\b/g) ?? []).length, 2);
  assert.match(html, /2025-02-01[\s\S]*?1,234\.56元[\s\S]*?234\.56元[\s\S]*?2025-01-01[\s\S]*?1,000\.00元/);
  assert.match(html, /synthetic-version/); assert.match(html, /prior-version/);
  assert.doesNotMatch(html, /对应结论|验证办法|逐行按分汇总/);
});

test("已复核的具体动作不因模型漏写到正文而消失，页面与复制均显示且不重复", async (t) => {
  const view = await component(t); const answer = simulatedAnswer();
  answer.conclusions[0].action = "在试点门店统一采集会员身份并告知现有权益，保持价格规则不变。";
  const original = structuredClone(answer);
  const action = answer.conclusions[0].action;
  const html = renderToStaticMarkup(createElement(view, { answer }));
  const body = /<div data-analysis-body="true"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  assert.ok(body?.includes(action), "具体操作应在客户正文显示");
  assert.ok(analysisAnswerText(answer).includes(action), "复制及续轮上下文保留同一操作");
  assert.deepEqual(answer, original, "仅展示已核验字段，不改原报告或正文节点");
  const pending = structuredClone(answer); pending.status = "incomplete"; pending.review = { verdict: "revise", issues: [] };
  assert.ok(!analysisAnswerText(pending).includes(action), "未通过复核的附加动作不能补入正文");
  assert.ok(!renderToStaticMarkup(createElement(view, { answer: pending })).includes(action));
  answer.blocks.push({ kind: "paragraph", conclusionId: answer.conclusions[0].id, nodes: [{ kind: "text", text: action }] });
  const shown = renderToStaticMarkup(createElement(view, { answer }));
  const displayed = /<div data-analysis-body="true"[^>]*>([\s\S]*?)<\/div>/.exec(shown)?.[1] ?? "";
  assert.equal(displayed.split(action).length - 1, 1);
  assert.equal(analysisAnswerText(answer).split(action).length - 1, 1);
});

test("有条件及未完成答案公开具体边界，不把未做事项称为分析完成", async (t) => {
  const view = await component(t);
  const conditional = simulatedAnswer(); conditional.status = "conditional"; conditional.task.needs[0].status = "conditional"; conditional.review.verdict = "accept_conditional";
  conditional.conclusions[0].limitations = ["缺少成本，尚不能比较利润效果"];
  const html = renderToStaticMarkup(createElement(view, { answer: conditional }));
  assert.match(html, /role="status"/); assert.match(html, /缺少成本，尚不能比较利润效果/);
  const incomplete = simulatedAnswer(); incomplete.status = "incomplete"; incomplete.task.needs[0].status = "open"; incomplete.review = { verdict: "revise", issues: [{ kind: "missing_evidence", needIds: ["need"], conclusionIds: ["conclusion"], requirement: "仍需执行同店对照" }] };
  const pending = renderToStaticMarkup(createElement(view, { answer: incomplete }));
  assert.match(pending, /尚未完成/); assert.match(pending, /仍需执行同店对照/); assert.doesNotMatch(pending, /分析完成|分析已完成/);
});

test("未形成结论的未完成分析仍可打开已核验依据，不能虚构结论出处", async (t) => {
  const view = await component(t); const answer = simulatedAnswer();
  answer.status = "incomplete"; answer.conclusions = []; answer.blocks = [{ kind: "paragraph", nodes: [{ kind: "text", text: "当前仍需完成可比对照，暂未形成可采用的经营判断。" }] }];
  answer.task.needs[0].status = "open"; answer.task.needs[0].conclusionIds = [];
  answer.review = { verdict: "revise", issues: [{ kind: "missing_evidence", needIds: ["need"], conclusionIds: [], requirement: "仍需执行可比对照" }] };
  const html = renderToStaticMarkup(createElement(view, { answer }));
  assert.match(html, /查看已核验依据/); assert.match(html, /尚未完成/); assert.doesNotMatch(html, /查看数据出处1/);
});

test("刷新恢复 v2 原结构，旧 v1 会话依旧显示，挂起消息结束为取消", () => {
  const values = new Map<string, string>(); const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = history.createHistoryConversationStore(persistence); const id = store.activeId(); const answer = simulatedAnswer();
  store.update(() => [{ id: "v2", role: "assistant", text: "正文", answer, status: "done", createdAt: "2026-10-13T00:00:00Z" }, { id: "pending", role: "assistant", text: "", status: "running", createdAt: "2026-10-13T00:01:00Z" }], id);
  const restored = history.createHistoryConversationStore(persistence);
  assert.deepEqual(restored.snapshot()[0].answer, answer); assert.equal(restored.snapshot()[1].status, "cancelled");
  values.clear(); const old = { id: "old", role: "assistant", text: "旧寒暄", answer: quickAnalyticsReply("你好"), createdAt: "2026-10-12T00:00:00Z" };
  values.set("ctf:history-conversation:v1", JSON.stringify([old]));
  assert.deepEqual(history.createHistoryConversationStore(persistence).snapshot()[0], old);
});

test("存储中的损坏 v2 不直接显示为旧回答", () => {
  const answer = simulatedAnswer(); answer.blocks[1].nodes.push({ kind: "fact_ref", factId: "invented" });
  const persistence = { getItem: () => JSON.stringify({ activeId: "thread", threads: [{ id: "thread", title: "模拟", updatedAt: "2026-10-13T00:00:00Z", campaignId: null, context: [], messages: [{ id: "bad", role: "assistant", text: "未核验内容", answer, status: "done", createdAt: "2026-10-13T00:00:00Z" }] }] }), setItem() {} };
  const message = history.createHistoryConversationStore(persistence).snapshot()[0];
  assert.equal(message.answer, undefined); assert.equal(message.status, "failed"); assert.match(message.text, /完整性|核验/);
});

test("下一轮历史使用渲染正文及公开结构化范围，不传播快照内部信息", () => {
  const context = (history as unknown as { historyMessageContext: (message: unknown) => string }).historyMessageContext;
  assert.equal(typeof context, "function");
  const text = context({ id: "answer", role: "assistant", text: "不能替代渲染正文", answer: simulatedAnswer(), createdAt: "2026-10-13T00:00:00Z" });
  assert.match(text, /模拟甲店.*1,234\.56/); assert.match(text, /公开分析范围/); assert.match(text, /2025-02-01/); assert.match(text, /sales/);
  assert.doesNotMatch(text, /synthetic-record|synthetic-snapshot|synthetic-version|不能替代渲染正文|SQL|operation/);
});

test("长对话摘要在单条历史限额内仍保留正文、硬范围与用户来源", () => {
  const answer = simulatedAnswer(); answer.task.hardScope = { filters: { stores: ["模拟甲店"] } }; answer.task.context = ["只看模拟甲店", ...Array.from({ length: 199 }, (_, index) => `模拟追问${index}：${"继续核对当前候选。".repeat(45)}`)];
  const text = history.historyMessageContext({ id: "long", role: "assistant", text: "", answer, createdAt: "2026-10-13T00:00:00Z" });
  assert.ok(text.length <= 4000, "下一轮 history 不能靠外层截断丢失正文");
  assert.match(text, /hardScope/); assert.match(text, /只看模拟甲店/); assert.match(text, /模拟甲店.*1,234\.56/); assert.match(text, /公开分析范围/);
});
