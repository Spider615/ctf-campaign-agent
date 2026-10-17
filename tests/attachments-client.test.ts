import assert from "node:assert/strict";
import test from "node:test";
import { validateAttachmentSelection, attachmentSubmission, attachmentReferences, retryConversationAttachments, getAttachment } from "../app/lib/client/attachments.ts";
import { createHistoryConversationStore, historyMessageContext, replaceHistoryAttachment, type HistoryMessage } from "../app/lib/client/history-conversation.ts";
import type { AttachmentReference } from "../app/lib/attachments/types.ts";

const file = { id: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222", name: "方案.pptx", size: 100, version: "a".repeat(64), status: "ready", imageCount: 0 } satisfies AttachmentReference;

test("文件上传完成即可发送，处理发生在消息发送后，失败附件不能悄悄跳过", () => {
  assert.equal(attachmentSubmission("", [file]).question, "请概括这些文件，并说明值得关注的内容");
  for (const status of ["uploaded", "queued", "processing", "ready", "partial"] as const) assert.equal(attachmentSubmission("分析", [{ ...file, status }]).question, "分析");
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

test("回答重试只重置失败文件，新版本替换后续请求而不改既有答案来源", async (t) => {
  const failed = { ...file, id: crypto.randomUUID(), status: "failed" as const };
  const replacement = { ...failed, id: crypto.randomUUID(), status: "uploaded" as const, version: "b".repeat(64) };
  const request = { conversationId: file.conversationId, question: "分析资料", attachmentIds: [file.id, failed.id], history: [] };
  const answer = { schema: "conversation-answer/v1" as const, status: "answered" as const, blocks: [], limitations: [], sources: [{ id: "s1", attachmentId: file.id, version: file.version, name: file.name, location: "正文", kind: "document" as const, excerpt: "依据" }] };
  let messages: HistoryMessage[] = [{ id: "user", role: "user", text: "分析资料", attachments: [file, failed], createdAt: "2026-10-16" }, { id: "assistant", role: "assistant", text: "已有回答", answer, request, attachments: [file, failed], createdAt: "2026-10-16" }];
  const calls: string[] = []; const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    assert.equal(options?.signal, controller.signal); calls.push(url);
    if (url.includes("/retry?")) { assert.equal(options?.method, "POST"); assert.ok(url.includes(failed.id)); return Response.json({ attachment: replacement }); }
    return Response.json({ attachments: [file, failed] });
  });
  const next = await retryConversationAttachments(request, (id, ref) => { messages = replaceHistoryAttachment(messages, id, ref); }, controller.signal);
  assert.equal(calls.length, 2); assert.deepEqual(next.attachmentIds, [file.id, replacement.id]);
  assert.deepEqual(attachmentReferences(messages).map((ref) => ref.id), next.attachmentIds);
  assert.deepEqual((messages[1].request as typeof request).attachmentIds, next.attachmentIds);
  assert.equal(messages[1].answer, answer); assert.equal(answer.sources[0].attachmentId, file.id);
  const duplicateRequest = { ...request, attachmentIds: [...request.attachmentIds, replacement.id] };
  messages[1] = { ...messages[1], request: duplicateRequest, attachments: [file, failed, replacement] };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url.includes("/retry?") ? { attachment: replacement } : { attachments: [file, failed, replacement] }));
  const deduplicated = await retryConversationAttachments(duplicateRequest, (id, ref) => { messages = replaceHistoryAttachment(messages, id, ref); });
  assert.deepEqual(deduplicated.attachmentIds, [file.id, replacement.id]);
  assert.deepEqual((messages[1].request as typeof request).attachmentIds, deduplicated.attachmentIds);
  assert.equal(messages[1].attachments?.length, 2);
});


test("来源核验保留 HTTP 状态，不能靠错误文案把网络异常判成文件失效", async (t) => {
  for (const status of [401, 403, 404, 410, 500, 502]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: "附件请求暂时无法完成" }, { status }));
    await assert.rejects(getAttachment(file.conversationId, file.id), (error: unknown) => {
      assert.equal((error as Error & { status?: number }).status, status);
      return true;
    });
  }
});

test("来源核验遇到网关非 JSON 错误仍保留 HTTP 状态", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Bad Gateway", { status: 502 }));
  await assert.rejects(getAttachment(file.conversationId, file.id), (error: unknown) => {
    assert.equal((error as Error & { status?: number }).status, 502);
    assert.match((error as Error).message, /附件请求/);
    return true;
  });
});

test("来源核验保留网络错误与取消错误，不能误标为已删除", async (t) => {
  for (const error of [new TypeError("Failed to fetch"), new DOMException("已停止", "AbortError")]) {
    t.mock.method(globalThis, "fetch", async () => { throw error; });
    await assert.rejects(getAttachment(file.conversationId, file.id), (caught: unknown) => caught === error);
  }
});
