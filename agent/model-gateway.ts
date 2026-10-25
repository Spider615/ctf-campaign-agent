// 本机回环上的模型转换层：Agent SDK 发来 Anthropic 的 POST /v1/messages，这里转成公司模型网关的
// OpenAI 兼容 /chat/completions，再把结果（含流式）转回 Anthropic 格式。网关 key 由 SDK 的 x-api-key 带过来，这里不存。
// 网关选模型规则：/models/status 按 poll_interval_seconds 缓存；上游 404 model_not_found 或 503 时，
// 立即重新拉状态，换一个同厂商、可用、未下线的对话模型重试一次。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { modelQuotaMessage } from "../app/lib/agent/service-errors.ts";

import { anthropicErrorType, createStreamTranslator, sdkModelName, toAnthropicMessage, toOpenAIRequest } from "./openai-bridge.ts";

type ModelStatus = { id: string; aliases?: string[]; kind?: string; owned_by?: string; status?: string; recommendation?: string };
type Options = { baseUrl: string; maxOutputTokens?: number; fetch?: typeof fetch; log?: (line: string) => void };

const RANK: Record<string, number> = { recommended: 0, normal: 1, discouraged: 2 };

export function createModelGateway({ baseUrl, maxOutputTokens = 8192, fetch: request = fetch, log = (line) => console.error(line) }: Options) {
  const base = baseUrl.replace(/\/$/, "");
  let status: { models: ModelStatus[]; expires: number } | undefined;

  async function loadStatus(apiKey: string, force: boolean): Promise<ModelStatus[]> {
    if (!force && status && Date.now() < status.expires) return status.models;
    try {
      const response = await request(`${base}/models/status`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return status?.models ?? [];
      const body = await response.json() as { data?: ModelStatus[]; poll_interval_seconds?: number };
      status = { models: body.data ?? [], expires: Date.now() + (body.poll_interval_seconds ?? 60) * 1000 };
      return status.models;
    } catch { return status?.models ?? []; }
  }

  const sameModel = (entry: ModelStatus, model: string) => entry.id === model || Boolean(entry.aliases?.includes(model));

  // 同厂商的对话模型里挑一个能用的：recommended 优先，其次 normal，discouraged 兜底，deprecating 和 unavailable 不选。
  async function fallbackFor(model: string, apiKey: string): Promise<string | undefined> {
    const models = await loadStatus(apiKey, true);
    const current = models.find((entry) => sameModel(entry, model));
    const owner = current?.owned_by ?? (model.startsWith("claude") ? "anthropic" : undefined);
    return models
      .filter((entry) => !sameModel(entry, model) && entry.kind === "chat" && entry.owned_by === owner && entry.status !== "unavailable" && entry.recommendation !== "deprecating")
      .sort((a, b) => (RANK[a.recommendation ?? ""] ?? 3) - (RANK[b.recommendation ?? ""] ?? 3))[0]?.id;
  }

  const call = (body: Record<string, unknown>, apiKey: string, signal: AbortSignal) => request(`${base}/chat/completions`, {
    method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body),
  });

  async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(incoming.url ?? "/", "http://local").pathname;
    const fail = (code: number, message: string) => {
      if (response.headersSent) { response.end(); return; }
      response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: anthropicErrorType(code), message } }));
    };
    if (incoming.method !== "POST" || path !== "/v1/messages") return fail(404, "转换层只支持 POST /v1/messages");
    const apiKey = String(incoming.headers["x-api-key"] ?? "").trim() || String(incoming.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) return fail(401, "缺少模型网关 key");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(400, "请求体不是 JSON"); }

    const model = String(body.model ?? "");
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    let upstream = await call(toOpenAIRequest(body, model, maxOutputTokens), apiKey, controller.signal);
    if (upstream.status === 404 || upstream.status === 503) {
      const detail = await upstream.text();
      const next = await fallbackFor(model, apiKey);
      if (!next) return fail(upstream.status, detail.slice(0, 500));
      log(`模型网关：${model} 返回 ${upstream.status}，改用 ${next} 重试一次`);
      upstream = await call(toOpenAIRequest(body, next, maxOutputTokens), apiKey, controller.signal);
    }
    if (!upstream.ok) {
      const detail = await upstream.text();
      const headers: Record<string, string> = { "content-type": "application/json" };
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) headers["retry-after"] = retryAfter;
      // 保留上游429，但明确额度耗尽属于不可重试错误，避免SDK把它当短暂限流等待数分钟。
      if (modelQuotaMessage(detail)) headers["x-should-retry"] = "false";
      response.writeHead(upstream.status, headers).end(JSON.stringify({ type: "error", error: { type: anthropicErrorType(upstream.status), message: detail.slice(0, 500) } }));
      return;
    }
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(toAnthropicMessage(await upstream.json() as Record<string, unknown>, model)));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const translator = createStreamTranslator(model);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const piece of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { response.write(translator.push(JSON.parse(data))); } catch { /* 单个坏块跳过，不中断整轮 */ }
      }
    }
    response.end(translator.finish());
  }

  const server = createServer((incoming, response) => {
    handle(incoming, response).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      log(`模型网关转换失败：${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "模型网关暂时不可用" } }));
      else response.end();
    });
  });

  return {
    // 只听回环地址、端口随机；返回给 SDK 用的 ANTHROPIC_BASE_URL。unref：转换层不单独撑住进程，脚本跑完能正常退出。
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const DEFAULT_MODEL_GATEWAY_URL = "https://unified-kiro-gateway.juzibot.com/models/v1";
export const DEFAULT_AGENT_MODEL = "claude-5.5-sonnet";

// 按环境变量起转换层，返回各个 runner 要的模型配置。key 从 JUZI_MODELS_KEY 读，不写进代码。
export async function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const gateway = createModelGateway({ baseUrl: env.MODEL_GATEWAY_URL || DEFAULT_MODEL_GATEWAY_URL, maxOutputTokens: Number(env.MODEL_MAX_OUTPUT_TOKENS) || 8192 });
  return { model: sdkModelName(env.AGENT_MODEL || DEFAULT_AGENT_MODEL), modelBaseUrl: await gateway.listen(), apiKey: env.JUZI_MODELS_KEY?.trim() ?? "", close: gateway.close };
}
