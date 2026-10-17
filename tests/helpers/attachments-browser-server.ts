// 仅供本地免费交互验收：真实上传、解析、MCP 和 Workers 网关，模型使用确定性替身。
import { createServer, request as httpRequest } from "node:http";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Client } from "../../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { SDKMessage } from "../../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import type { AgentQuery } from "../../agent/run-turn.ts";
import { createAttachmentStore } from "../../agent/attachments/store.ts";
import { attachmentPython } from "../../agent/attachments/parser.ts";
import { createMemoryStore } from "../../app/lib/server/session-store.ts";
import { createSession } from "../../app/lib/server/turns.ts";
import { createConversationRunner } from "../../agent/attachments/run-turn.ts";
import { createAttachmentsHttpHandler } from "../../agent/attachments/http.ts";
import { createAgentHttpHandler } from "../../agent/http-handler.ts";

const directory = await mkdtemp(join(tmpdir(), "ctf-attachments-browser-"));
const store = createAttachmentStore({ directory: join(directory, "files"), python: attachmentPython() });
async function call(client: Client, name: string, args = {}) { const response = await client.callTool({ name, arguments: args }); const value = JSON.parse((response.content as Array<{ text: string }>)[0].text); if (response.isError) throw new Error(JSON.stringify(value)); return value; }
const query: AgentQuery = async function* ({ options }) {
  const reviewing = Boolean(options!.mcpServers!.attachment_review); const name = reviewing ? "attachment_review" : "attachments"; const server = options!.mcpServers![name]; if (!("instance" in server)) throw new Error("缺少合成验收 MCP");
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "免费界面验收", version: "1" }); await server.instance.connect(b); await client.connect(a);
  try {
    if (reviewing) {
      const checks = [];
      for (let blockIndex = 0; blockIndex < 40; blockIndex++) {
        const response = await client.callTool({ name: "read_attachment_review", arguments: { blockIndex } }); if (response.isError) break;
        const value = JSON.parse((response.content as Array<{ text: string }>)[0].text);
        checks.push({ blockIndex, sourceIds: value.block.sourceIds, verdict: "supported", reason: "合成验收：已核对真实读取来源和受控计算，未调用模型" });
      }
      await call(client, "submit_attachment_review", { verdict: "accept", checks });
    } else {
      const listing = await call(client, "list_attachments"); const blocks = [];
      for (const file of listing) {
        let page = await call(client, "read_attachment", { attachmentId: file.id, limit: 40 });
        const content = page.blocks.filter((block: { sourceId?: string }) => block.sourceId);
        while (page.paging.nextOffset !== null) { page = await call(client, "read_attachment", { attachmentId: file.id, offset: page.paging.nextOffset, limit: 40 }); content.push(...page.blocks.filter((block: { sourceId?: string }) => block.sourceId)); }
        const amountColumn = (columns: string[]) => columns.find((column) => column === "实收" || column === "净销售额_含税元");
        const table = file.tables.find((table: { columns: string[] }) => amountColumn(table.columns));
        if (table) { const sum = await call(client, "calculate_attachment", { attachmentId: file.id, tableId: table.id, column: amountColumn(table.columns), operation: "sum" }); blocks.push({ text: `所选金额列的非空值合计为${sum.value}，缺失记录为${sum.missingRows}。`, sourceIds: [sum.sourceId] }); }
        else if (content.length) blocks.push({ text: `文件中记载：${content[0].text.slice(0, 500)}`, sourceIds: [content[0].sourceId] });
        else if (file.images.length) { const source = await call(client, "inspect_attachment_image", { attachmentId: file.id, imageId: file.images[0].id, question: "描述测试图片" }); blocks.push({ text: source.excerpt, sourceIds: [source.id] }); }
      }
      await call(client, "submit_attachment_answer", { status: "answered", blocks, limitations: ["本次是确定性假模型交互验收，验证上传、读取、引用和恢复链路。"] });
    }
    yield { type: "result", subtype: "success", is_error: false, result: "合成验收完成" } as SDKMessage;
  } finally { await client.close(); }
};
const runner = createConversationRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir: join(directory, "runtime"), pluginDir: "", store }, { query, vision: async ({ data }) => { if (!data) throw new Error("图片没有传入"); return "图片显示 CTF 300 字样。"; } });
const backend = createServer(createAgentHttpHandler({ runAgentTurn: async () => { throw new Error("验收不调用活动模型"); }, token: "attachment-ui-test", model: "test", attachmentHandler: createAttachmentsHttpHandler({ store, runConversation: runner }) }));
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve)); const address = backend.address(); if (!address || typeof address === "string") throw new Error("验收服务启动失败");
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: `data:text/javascript,${encodeURIComponent(`export const env={DB:{},AGENT_SERVICE_URL:'http://127.0.0.1:${address.port}',AGENT_SERVICE_TOKEN:'attachment-ui-test'};`)}`, shortCircuit: true };
  if (specifier.endsWith("db/index.ts")) return { url: "data:text/javascript,export function getDbBinding(){return {}}", shortCircuit: true };
  return next(specifier, context);
} });
const fetchOriginal = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchOriginal(input, init?.body instanceof ReadableStream ? { ...init, duplex: "half" } as RequestInit : init)) as typeof fetch;
const rootRoute = await import("../../app/api/analytics/attachments/route.ts"); const pathRoute = await import("../../app/api/analytics/attachments/[...path]/route.ts"); const answerRoute = await import("../../app/api/analytics/conversation/route.ts"); const accessRoute = await import("../../app/api/analytics/access/route.ts");
const port = Number(process.env.ATTACHMENT_UI_PORT || 8890); const frontendBase = process.env.ATTACHMENT_UI_FRONTEND || "http://[::1]:5173";
const campaign = await createSession({ entryMode: "example" }, { store: createMemoryStore(), today: "2026-10-15", newId: () => crypto.randomUUID(), now: () => new Date().toISOString(), runAgent: async () => { throw new Error("验收示例不能调用活动模型"); } });
const proxy = createServer(async (incoming, outgoing) => {
  const path = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (path === `/api/sessions/${campaign.session.id}`) { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify(campaign)); return; }
  if (path === "/api/sessions" && incoming.method === "POST") { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify(campaign)); return; }
  if (path.startsWith("/api/analytics/attachments") || path === "/api/analytics/conversation" || path === "/api/analytics/access") {
    const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, { method: incoming.method, headers, ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: Readable.toWeb(incoming), duplex: "half" }) } as RequestInit);
    const route = path === "/api/analytics/conversation" ? answerRoute : path === "/api/analytics/access" ? accessRoute : path === "/api/analytics/attachments" ? rootRoute : pathRoute;
    const handler = (route as Record<string, (request: Request) => Promise<Response>>)[incoming.method ?? "GET"];
    const response = await handler(request); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(outgoing); else outgoing.end(); return;
  }
  if (path.startsWith("/api/")) { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify({ sessions: [], reports: [], datasets: [] })); return; }
  const target = new URL(incoming.url ?? "/", frontendBase); const request = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (response) => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
  request.on("error", () => { outgoing.writeHead(502); outgoing.end("请先启动页面开发服务"); }); incoming.pipe(request);
});
await new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve));
console.log(JSON.stringify({ frontend: `http://127.0.0.1:${port}/analysis`, campaign: `http://127.0.0.1:${port}/c/${campaign.session.id}`, directory, modelCalls: 0 }));
let closing = false;
async function close() { if (closing) return; closing = true; proxy.closeAllConnections(); backend.closeAllConnections(); proxy.close(); backend.close(); await store.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
