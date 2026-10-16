import assert from "node:assert/strict";
import test from "node:test";
import { validateAttachmentSelection, attachmentSubmission, attachmentReferences } from "../app/lib/client/attachments.ts";
import { createHistoryConversationStore, historyMessageContext } from "../app/lib/client/history-conversation.ts";
import type { AttachmentReference } from "../app/lib/attachments/types.ts";

const file = { id: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222", name: "方案.pptx", size: 100, version: "a".repeat(64), status: "ready", imageCount: 0 } satisfies AttachmentReference;

test("仅文件可以发送默认任务，未完成或失败附件不能悄悄跳过", () => {
  assert.equal(attachmentSubmission("", [file]).question, "请概括这些文件，并说明值得关注的内容");
  assert.throws(() => attachmentSubmission("分析", [{ ...file, status: "processing" }]), /解析/);
  assert.throws(() => attachmentSubmission("分析", [{ ...file, status: "failed" }]), /移除|失败/);
  assert.throws(() => attachmentSubmission("", []), /输入|文件/);
});

test("文件选择不限制后缀，数量和大小在读取字节前检查", () => {
  assert.equal(validateAttachmentSelection([], [new File(["内容"], "data.custom")]).length, 1);
  assert.throws(() => validateAttachmentSelection(Array.from({ length: 10 }, () => ({ size: 1 })), [new File(["内容"], "data.txt")]), /10/);
  assert.throws(() => validateAttachmentSelection([], [{ name: "big.bin", size: 25 * 1024 * 1024 + 1 } as File]), /25/);
});

test("同名但不同文件不能合并，重复 ID 只向后续问题发送一次", () => {
  const other = { ...file, id: crypto.randomUUID() };
  assert.deepEqual(attachmentReferences([{ attachments: [file, other] }, { attachments: [file] }]).map((item) => item.id), [file.id, other.id]);
});

test("已失效附件不会继续混入后续问题，保留旧引用供用户查看", () => {
  const other = { ...file, id: crypto.randomUUID() };
  const messages = [{ attachments: [file, other] }, { attachments: [{ ...file, unavailable: true }] }];
  assert.deepEqual(attachmentReferences(messages).map((item) => item.id), [other.id]);
  assert.throws(() => attachmentSubmission("继续", [{ ...file, unavailable: true }]), /失效|移除|失败/);
});

test("上传元信息随浏览器对话恢复，换会话没有上一会话文件引用", () => {
  const saved = new Map<string, string>(); const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const store = createHistoryConversationStore(storage); const firstId = store.activeId();
  store.update(() => [{ id: "user", role: "user", text: "概括方案", createdAt: new Date().toISOString(), attachments: [file] }]);
  const secondId = store.newConversation(); assert.notEqual(firstId, secondId); assert.equal(attachmentReferences(store.snapshot()).length, 0);
  store.selectConversation(firstId);
  const restored = createHistoryConversationStore(storage); assert.equal(attachmentReferences(restored.snapshot())[0].name, "方案.pptx");
  assert.doesNotMatch(historyMessageContext(restored.snapshot()[0]), /base64|file:\/\//);
});

test("文件后续上下文只保留已核验正文，复制用图表数据表不会成为新来源", () => {
  const context = historyMessageContext({ id: "answer", role: "assistant", createdAt: new Date().toISOString(), text: "正文。\n\n图表数据\n模拟甲店\t9876.54", answer: { schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "先核对资料中的业务范围。", sourceIds: ["s1"] }], limitations: [], sources: [] } });
  assert.match(context, /先核对资料中的业务范围/);
  assert.doesNotMatch(context, /图表数据|9876\.54/);
});
