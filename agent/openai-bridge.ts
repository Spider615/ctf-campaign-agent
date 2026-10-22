// Anthropic Messages ⇄ OpenAI Chat Completions 的协议转换（纯函数）。
// Agent SDK 只会说 Anthropic 协议，公司模型网关只开放 OpenAI 兼容接口，model-gateway.ts 用这里的函数在中间转。
// 网关会拒绝 thinking、metadata、temperature、top_p（实测 400），这些字段一律不转发。

type Json = Record<string, unknown>;
type AnthropicBlock = { type: string; [key: string]: unknown };
type OpenAIPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OpenAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OpenAIMessage =
  | { role: "system" | "user"; content: string | OpenAIPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string | OpenAIPart[] };

const blocksOf = (content: unknown): AnthropicBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as AnthropicBlock[] : [];

function imagePart(block: AnthropicBlock): OpenAIPart | undefined {
  const source = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (source?.type === "base64" && source.data) return { type: "image_url", image_url: { url: `data:${source.media_type ?? "image/png"};base64,${source.data}` } };
  if (source?.type === "url" && source.url) return { type: "image_url", image_url: { url: source.url } };
  return undefined;
}

// 文本和图片转成 OpenAI 的内容片段；纯文本时压成字符串，兼容性最好。
function partsOf(blocks: AnthropicBlock[]): string | OpenAIPart[] {
  const parts: OpenAIPart[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
    else if (block.type === "image") { const part = imagePart(block); if (part) parts.push(part); }
    else if (block.type === "document") {
      const source = block.source as { type?: string; data?: string } | undefined;
      if (source?.type === "text" && source.data) parts.push({ type: "text", text: source.data });
    }
  }
  return parts.every((part) => part.type === "text") ? parts.map((part) => (part as { text: string }).text).join("\n") : parts;
}

const EFFORT: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

// maxTokens：网关给每个模型配了输出上限（claude-5.5-sonnet 实测 8192），超了直接 400，SDK 默认会要更多，这里截住。
export function toOpenAIRequest(body: Json, model: string, maxTokens = Infinity): Json {
  const messages: OpenAIMessage[] = [];
  const system = typeof body.system === "string" ? body.system : partsOf(blocksOf(body.system));
  if (system) messages.push({ role: "system", content: typeof system === "string" ? system : system.map((part) => part.type === "text" ? part.text : "").join("\n") });
  for (const message of (body.messages ?? []) as Array<{ role: string; content: unknown }>) {
    const blocks = blocksOf(message.content);
    if (message.role === "assistant") {
      const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
      const calls = blocks.filter((block) => block.type === "tool_use").map((block): OpenAIToolCall => ({ id: String(block.id), type: "function", function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) } }));
      messages.push({ role: "assistant", content: text || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Anthropic 把工具结果放在 user 消息里；OpenAI 要求它们是紧跟在 assistant 后面的独立 tool 消息。
    for (const block of blocks.filter((item) => item.type === "tool_result")) {
      const content = partsOf(blocksOf(block.content));
      const marked = block.is_error && typeof content === "string" ? `[工具报错] ${content}` : content;
      messages.push({ role: "tool", tool_call_id: String(block.tool_use_id), content: marked === "" ? "(空)" : marked });
    }
    const rest = blocks.filter((item) => item.type !== "tool_result");
    if (rest.length) { const content = partsOf(rest); if (content !== "" && !(Array.isArray(content) && !content.length)) messages.push({ role: "user", content }); }
  }
  const tools = ((body.tools ?? []) as Array<{ name: string; description?: string; input_schema?: unknown }>)
    .filter((tool) => tool.input_schema)
    .map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.input_schema } }));
  const choice = body.tool_choice as { type?: string; name?: string } | undefined;
  const toolChoice = !choice || !tools.length ? undefined
    : choice.type === "any" ? "required" : choice.type === "none" ? "none"
    : choice.type === "tool" && choice.name ? { type: "function", function: { name: choice.name } } : "auto";
  const effort = EFFORT[String((body.output_config as { effort?: string } | undefined)?.effort ?? "")];
  return {
    model,
    messages,
    max_tokens: Math.min(Number(body.max_tokens ?? 8192), maxTokens),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length ? { stop: body.stop_sequences } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(body.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };

const usageOf = (usage: OpenAIUsage | undefined) => {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached), output_tokens: usage?.completion_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
};

const STOP_REASON: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };
const stopReasonOf = (reason: string | null | undefined) => STOP_REASON[reason ?? ""] ?? "end_turn";

function parseArguments(text: string): unknown {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

export function toAnthropicMessage(body: Json, model: string): Json {
  const choice = ((body.choices ?? []) as Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }>)[0];
  const content: Json[] = [];
  if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice?.message?.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  return { id: String(body.id ?? `msg_${Date.now()}`), type: "message", role: "assistant", model, content, stop_reason: stopReasonOf(choice?.finish_reason), stop_sequence: null, usage: usageOf(body.usage as OpenAIUsage | undefined) };
}

// 流式：逐块喂入 OpenAI 的 chunk，吐出 Anthropic 的 SSE 事件。usage 在 finish_reason 之后的独立块里到达，所以收尾放到 finish()。
export function createStreamTranslator(model: string) {
  let started = false; let index = -1; let open: "text" | "tool" | undefined; let stopReason = "end_turn"; let usage: OpenAIUsage | undefined;
  const toolIndex = new Map<number, number>();
  const events: Array<[string, Json]> = [];
  const emit = (type: string, data: Json) => events.push([type, { type, ...data }]);
  const close = () => { if (open) { emit("content_block_stop", { index }); open = undefined; } };
  const start = (id: string) => {
    if (started) return; started = true;
    emit("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: usageOf(undefined) } });
  };
  const drain = () => events.splice(0).map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return {
    push(chunk: Json): string {
      start(String(chunk.id ?? `msg_${Date.now()}`));
      if (chunk.usage) usage = chunk.usage as OpenAIUsage;
      for (const choice of (chunk.choices ?? []) as Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>) {
        const text = choice.delta?.content;
        if (text) {
          if (open !== "text") { close(); index++; open = "text"; emit("content_block_start", { index, content_block: { type: "text", text: "" } }); }
          emit("content_block_delta", { index, delta: { type: "text_delta", text } });
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          const key = call.index ?? 0;
          if (call.id && !toolIndex.has(key)) {
            close(); index++; open = "tool"; toolIndex.set(key, index);
            emit("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: call.function?.name ?? "", input: {} } });
          }
          const at = toolIndex.get(key);
          if (at !== undefined && call.function?.arguments) emit("content_block_delta", { index: at, delta: { type: "input_json_delta", partial_json: call.function.arguments } });
        }
        if (choice.finish_reason) { stopReason = stopReasonOf(choice.finish_reason); close(); }
      }
      return drain();
    },
    finish(): string {
      start(`msg_${Date.now()}`); close();
      const final = usageOf(usage);
      emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: final.input_tokens, output_tokens: final.output_tokens, cache_read_input_tokens: final.cache_read_input_tokens } });
      emit("message_stop", {});
      return drain();
    },
  };
}

// 上游错误转成 Anthropic 的错误体：SDK 按 type 决定是否重试（429/5xx 重试，认证和参数错误不重试）。
export function anthropicErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 503 || status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

// 网关别名是 claude-sonnet-5-5 这种 Anthropic 官方写法，SDK 认得它才会按真实能力配置；网关两种写法都接受。
export function sdkModelName(model: string): string {
  const match = /^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku|fable)$/.exec(model);
  return match ? `claude-${match[2]}-${match[1].replace(".", "-")}` : model;
}
