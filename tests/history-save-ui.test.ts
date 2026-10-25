import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadReactComponent } from "./helpers/react-component.ts";

const source = () => readFileSync("app/components/analytics/history-conversation.tsx", "utf8");
// 取真实的纯展示函数交给既有 TSX helper；其余页面依赖含路由和 @/ 别名，不替换这些依赖来伪造整页测试。
async function component(t: { after(fn: () => void): void }) {
  const parsed = ts.createSourceFile("history-conversation.tsx", source(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const view = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "HistorySaveStatus");
  assert.ok(view, "尚未实现保存状态展示组件");
  const folder = mkdtempSync(resolve("node_modules/.cache-history-save-ui-")); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = resolve(folder, "save-status.tsx"); writeFileSync(file, view.getText(parsed));
  return (await loadReactComponent(t, file)).HistorySaveStatus;
}

test("超限与网络错误显示未保存或保存失败、真实原因和重试按钮，不声称已保存", async (t) => {
  const View = await component(t);
  for (const [code, reason, label] of [["too_large", "当前请求超过 2 MiB 保存上限", "未保存"], ["network", "网络连接中断", "保存失败"], ["cancelled", "本次保存已取消", "保存失败"]]) {
    const html = renderToStaticMarkup(createElement(View, { state: { status: "failed", code, reason, retryable: code !== "too_large" }, onRetry() {} }));
    assert.ok(html.includes(label)); assert.ok(html.includes(reason)); assert.match(html, /role="alert"/); assert.match(html, /本页答案仍可复制/);
    assert.match(html, /<button[^>]*type="button"[^>]*>重试保存<\/button>/); assert.doesNotMatch(html, /已保存/);
  }
});

test("等待和保存中不虚报成功，成功后清除失败提示；未接远端时不冒充已保存", async (t) => {
  const View = await component(t);
  const render = (status: string) => renderToStaticMarkup(createElement(View, { state: { status }, onRetry() {} }));
  for (const status of ["pending", "saving"]) { assert.match(render(status), status === "pending" ? /未保存/ : /正在保存/); assert.doesNotMatch(render(status), /已保存|重试保存/); }
  assert.match(render("saved"), /已保存/); assert.doesNotMatch(render("saved"), /保存失败|重试保存/); assert.equal(render("idle"), "");
});

test("当前 conversation 订阅自己的保存状态，重试仍携带原 conversationId，活动衔接页也显示", () => {
  const text = source();
  assert.match(text, /useSyncExternalStore\(historyConversation\.subscribeSaveState,\s*\(\) => historyConversation\.saveState\(conversationId\),\s*historyConversation\.serverSaveState\)/);
  assert.match(text, /historyConversation\.retrySave\(conversationId\)/);
  assert.match(text, /if \(campaignId\)[\s\S]*?saveNotice[\s\S]*?<Conversation/);
  assert.match(text, /\{saveNotice\}[\s\S]*?<Composer/);
});
