import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as history from "../app/lib/client/history-conversation.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import { planAnswerText } from "../app/lib/analytics/plan/answer.ts";
import { storedV2Answer } from "./helpers/analysis-v2-answer.ts";
import { simulatedPlanAnswer } from "./helpers/plan-answer.ts";
import { loadReactComponent } from "./helpers/react-component.ts";

// v2 正文组件已删除：这里只保留仍在线上的行为——旧会话恢复降级、续轮上下文和出处面板。
test("刷新恢复 v2 只保留正文，旧 v1 会话依旧显示，挂起消息结束为取消", () => {
  const values = new Map<string, string>(); const persistence = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = history.createHistoryConversationStore(persistence); const id = store.activeId();
  store.update(() => [{ id: "v2", role: "assistant", text: "正文", answer: storedV2Answer() as never, status: "done", createdAt: "2026-10-13T00:00:00Z" }, { id: "pending", role: "assistant", text: "", status: "running", createdAt: "2026-10-13T00:01:00Z" }], id);
  const restored = history.createHistoryConversationStore(persistence);
  assert.equal(restored.snapshot()[0].answer, undefined); assert.equal(restored.snapshot()[0].text, "正文"); assert.equal(restored.snapshot()[1].status, "cancelled");
  values.clear(); const old = { id: "old", role: "assistant", text: "旧寒暄", answer: quickAnalyticsReply("你好"), createdAt: "2026-10-12T00:00:00Z" };
  values.set("ctf:history-conversation:v1", JSON.stringify([old]));
  assert.deepEqual(history.createHistoryConversationStore(persistence).snapshot()[0], old);
});

test("存储中的损坏 v2 同样只保留正文，不再渲染旧结构", () => {
  const answer = storedV2Answer(); answer.blocks[1].nodes.push({ kind: "fact_ref", factId: "invented" });
  const persistence = { getItem: () => JSON.stringify({ activeId: "thread", threads: [{ id: "thread", title: "模拟", updatedAt: "2026-10-13T00:00:00Z", campaignId: null, context: [], messages: [{ id: "bad", role: "assistant", text: "未核验内容", answer, status: "done", createdAt: "2026-10-13T00:00:00Z" }] }] }), setItem() {} };
  const message = history.createHistoryConversationStore(persistence).snapshot()[0];
  assert.equal(message.answer, undefined); assert.equal(message.status, "done"); assert.equal(message.text, "未核验内容");
});

test("下一轮历史使用 v3 渲染正文，不传播快照内部信息", () => {
  const answer = simulatedPlanAnswer();
  const text = history.historyMessageContext({ id: "answer", role: "assistant", text: "", answer, createdAt: "2026-10-13T00:00:00Z" });
  assert.ok(text.includes(planAnswerText(answer))); assert.match(text, /1234\.56/);
  assert.doesNotMatch(text, /synthetic-snapshot|synthetic-version|operation/);
});

test("出处面板先用白话说明来源、范围，口径代号与数据版本收进技术详情", async (t) => {
  const { AnalysisSourceData } = await loadReactComponent(t, "app/components/analytics/plan-answer.tsx");
  const answer = simulatedPlanAnswer();
  const html = renderToStaticMarkup(createElement(AnalysisSourceData, { evidence: answer.evidence, factIds: ["amount"] }));
  for (const label of ["数据来源", "统计范围", "技术详情"]) assert.ok(html.includes(label), label);
  const plain = html.slice(0, html.indexOf("技术详情"));
  assert.doesNotMatch(plain, /synthetic-version|synthetic-snapshot/);
});
