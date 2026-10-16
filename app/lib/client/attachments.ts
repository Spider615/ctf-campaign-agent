import { VISUALIZATION_SCHEMA } from "../analytics/visualization-types.ts";
import { ATTACHMENT_LIMITS, validAttachmentId, type AttachmentReference, type AttachmentSummary, type ConversationRequest } from "../attachments/types.ts";
import { isConversationAnswer, validateConversationAnswer } from "../attachments/answer.ts";
import { consumeAnalyticsStream, type AnalyticsProgressEvent } from "../analytics/stream.ts";
import { analyticsRequest } from "./analytics.ts";

export function validateAttachmentSelection(existing: ReadonlyArray<{ size: number }>, files: File[]): File[] {
  if (existing.length + files.length > ATTACHMENT_LIMITS.messageFiles) throw new Error("每次最多上传 10 个文件");
  if (files.some((file) => file.size > ATTACHMENT_LIMITS.fileBytes)) throw new Error("单个文件不能超过 25 MiB");
  if (files.some((file) => !file.size)) throw new Error("不能上传空文件");
  if ([...existing, ...files].reduce((total, file) => total + file.size, 0) > ATTACHMENT_LIMITS.messageBytes) throw new Error("每次上传总大小不能超过 100 MiB");
  return files;
}

export function attachmentSubmission(text: string, attachments: AttachmentReference[]) {
  if (attachments.some((file) => ["queued", "processing"].includes(file.status))) throw new Error("请等待文件上传和解析完成");
  if (attachments.some((file) => !["ready", "partial"].includes(file.status) || file.deleted || file.unavailable)) throw new Error("请先重试或移除读取失败或已失效的文件");
  const question = text.trim().slice(0, 500) || (attachments.length ? "请概括这些文件，并说明值得关注的内容" : "");
  if (!question) throw new Error("请输入问题或上传文件");
  return { question, attachments };
}
export function attachmentReferences(messages: ReadonlyArray<{ attachments?: AttachmentReference[] }>): AttachmentReference[] {
  const items = new Map<string, AttachmentReference>();
  for (const message of messages) for (const item of message.attachments ?? []) if (validAttachmentId(item.id)) items.set(item.id, item);
  return [...items.values()].filter((item) => !item.deleted && !item.unavailable);
}
export const attachmentUrl = (conversationId: string, id?: string, action?: string) => `/api/analytics/attachments${id ? "/" + encodeURIComponent(id) : ""}${action ? "/" + action : ""}?conversationId=${encodeURIComponent(conversationId)}`;
let initializing: Promise<unknown> | undefined;
export async function ensureAttachmentAccess(signal?: AbortSignal) {
  // 首次多文件上传共用一次身份初始化，避免并行响应生成不同 cookie。
  if (!initializing) initializing = analyticsRequest("/api/analytics/access").finally(() => { initializing = undefined; });
  await initializing; if (signal?.aborted) throw new DOMException("已取消上传", "AbortError");
}
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "附件请求暂时无法完成"); return body;
}
export async function uploadAttachment(conversationId: string, file: File, signal: AbortSignal) {
  await ensureAttachmentAccess(signal);
  const response = await fetch(`${attachmentUrl(conversationId)}&name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: file, signal });
  return (await responseJson<{ attachment: AttachmentSummary }>(response)).attachment;
}
export async function getAttachment(conversationId: string, id: string, signal?: AbortSignal) {
  return (await responseJson<{ attachment: AttachmentSummary }>(await fetch(attachmentUrl(conversationId, id), { credentials: "same-origin", signal }))).attachment;
}
export async function listAttachments(conversationId: string, signal?: AbortSignal) {
  return (await responseJson<{ attachments: AttachmentSummary[] }>(await fetch(attachmentUrl(conversationId), { credentials: "same-origin", signal }))).attachments;
}
export class UnavailableAttachmentsError extends Error {
  ids: string[];
  constructor(ids: string[]) { super("部分附件已删除或过期，已从后续文件问答移除。请重新上传后再提问；之前回答和引用仍可查看。"); this.ids = ids; }
}
export async function deleteAttachment(conversationId: string, id: string) {
  await responseJson(await fetch(attachmentUrl(conversationId, id), { method: "DELETE", credentials: "same-origin" }));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ctf:attachment-removed", { detail: { conversationId, id } }));
}
export async function retryAttachment(conversationId: string, id: string, signal?: AbortSignal) {
  return (await responseJson<{ attachment: AttachmentSummary }>(await fetch(attachmentUrl(conversationId, id, "retry"), { method: "POST", credentials: "same-origin", signal }))).attachment;
}
export async function postAttachmentStream(request: ConversationRequest, onProgress: (event: AnalyticsProgressEvent) => void, signal?: AbortSignal) {
  await ensureAttachmentAccess(signal);
  const available = new Set((await listAttachments(request.conversationId, signal)).map((item) => item.id));
  const missing = request.attachmentIds.filter((id) => !available.has(id));
  if (missing.length) throw new UnavailableAttachmentsError(missing);
  const response = await fetch("/api/analytics/conversation", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/x-ndjson", "X-Conversation-Answer-Schema": "conversation-answer/v1", "X-Analytics-Visuals": VISUALIZATION_SCHEMA }, body: JSON.stringify(request), signal });
  if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error || "文件问答暂时无法完成，可以重试"); }
  const answer = await consumeAnalyticsStream(response, onProgress, signal);
  if (!isConversationAnswer(answer)) throw new Error("文件问答返回了不支持的合同"); return validateConversationAnswer(answer);
}
