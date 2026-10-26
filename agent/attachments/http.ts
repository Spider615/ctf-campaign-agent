import { visualizationCapability } from "../../app/lib/analytics/visualization.ts";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ATTACHMENT_LIMITS, attachmentTableRows, validAttachmentId, type ConversationAnswer, type ConversationRequest } from "../../app/lib/attachments/types.ts";
import { validateConversationAnswer, validateConversationRequest } from "../../app/lib/attachments/answer.ts";
import { encodeAnalyticsStreamEvent, type AnalyticsProgressEvent, type AnalyticsStreamEvent } from "../../app/lib/analytics/stream.ts";
import type { AttachmentScope, AttachmentStore } from "./store.ts";
import { publicAgentError } from "../../app/lib/agent/service-errors.ts";
import { analyticsAnswerText } from "../../app/lib/analytics/stream.ts";
import { recordTurn, usageIdentity } from "../usage/turns.ts";
import type { UsageChannel, UsageStore } from "../usage/store.ts";
import type { AdminAuth } from "../usage/admin.ts";

export type ConversationRunner = (scope: AttachmentScope, request: ConversationRequest, signal?: AbortSignal, emit?: (event: AnalyticsProgressEvent) => void, visualizationSchema?: string) => Promise<ConversationAnswer>;
const json = (response: ServerResponse, status: number, body: unknown) => { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); };
async function readJson(request: IncomingMessage) {
  if (!request.headers["content-type"]?.includes("application/json")) throw new Error("文件对话请求应使用 JSON");
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) { size += (chunk as Buffer).length; if (size > 1024 * 1024) throw new Error("文件问题请求过大"); parts.push(chunk as Buffer); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("文件对话请求不是有效 JSON"); }
}

type AttachmentsHttpOptions = { store: AttachmentStore; runConversation?: ConversationRunner; usage?: UsageStore; channel?: UsageChannel; admin?: AdminAuth };

export function createAttachmentsHttpHandler({ store, runConversation, usage, channel = "deepseek", admin }: AttachmentsHttpOptions) {
  const isInternal = admin ? (value: string | undefined) => admin.verify(value) : undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const owner = request.headers["x-attachments-owner"]; const conversationId = url.searchParams.get("conversationId");
    if (!validAttachmentId(owner)) return json(response, 401, { error: "附件访问身份无效" });
    if (!validAttachmentId(conversationId)) return json(response, 400, { error: "附件会话标识无效" });
    const scope = { owner, conversationId }; const parts = url.pathname.split("/").slice(2).filter(Boolean);
    const controller = new AbortController(); let streaming = false; let heartbeat: ReturnType<typeof setInterval> | undefined;
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    request.on("aborted", abort); response.on("close", abort); if (request.aborted || response.destroyed) controller.abort();
    try {
      if (parts[0] === "answer" && request.method === "POST") {
        const body = validateConversationRequest(await readJson(request));
        if (body.conversationId !== conversationId) throw new Error("文件问题的会话标识不一致");
        if (!runConversation) return json(response, 503, { error: "文件问答服务尚未启动" });
        for (const attachmentId of body.attachmentIds) await store.get(scope, attachmentId);
        // 附件问答里嵌套的历史分析调用同在这一轮，不另算客户问题。
        const visuals = visualizationCapability(typeof request.headers["x-analytics-visuals"] === "string" ? request.headers["x-analytics-visuals"] : undefined);
        const answer = (emit?: (event: AnalyticsProgressEvent) => void) => recordTurn(usage, { ...usageIdentity(request, isInternal), conversationId, entry: "attachments", channel, question: body.question },
          (emitTrace) => runConversation(scope, body, controller.signal, emit && ((event) => { if (event.type === "trace") emitTrace(event.event); emit(event); }), visuals),
          (result) => ({ status: result.status === "partial" ? "partial" : "answered", reply: analyticsAnswerText(result) }), controller.signal, publicAgentError);
        if (parts[1] === "stream") {
          streaming = true; response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" }); response.flushHeaders();
          heartbeat = setInterval(() => { if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) response.write("\n"); }, 5000);
          const emit = (event: AnalyticsStreamEvent) => { if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) response.write(encodeAnalyticsStreamEvent(event)); };
          const result = validateConversationAnswer(await answer(emit));
          emit({ type: "result", result }); if (!controller.signal.aborted) response.end(); return;
        }
        return json(response, 200, { answer: validateConversationAnswer(await answer()) });
      }
      if (parts.length === 0) {
        if (request.method === "POST") {
          const declared = Number(request.headers["content-length"] ?? 0);
          if (declared > ATTACHMENT_LIMITS.fileBytes) return json(response, 413, { error: "单个文件不能超过 25 MiB" });
          const attachment = await store.upload(scope, { name: url.searchParams.get("name") ?? "", body: request.iterator({ destroyOnReturn: false }), signal: controller.signal });
          return json(response, 202, { attachment });
        }
        if (request.method === "GET") {
          const ids = url.searchParams.get("ids")?.split(",");
          if (ids && (ids.length > 100 || ids.some((id) => !validAttachmentId(id)))) throw new Error("附件标识不正确");
          const attachments = ids ? await Promise.all(ids.map((id) => store.get(scope, id))) : await store.list(scope);
          return json(response, 200, { attachments });
        }
      }
      const attachmentId = parts[0]; if (!validAttachmentId(attachmentId)) throw new Error("附件标识不正确");
      if (parts.length === 1 && request.method === "GET") return json(response, 200, { attachment: await store.get(scope, attachmentId) });
      if (parts.length === 1 && request.method === "DELETE") { await store.remove(scope, attachmentId); return json(response, 200, { deleted: true }); }
      if (parts[1] === "retry" && request.method === "POST") return json(response, 202, { attachment: await store.retry(scope, attachmentId) });
      if (parts[1] === "preview" && request.method === "GET") {
        const { summary, document } = await store.document(scope, attachmentId); const blockId = url.searchParams.get("blockId");
        const blocks = blockId ? document.blocks.filter((block) => block.id === blockId) : document.blocks.slice(0, 30);
        return json(response, 200, { attachment: summary, blocks, tables: document.tables.map((table) => ({ id: table.id, name: table.name, columns: table.columns, rows: attachmentTableRows(table), location: table.location })), images: document.images });
      }
      if (request.method === "GET" && (parts[1] === "content" || parts[1] === "image")) {
        const image = parts[1] === "image" ? await store.image(scope, attachmentId, parts[2] ?? "") : null;
        const asset = image ?? await store.content(scope, attachmentId);
        const info = await stat(asset.path);
        response.writeHead(200, { "content-type": image ? image.image.mime : "application/octet-stream", "content-length": info.size, "content-disposition": image ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(asset.summary.name).replace(/'/g, "%27")}`, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
        const stream = createReadStream(asset.path); const stop = () => stream.destroy(); controller.signal.addEventListener("abort", stop, { once: true });
        await new Promise<void>((resolve, reject) => { stream.on("error", reject); response.on("finish", resolve); response.on("close", resolve); stream.pipe(response); });
        controller.signal.removeEventListener("abort", stop); return;
      }
      json(response, 404, { error: "没有这个附件接口" });
    } catch (error) {
      if (controller.signal.aborted) return;
      const detail = error instanceof Error ? error.message : "附件暂时无法读取";
      const message = /ENOENT|EACCES|ENOSPC|[\\/]metadata\.json/.test(detail) ? "附件暂时无法读取，请稍后重试" : detail.slice(0, 1000);
      if (streaming) { response.write(JSON.stringify({ type: "error", error: message }) + "\n"); response.end(); }
      else json(response, /超过|过大|限额/.test(message) ? 413 : /不存在|无权|已删除|已过期/.test(message) ? 404 : 400, { error: message });
      if (!request.complete) request.resume();
    } finally { clearInterval(heartbeat); request.off("aborted", abort); response.off("close", abort); }
  };
}
