import { AGENT_IDENTITY, AGENT_IDENTITY_VARIANTS, AGENT_NAME } from "./persona.ts";

// Agent 对外回复的唯一清洗入口。流式预览和最终落库共用它，避免先展示、后删除。
const UPLIFT_CLAIM = /[^。！？\n]*(提升|增长|增加)[^。，,]{0,6}\d+(?:\.\d+)?\s*%[^。！？\n]*[。！？]?/g;
const MAX_REPLY = 800;

// 底层模型、厂商和框架的名字一律不对外说。整句去掉而不是换词，换词会拼出「我是小福模型，由小福驱动」这种话。
const UNDERLYING_MODEL = /deepseek|深度求索|claude|anthropic|openai|chatgpt|gpt|gemini|llama|qwen|通义千问|文心一言|agent\s*sdk/i;
// 去掉的句子是在介绍自己时补一句对外身份，否则「你是什么模型」只剩答非所问。
const SELF_REFERENCE = /我|本助手|底层|驱动|基于|模型/;
const SELF_INTRO = `我是${AGENT_NAME}，${AGENT_IDENTITY}。`;

export function mentionsUnderlyingModel(text: string): boolean {
  return UNDERLYING_MODEL.test(text);
}

function withoutUnderlyingModel(text: string): string {
  if (!UNDERLYING_MODEL.test(text)) return text;
  let introducedItself = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const sentences = line.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [line];
    const kept = sentences.filter((sentence) => {
      if (!UNDERLYING_MODEL.test(sentence)) return true;
      if (SELF_REFERENCE.test(sentence)) introducedItself = true;
      return false;
    });
    if (kept.length === sentences.length) lines.push(line);
    else if (kept.length) lines.push(kept.join("").trimStart());
  }
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return SELF_INTRO;
  return introducedItself && !body.includes(AGENT_NAME) && !body.includes(AGENT_IDENTITY) ? SELF_INTRO + body : body;
}

function trimReply(text: string): string {
  const kept: string[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    if (total >= MAX_REPLY) break;
    if (!line.trim()) {
      if (kept.length) kept.push("");
      continue;
    }
    let out = "";
    for (const sentence of line.match(/[^。！？!；;]+[。！？!；;]?/g) ?? [line]) {
      if ((total || out) && total + out.length + sentence.length > MAX_REPLY) break;
      out += sentence;
    }
    if (!out) break;
    kept.push(out);
    total += out.length;
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.join("\n");
}

export function sanitizeAgentReply(reply: string | null): string {
  const text = (reply ?? "").replace(UPLIFT_CLAIM, "").replace(AGENT_IDENTITY_VARIANTS, AGENT_IDENTITY).trim();
  return trimReply(withoutUnderlyingModel(text));
}

export type ReplyStreamAction =
  | { type: "text_delta"; delta: string }
  | { type: "text_reset" };

export type ReplyStreamState = {
  active: boolean;
  blockedByTool: boolean;
  raw: string;
  emitted: string;
};

export type ReplyStreamInput = {
  parentToolUseId: string | null;
  event: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function createReplyStreamState(): ReplyStreamState {
  return { active: false, blockedByTool: false, raw: "", emitted: "" };
}

// 只放出完整句子或完整行：这样跨 chunk 的「提升 20%」也不会短暂泄漏到界面。
function completePrefix(text: string): string {
  let end = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/[。！？!；;\n]/.test(text[index])) end = index + 1;
  }
  return text.slice(0, end);
}

function reconcile(state: ReplyStreamState, next: string): ReplyStreamAction[] {
  if (next === state.emitted) return [];
  if (next.startsWith(state.emitted)) {
    const delta = next.slice(state.emitted.length);
    state.emitted = next;
    return delta ? [{ type: "text_delta", delta }] : [];
  }
  const actions: ReplyStreamAction[] = state.emitted ? [{ type: "text_reset" }] : [];
  state.emitted = next;
  if (next) actions.push({ type: "text_delta", delta: next });
  return actions;
}

function resetCandidate(state: ReplyStreamState): ReplyStreamAction[] {
  const actions: ReplyStreamAction[] = state.emitted ? [{ type: "text_reset" }] : [];
  state.active = true;
  state.blockedByTool = false;
  state.raw = "";
  state.emitted = "";
  return actions;
}

// 刻意不依赖 SDK 类型：根目录测试无需安装 agent/ 的依赖也能覆盖这条安全边界。
export function reduceReplyStream(previous: ReplyStreamState, input: ReplyStreamInput): { state: ReplyStreamState; actions: ReplyStreamAction[] } {
  const state = { ...previous };
  if (input.parentToolUseId !== null || !isRecord(input.event) || typeof input.event.type !== "string") {
    return { state, actions: [] };
  }

  if (input.event.type === "message_start") return { state, actions: resetCandidate(state) };
  if (!state.active) return { state, actions: [] };

  if (input.event.type === "content_block_start") {
    const block = isRecord(input.event.contentBlock)
      ? input.event.contentBlock
      : isRecord(input.event.content_block)
        ? input.event.content_block
        : null;
    if (block?.type === "tool_use") {
      const actions = state.emitted ? [{ type: "text_reset" as const }] : [];
      state.blockedByTool = true;
      state.raw = "";
      state.emitted = "";
      return { state, actions };
    }
    if (block?.type === "text" && typeof block.text === "string" && !state.blockedByTool) {
      state.raw += block.text;
      return { state, actions: reconcile(state, sanitizeAgentReply(completePrefix(state.raw))) };
    }
    return { state, actions: [] };
  }

  if (input.event.type === "content_block_delta") {
    const delta = isRecord(input.event.delta) ? input.event.delta : null;
    if (state.blockedByTool || delta?.type !== "text_delta" || typeof delta.text !== "string") {
      return { state, actions: [] };
    }
    state.raw += delta.text;
    return { state, actions: reconcile(state, sanitizeAgentReply(completePrefix(state.raw))) };
  }

  if (input.event.type === "message_stop") {
    const actions = state.blockedByTool ? [] : reconcile(state, sanitizeAgentReply(state.raw));
    state.active = false;
    return { state, actions };
  }

  return { state, actions: [] };
}
