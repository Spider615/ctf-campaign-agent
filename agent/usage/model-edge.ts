// DeepSeek 渠道的本机出口：只透传，不改请求体和响应体；顺路读响应里的编号、模型和 usage 记到用量库。
// 句子互动渠道已有本机转换层（model-gateway.ts），在那里记录，不经过这里。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { parseTurnPath, startModelRequest } from "./context.ts";

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type Options = { upstream: string; fetch?: typeof fetch };

const DROP_REQUEST = new Set(["host", "content-length", "connection", "accept-encoding"]);
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

// 官方映射合同：claude-opus* 对应 deepseek-v4-pro，其余 claude-* 对应 deepseek-flash。https://api-docs.deepseek.com/guides/anthropic_api/
export function deepseekModelFor(model: string): string {
  if (model.startsWith("claude-opus")) return "deepseek-v4-pro";
  if (model.startsWith("claude-")) return "deepseek-flash";
  return model;
}

export function createModelEdge({ upstream, fetch: request = fetch }: Options) {
  const base = upstream.replace(/\/+$/, "");

  async function handle(incoming: IncomingMessage, response: ServerResponse) {
    const url = new URL(incoming.url ?? "/", "http://local");
    const { turnId, source, rest } = parseTurnPath(url.pathname);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (!DROP_REQUEST.has(name) && typeof value === "string") headers.set(name, value);

    let sdkModel = "";
    try { sdkModel = String((JSON.parse(body.toString("utf8")) as { model?: unknown }).model ?? ""); } catch { /* 不是 JSON 时照常转发 */ }
    const finish = turnId && source && incoming.method === "POST" && rest === "/v1/messages"
      ? startModelRequest({ turnId, source, channel: "deepseek", sdkModel, sentModel: deepseekModelFor(sdkModel), vendor: "DeepSeek", vendorBasis: "官方兼容接口" })
      : undefined;
    const known = { responseId: null as string | null, upstreamModel: null as string | null, inputTokens: null as number | null, outputTokens: null as number | null, cacheReadTokens: null as number | null, cacheWriteTokens: null as number | null };
    const takeStart = (message: { id?: unknown; model?: unknown; usage?: Usage } | undefined) => {
      if (!message) return;
      if (typeof message.id === "string") known.responseId = message.id;
      if (typeof message.model === "string") known.upstreamModel = message.model;
      known.inputTokens = count(message.usage?.input_tokens) ?? known.inputTokens;
      known.cacheReadTokens = count(message.usage?.cache_read_input_tokens) ?? known.cacheReadTokens;
      known.cacheWriteTokens = count(message.usage?.cache_creation_input_tokens) ?? known.cacheWriteTokens;
    };

    const controller = new AbortController();
    let httpStatus: number | null = null;
    response.on("close", () => {
      if (response.writableFinished) return;
      controller.abort();
      finish?.({ status: "incomplete", httpStatus, ...known });
    });
    const upstreamResponse = await request(`${base}${rest}${url.search}`, { method: incoming.method, headers, body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : body, signal: controller.signal });
    httpStatus = upstreamResponse.status;
    const outgoing: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name)) outgoing[name] = value; });
    response.writeHead(upstreamResponse.status, outgoing);

    if (!upstreamResponse.ok || !(upstreamResponse.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await upstreamResponse.text();
      response.end(text);
      if (!upstreamResponse.ok) { finish?.({ status: "error", httpStatus, ...known }); return; }
      try {
        const message = JSON.parse(text) as { id?: unknown; model?: unknown; usage?: Usage };
        takeStart(message); known.outputTokens = count(message.usage?.output_tokens);
      } catch { /* 非 JSON 响应只记状态 */ }
      finish?.({ status: "done", httpStatus, ...known });
      return;
    }

    // 流式：message_start 带输入用量，message_delta 带最终输出用量；没等到 message_delta 就结束算不完整。
    const decoder = new TextDecoder(); let buffer = ""; let delta = false;
    const read = (line: string) => {
      if (!line.startsWith("data:")) return;
      try {
        const event = JSON.parse(line.slice(5).trim()) as { type?: string; message?: { id?: unknown; model?: unknown; usage?: Usage }; usage?: Usage };
        if (event.type === "message_start") takeStart(event.message);
        if (event.type === "message_delta") {
          delta = true;
          known.outputTokens = count(event.usage?.output_tokens) ?? known.outputTokens;
          known.inputTokens = count(event.usage?.input_tokens) ?? known.inputTokens;
        }
      } catch { /* 坏行只影响记录，不影响转发 */ }
    };
    for await (const piece of upstreamResponse.body as unknown as AsyncIterable<Uint8Array>) {
      response.write(piece);
      buffer += decoder.decode(piece, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) { read(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1); }
    }
    read(buffer.trim());
    response.end();
    finish?.({ status: delta ? "done" : "incomplete", httpStatus, ...known });
  }

  const server = createServer((incoming, response) => {
    handle(incoming, response).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      console.error(`模型出口转发失败：${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "模型服务暂时不可用" } }));
      else response.end();
    });
  });

  return {
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
