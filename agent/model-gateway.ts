// 本机回环上的模型转换层：Agent SDK 发来 Anthropic 的 POST /v1/messages，这里转成公司模型网关的
// OpenAI 兼容 /chat/completions，再把结果（含流式）转回 Anthropic 格式。网关 key 由 SDK 的 x-api-key 带过来，这里不存。
// 网关选模型规则：/models/status 按 poll_interval_seconds 缓存；上游 404 model_not_found 或 503 时，
// 立即重新拉状态，换一个同厂商、可用、未下线的对话模型重试一次。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { modelQuotaMessage } from "../app/lib/agent/service-errors.ts";

import { anthropicErrorType, createStreamTranslator, sdkModelName, toAnthropicMessage, toOpenAIRequest } from "./openai-bridge.ts";
import { parseTurnPath, startModelRequest } from "./usage/context.ts";
import { createModelEdge } from "./usage/model-edge.ts";
import type { UsageChannel } from "./usage/store.ts";

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
      if (!response.ok) return keepStale();
      const body = await response.json() as { data?: ModelStatus[]; poll_interval_seconds?: number };
      status = { models: body.data ?? [], expires: Date.now() + (body.poll_interval_seconds ?? 60) * 1000 };
      return status.models;
    } catch { return keepStale(); }
  }
  // 读不到状态时沿用旧列表并顺延 60 秒，免得状态接口出问题时每个请求都去重试。
  function keepStale() { status = { models: status?.models ?? [], expires: Date.now() + 60_000 }; return status.models; }
  // 记录用量只用已缓存的状态，过期了在后台刷新，不让模型请求等它。
  let refreshing: Promise<unknown> | undefined;
  function cachedVendor(model: string, apiKey: string): string | null {
    if (!status || Date.now() >= status.expires) refreshing ??= loadStatus(apiKey, false).finally(() => { refreshing = undefined; });
    return status?.models.find((entry) => sameModel(entry, model))?.owned_by ?? null;
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
    // 路径带 /t/<轮次>/<来源> 时按轮次记录用量，其余照旧。
    const { turnId, source, rest: path } = parseTurnPath(new URL(incoming.url ?? "/", "http://local").pathname);
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
    // 每次真实上游请求一条记录；回退重试是独立的一条。厂商取 /models/status 的 owned_by，查不到不猜。
    // 开始时厂商读缓存（不等状态接口）；收尾时缓存已有就补上，免得刚启动的第一条记成未确认。
    const record = (sentModel: string) => {
      if (!turnId || !source) return undefined;
      const finishRow = startModelRequest({ turnId, source, channel: "juzi", sdkModel: model, sentModel, vendor: cachedVendor(sentModel, apiKey), vendorBasis: "网关模型状态 owned_by" });
      return (result: Parameters<typeof finishRow>[0]) => finishRow({ ...result, vendor: cachedVendor(sentModel, apiKey) ?? undefined });
    };
    const usage = { responseId: null as string | null, upstreamModel: null as string | null, inputTokens: null as number | null, outputTokens: null as number | null, cacheReadTokens: null as number | null, cacheWriteTokens: null as number | null };
    // 网关不返回缓存写入，记 null；缓存命中只有上游给了才记。
    const takeUsage = (chunk: { id?: unknown; model?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }) => {
      if (typeof chunk.id === "string") usage.responseId = chunk.id;
      if (typeof chunk.model === "string") usage.upstreamModel = chunk.model;
      if (!chunk.usage) return;
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage.cacheReadTokens = typeof cached === "number" ? cached : null;
      usage.inputTokens = typeof chunk.usage.prompt_tokens === "number" ? Math.max(0, chunk.usage.prompt_tokens - (cached ?? 0)) : null;
      usage.outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : null;
    };
    let finish = record(model);
    let httpStatus: number | null = null;
    response.on("close", () => {
      if (response.writableFinished) return;
      controller.abort(); finish?.({ status: "incomplete", httpStatus, ...usage });
    });
    // 上游连接断开、读流出错等任何异常：先把当前这条记为不完整，再交给外层回 502 或结束响应。
    try { await relay(); } catch (error) { finish?.({ status: "incomplete", httpStatus, ...usage }); throw error; }

    async function relay() {
    let upstream = await call(toOpenAIRequest(body, model, maxOutputTokens), apiKey, controller.signal);
    httpStatus = upstream.status;
    if (upstream.status === 404 || upstream.status === 503) {
      const detail = await upstream.text();
      finish?.({ status: "error", httpStatus, ...usage });
      const next = await fallbackFor(model, apiKey);
      if (!next) return fail(upstream.status, detail.slice(0, 500));
      log(`模型网关：${model} 返回 ${upstream.status}，改用 ${next} 重试一次`);
      finish = record(next);
      upstream = await call(toOpenAIRequest(body, next, maxOutputTokens), apiKey, controller.signal);
      httpStatus = upstream.status;
    }
    if (!upstream.ok) {
      finish?.({ status: "error", httpStatus, ...usage });
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
      const message = await upstream.json() as Record<string, unknown>;
      takeUsage(message);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(toAnthropicMessage(message, model)));
      finish?.({ status: "done", httpStatus, ...usage });
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const translator = createStreamTranslator(model);
    const decoder = new TextDecoder();
    let buffer = ""; let usageSeen = false;
    for await (const piece of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { const chunk = JSON.parse(data); if (chunk.usage) usageSeen = true; takeUsage(chunk); response.write(translator.push(chunk)); } catch { /* 单个坏块跳过，不中断整轮 */ }
      }
    }
    response.end(translator.finish());
    // 流结束了却没等到用量块，用量不可信，记不完整。
    finish?.({ status: usageSeen ? "done" : "incomplete", httpStatus, ...usage });
    }
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
    // 启动时预读一次模型状态，第一条请求就能记上厂商。
    warm: (apiKey: string) => loadStatus(apiKey, false).then(() => undefined),
    // 只听回环地址、端口随机；返回给 SDK 用的 ANTHROPIC_BASE_URL。unref：转换层不单独撑住进程，脚本跑完能正常退出。
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const DEFAULT_MODEL_GATEWAY_URL = "https://unified-kiro-gateway.juzibot.com/models/v1";
export const DEFAULT_AGENT_MODEL = "claude-5.5-sonnet";
export const DEEPSEEK_ANTHROPIC_URL = "https://api.deepseek.com/anthropic";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
export const DEFAULT_AGENT_PROVIDER = "deepseek";

// 复用已选服务的官方接口；原公司网关配置独立保留，密钥只从环境读取。
// 两个渠道都经本机回环：DeepSeek 走只透传的出口，句子互动走转换层，两处都按轮次记录用量。
export async function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ channel: UsageChannel; model: string; modelBaseUrl: string; apiKey: string; apiKeyEnvName: string; close: () => Promise<void> }> {
  const provider = env.AGENT_PROVIDER?.trim() || DEFAULT_AGENT_PROVIDER;
  if (provider === "deepseek") {
    const edge = createModelEdge({ upstream: DEEPSEEK_ANTHROPIC_URL });
    return { channel: "deepseek", model: env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL, modelBaseUrl: await edge.listen(),
      apiKey: env.DEEPSEEK_API_KEY?.trim() ?? "", apiKeyEnvName: "DEEPSEEK_API_KEY", close: edge.close };
  }
  if (provider !== "juzi") throw new Error(`不支持的 AGENT_PROVIDER：${provider}，请填写 juzi 或 deepseek`);
  const gateway = createModelGateway({ baseUrl: env.MODEL_GATEWAY_URL || DEFAULT_MODEL_GATEWAY_URL, maxOutputTokens: Number(env.MODEL_MAX_OUTPUT_TOKENS) || 8192 });
  return { channel: "juzi", model: sdkModelName(env.AGENT_MODEL || DEFAULT_AGENT_MODEL), modelBaseUrl: await gateway.listen(), apiKey: env.JUZI_MODELS_KEY?.trim() ?? "", apiKeyEnvName: "JUZI_MODELS_KEY", close: gateway.close };
}
