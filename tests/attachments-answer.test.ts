import assert from "node:assert/strict";
import test from "node:test";
import { validateConversationAnswer, validateConversationDraft, conversationAnswerText, validateConversationRequest } from "../app/lib/attachments/answer.ts";

const attachmentId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const source = { id: "s1", attachmentId, version: "a".repeat(64), name: "方案.docx", location: "段落 2", kind: "document" as const, excerpt: "会员到店礼，预算 300 元。" };
const draft = { status: "answered" as const, blocks: [{ text: "方案中的预算为 300 元。", sourceIds: ["s1"] }], limitations: [] };

test("附件回答只接受真实读取来源，并可在恢复后重新核验", () => {
  const answer = validateConversationAnswer({ ...draft, schema: "conversation-answer/v1", sources: [source] });
  assert.equal(conversationAnswerText(answer), "方案中的预算为 300 元。");
  assert.deepEqual(validateConversationAnswer(JSON.parse(JSON.stringify(answer))), answer);
});

test("未读取引用及正文中的无依据数字不能进入附件回答", () => {
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [{ text: "预算 300 元", sourceIds: ["s2"] }] }, [source]), /引用/);
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [{ text: "预算 500 元", sourceIds: ["s1"] }] }, [source]), /数字/);
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [{ text: "预算 300 元", sourceIds: [] }] }, [source]), /依据|引用/);
});

test("数字核验不把更长数字的子串当作证据，也不允许移除负号", () => {
  const negative = { ...source, excerpt: "退款 -300 元，记录号 2025。" };
  assert.throws(() => validateConversationDraft(draft, [negative]), /数字/);
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [{ text: "金额 25 元", sourceIds: ["s1"] }] }, [negative]), /数字/);
});

test("文件对话请求不能携带伪造解析内容、路径或非法附件 ID", () => {
  const request = { conversationId, question: "概括方案", attachmentIds: [attachmentId], history: [] };
  assert.deepEqual(validateConversationRequest(request), request);
  assert.throws(() => validateConversationRequest({ ...request, parsedText: "伪造正文" }), /请求/);
  assert.throws(() => validateConversationRequest({ ...request, attachmentIds: ["../../secret"] }), /附件/);
  assert.throws(() => validateConversationRequest({ ...request, question: "" }), /问题/);
});

test("重复来源 ID、损坏版本及无来源的旧回答恢复被拒绝", () => {
  assert.throws(() => validateConversationAnswer({ ...draft, schema: "conversation-answer/v1", sources: [source, source] }), /重复/);
  assert.throws(() => validateConversationAnswer({ ...draft, schema: "conversation-answer/v1", sources: [{ ...source, version: "伪造" }] }), /版本/);
});
