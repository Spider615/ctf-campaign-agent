import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MODEL_QUOTA_MESSAGE } from "../app/lib/agent/service-errors.ts";
import { createHistoryConversationStore, type HistoryMessage } from "../app/lib/client/history-conversation.ts";
import { createBackgroundRegistry } from "../app/lib/client/background-turns.ts";
import { analyticsRequest } from "../app/lib/client/analytics.ts";
import { postHistoryStream } from "../app/lib/client/history-stream.ts";
import { UnavailableAttachmentsError } from "../app/lib/client/attachments.ts";
import { analyticsAnswerText } from "../app/lib/analytics/stream.ts";
import { WorkspacePanelContext } from "../app/components/workspace/workspace-panel-context.ts";
import { loadReactComponent } from "./helpers/react-component.ts";
import { simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";

const rawQuota = 'API Error: Request rejected (429) · {"error":{"type":"quota_exceeded","message":"monthly budget exhausted","database":"私有诊断","request_id":"private-request"}}';
const request = { mode: "database" as const, question: "合成验收问题", history: [], context: [] };
const message = (extra: Partial<HistoryMessage> = {}): HistoryMessage => ({ id: "reply", role: "assistant", text: rawQuota, createdAt: "2026-10-25T07:00:00Z", status: "failed", durationMs: 1500, request, ...extra });
const provider = (child: ReturnType<typeof createElement>) => createElement(WorkspacePanelContext.Provider, { value: { panelId: "panel", activeId: null, togglePanel() {}, closePanel() {}, dismissPanel() {} } }, child);
const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

// 执行真实组件里的请求动作，保留真实 store、请求解析器和错误工具；只合成 fetch 响应。
// 整页组件的路由依赖不能直接在 Node strip-types 中加载，因此沿用 UI 测试的 AST 提取方式。
async function action(t: { after(fn: () => void): void }, name: string, bindings: Record<string, unknown>) {
  const source = ts.createSourceFile("history-conversation.tsx", readFileSync("app/components/analytics/history-conversation.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(initializer, `真实组件缺少 ${name} 动作`);
  const folder = mkdtempSync(resolve("node_modules/.cache-history-quota-ui-")); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = resolve(folder, "action.tsx");
  const errors = pathToFileURL(resolve("app/lib/agent/service-errors.ts")).href;
  writeFileSync(file, `import { publicAgentError, modelQuotaMessage } from ${JSON.stringify(errors)};\nexport function createAction(bindings) { const { ${Object.keys(bindings).join(", ")} } = bindings; return ${initializer.getText(source)}; }`);
  return (await loadReactComponent(t, file)).createAction(bindings);
}

test("问答 catch 通过公共工具归一额度错误，存为失败并实际渲染中文告警", async (t) => {
  const store = createHistoryConversationStore(memory()); const id = store.activeId();
  const registry = createBackgroundRegistry<{ replyId?: string; clock: number }>();
  const seen: string[] = []; let detail = rawQuota;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    seen.push(input);
    assert.ok(input === "/api/analytics/access" || input === "/api/analytics/history", "禁止真实上游请求");
    return new Response(JSON.stringify(input.endsWith("/access") ? {} : { error: detail }), { status: input.endsWith("/access") ? 200 : 429 });
  });
  const perform = await action(t, "perform", {
    executionLock: { current: false }, now: () => 100, analysisTurns: registry, conversationId: id, setError() {},
    setMessages: (change: (items: HistoryMessage[]) => HistoryMessage[]) => store.update(change, id),
    analyticsRequest, postHistoryStream, UnavailableAttachmentsError, analyticsAnswerText,
    owns: (token: symbol) => registry.isLive(id, token), markUnavailable() {},
  });
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  for (detail of [rawQuota, "数据库服务 monthly budget exhausted", "Claude API: monthly budget exhausted", MODEL_QUOTA_MESSAGE]) {
    store.update(() => [message({ text: "", status: "running" })], id);
    await perform(request, "reply");
    const saved = store.snapshot()[0];
    assert.equal(saved.status, "failed"); assert.equal(saved.text, MODEL_QUOTA_MESSAGE); assert.equal(registry.has(id), false);
    const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: saved, busy: false, onRetry() {} })));
    assert.match(html, /role="alert"/); assert.ok(html.includes(MODEL_QUOTA_MESSAGE)); assert.match(html, /执行失败|重试本次回答/);
    assert.doesNotMatch(html, /API Error|429|monthly budget|private-request|Claude|已完成/);
  }
  assert.equal(seen.length, 8);
});

test("问答 catch 不把普通429或上下文超长归为额度不足，继续保留身份清洗和连接错误提示", async (t) => {
  let saved: HistoryMessage[] = [message()]; let detail = "";
  const registry = createBackgroundRegistry<{ replyId?: string; clock: number }>(); const id = "other-errors";
  t.mock.method(globalThis, "fetch", async (input: string) => new Response(JSON.stringify(input.endsWith("/access") ? {} : { error: detail }), { status: input.endsWith("/access") ? 200 : 429 }));
  const perform = await action(t, "perform", {
    executionLock: { current: false }, now: () => 100, analysisTurns: registry, conversationId: id, setError() {},
    setMessages: (change: (items: HistoryMessage[]) => HistoryMessage[]) => { saved = change(saved); },
    analyticsRequest, postHistoryStream, UnavailableAttachmentsError, analyticsAnswerText,
    owns: (token: symbol) => registry.isLive(id, token), markUnavailable() {},
  });
  for (const [raw, expected] of [["API Error: 429 rate limit exceeded", "API Error: 429 rate limit exceeded"], ["context_length_exceeded: maximum context length", "context_length_exceeded: maximum context length"], ["Claude Code process exited", "Agent 执行出错"], ["数据库连接不可用", "这次回答暂时无法完成，你的问题已保留，可以稍后重试。"]]) {
    detail = raw; await perform(request, "reply");
    assert.equal(saved[0].status, "failed"); assert.equal(saved[0].text, expected); assert.notEqual(saved[0].text, MODEL_QUOTA_MESSAGE);
  }
});

test("失败旧消息仅归一展示，不改写原消息和本地持久化原文", async (t) => {
  const local = memory(); const store = createHistoryConversationStore(local); const id = store.activeId();
  store.update(() => [message({ text: "monthly budget exhausted; request_id=private-request" })], id);
  const before = JSON.stringify([...local.values]); const original = structuredClone(store.snapshot());
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: store.snapshot()[0], busy: false, onRetry() {} })));
  assert.ok(html.includes(MODEL_QUOTA_MESSAGE)); assert.doesNotMatch(html, /monthly budget|private-request|已完成/);
  assert.deepEqual(store.snapshot(), original); assert.equal(JSON.stringify([...local.values]), before);
});

test("旧done消息的明确上游错误覆盖误存的成功答案，时间线改显示失败", async (t) => {
  const answer = simulatedPlanAnswerV4();
  answer.body = [{ kind: "markdown", text: rawQuota, refs: [] }];
  answer.trace = { status: "completed", durationMs: 1500, steps: [{ id: "read", tool: "analyze", title: "读取合成结果", summary: "合成结果已读", initiatedBy: "model", status: "completed", startedAt: 1000, durationMs: 1000 }] };
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  for (const text of [rawQuota, `分析运行未完成：${rawQuota}`, `本次问答执行未完成：${rawQuota}`]) {
    const old = message({ status: "done", text, answer }); const before = structuredClone(old);
    const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: old, busy: false, onRetry() {} })));
    assert.ok(html.includes(MODEL_QUOTA_MESSAGE)); assert.match(html, /执行失败/); assert.match(html, /role="alert"/); assert.match(html, /重试本次回答/);
    assert.doesNotMatch(html, /API Error|429|quota_exceeded|monthly budget|private-request|已完成/); assert.deepEqual(old, before);
  }
});

test("用户原文与成功业务回答即使讨论额度错误也保持原样", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  const user = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: message({ role: "user", text: rawQuota, status: undefined }), busy: false, onRetry() {} })));
  assert.ok(user.includes("quota_exceeded")); assert.ok(user.includes("monthly budget exhausted")); assert.ok(!user.includes(MODEL_QUOTA_MESSAGE));
  const text = "如果出现 quota_exceeded 或 monthly budget exhausted，请联系管理员；这只是错误处理说明。";
  const answer = simulatedPlanAnswerV4(); answer.body = [{ kind: "markdown", text, refs: [] }];
  const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: message({ status: "done", text, answer }), busy: false, onRetry() {} })));
  assert.ok(html.includes("quota_exceeded")); assert.ok(html.includes("monthly budget exhausted"));
  assert.doesNotMatch(html, /role="alert"|执行失败|重试本次回答/); assert.ok(!html.includes(MODEL_QUOTA_MESSAGE));
});

test("失败消息的普通429、上下文错误不误报额度，取消消息仍保留停止状态", async (t) => {
  const { HistoryMessageView } = await loadReactComponent(t, "app/components/analytics/history-message.tsx");
  for (const text of ["API Error: 429 rate limit exceeded", "context_length_exceeded: maximum context length"]) {
    const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: message({ text }), busy: false, onRetry() {} })));
    assert.ok(html.includes(text)); assert.ok(!html.includes(MODEL_QUOTA_MESSAGE)); assert.match(html, /role="alert"/);
  }
  const html = renderToStaticMarkup(provider(createElement(HistoryMessageView, { message: message({ status: "cancelled", text: "已停止本次回答，你可以继续追问。" }), busy: false, onRetry() {} })));
  assert.match(html, /已停止/); assert.doesNotMatch(html, /执行失败|已完成/);
});

test("活动衔接catch只归一错误展示并保留输入，不改变活动业务动作", async (t) => {
  const registry = createBackgroundRegistry<{ clock: number; pendingCreation?: string }>(); const id = "campaign-error";
  let error = ""; let input = "";
  const createCampaign = await action(t, "createCampaign", {
    now: () => 100, analysisTurns: registry, conversationId: id,
    setError: (text: string) => { error = text; }, setInput: (change: (value: string) => string) => { input = change(input); },
    createSessionRequest: async () => { throw new Error(rawQuota); }, owns: (token: symbol) => registry.isLive(id, token),
    historyConversation: { activeId: () => id },
  });
  await createCampaign("合成活动原话");
  assert.equal(error, MODEL_QUOTA_MESSAGE); assert.equal(input, "合成活动原话"); assert.equal(registry.has(id), false);
});
