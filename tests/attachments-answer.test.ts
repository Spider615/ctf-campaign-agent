import assert from "node:assert/strict";
import test from "node:test";
import { validateConversationAnswer, validateConversationDraft, conversationAnswerText, validateConversationRequest, unsupportedLimitationNumbers } from "../app/lib/attachments/answer.ts";

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

test("数字退回指出具体段落和不支持的数值，便于定向修订", () => {
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [...draft.blocks, { text: "预算为500元。", sourceIds: ["s1"] }] }, [source]), (error: Error) => { assert.match(error.message, /第2段/); assert.match(error.message, /500/); assert.match(error.message, /s1/); return true; });
});

test("Markdown列表与标题序号不算业务数字，实际金额仍逐段核验", () => {
  const formatted = { ...draft, blocks: [{ text: "## 1. 预算\n1. 方案预算300元。", sourceIds: ["s1"] }] };
  assert.equal(validateConversationDraft(formatted, [source]).blocks[0].text, formatted.blocks[0].text);
  assert.throws(() => validateConversationDraft({ ...formatted, blocks: [{ text: "## 1. 预算\n1. 方案预算500元。", sourceIds: ["s1"] }] }, [source]), /数字/);
  assert.throws(() => validateConversationDraft({ ...formatted, blocks: [{ text: "## 2025年预算\n预算300元。", sourceIds: ["s1"] }] }, [source]), /2025/);
  assert.throws(() => validateConversationDraft({ ...formatted, blocks: [{ text: "## 2026. 年度经营复盘\n预算300元。", sourceIds: ["s1"] }] }, [source]), /2026/);
});

test("同一个来源数字可以按万、亿、百分数或两位小数展示，但不能改数或丢负号", () => {
  const amount = { ...source, excerpt: "销售额：208946589.88；ROI：0.217675；退款：-9545462.26；日期：2025-03-01" };
  const ok = (text: string) => validateConversationDraft({ ...draft, blocks: [{ text, sourceIds: ["s1"] }] }, [amount]);
  for (const text of ["销售额2.09亿元", "销售额20894.66万元", "销售额约20895万", "ROI为21.77%", "ROI约0.22", "退款-954.55万元", "活动从2025年3月1日开始"]) assert.equal(ok(text).blocks[0].text, text);
  for (const text of ["销售额3.09亿元", "退款954.55万元", "ROI为2177%", "ROI约0"]) assert.throws(() => ok(text), /数字/, text);
});

test("方向词后的变化量可按绝对值引用，其他位置的数字仍不能翻转正负号", () => {
  const delta = { ...source, excerpt: "变化率：-0.076923；门槛：300" };
  const ok = (text: string) => validateConversationDraft({ ...draft, blocks: [{ text, sourceIds: ["s1"] }] }, [delta]);
  assert.equal(ok("七夕比春节下降7.69%，门槛至少300元").blocks.length, 1);
  assert.throws(() => ok("七夕比春节增长7.69%"), /7\.69%/);
  assert.throws(() => ok("门槛降低了400元"), /400/);
});

test("个百分点按差值的绝对值核对，写错舍入时退回信息给出可用写法", () => {
  const rate = { ...source, excerpt: "毛利率：0.339977；差值：-0.049153" };
  const check = (text: string) => validateConversationDraft({ ...draft, blocks: [{ text, sourceIds: ["s1"] }] }, [rate]);
  assert.equal(check("毛利率34%，比常态低4.92个百分点").blocks.length, 1);
  assert.throws(() => check("毛利率33.99%"), (error: Error) => { assert.match(error.message, /33\.99% 可写成 .*34%/); return true; });
  assert.throws(() => check("比常态低5.92个百分点"), /5\.92%/);
});

test("数量级写错时退回信息点明来源原值", () => {
  const cost = { ...source, excerpt: "营销费用：1737614.11" };
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [{ text: "营销费用1737万", sourceIds: ["s1"] }] }, [cost]), (error: Error) => { assert.match(error.message, /数量级不对，来源是 1737614\.11/); assert.match(error.message, /173\.76万/); return true; });
});

test("限制说明里的数字也要能在已读来源中找到", () => {
  const rate = { ...source, excerpt: "净毛利率均值：0.2535" };
  assert.deepEqual(unsupportedLimitationNumbers(["净毛利率均值约25.35%，口径为逐行比率"], [rate]), []);
  assert.deepEqual(unsupportedLimitationNumbers(["净毛利率均值约912.4%，疑似录入错误"], [rate]), ["912.4%"]);
});

test("引用错误时退回信息写明是哪一段、哪个编号", () => {
  assert.throws(() => validateConversationDraft({ ...draft, blocks: [{ text: "预算300元。", sourceIds: ["s1", "s7", "s1"] }] }, [source]), (error: Error) => { assert.match(error.message, /第1段引用了本轮没有返回的 s7重复引用 s1/); return true; });
});
