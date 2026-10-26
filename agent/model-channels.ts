// 模型渠道：启动时把配了 key 的渠道都准备好（各自的本机回环出口），管理端切换后下一轮立即改用新渠道。
// 选中的渠道存在持久目录里，重启后保持；环境变量 AGENT_PROVIDER 只是第一次启动的默认值。
// 一轮开始时用 pin 固定渠道，这一轮里的所有模型请求和用量记录都用同一个渠道，切换不影响已经在跑的轮次。
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createModelGateway, DEEPSEEK_ANTHROPIC_URL, DEFAULT_AGENT_MODEL, DEFAULT_AGENT_PROVIDER, DEFAULT_DEEPSEEK_MODEL, DEFAULT_MODEL_GATEWAY_URL } from "./model-gateway.ts";
import { sdkModelName } from "./openai-bridge.ts";
import { createModelEdge } from "./usage/model-edge.ts";
import type { UsageChannel } from "./usage/store.ts";

export const CHANNEL_LABEL: Record<UsageChannel, string> = { deepseek: "DeepSeek 官方", juzi: "句子互动网关" };
export type ChannelConfig = { channel: UsageChannel; model: string; modelBaseUrl: string; apiKey: string };
export type ChannelSwitch = { at: number; from: UsageChannel; to: UsageChannel; by: string };
type State = { channel: UsageChannel; history: ChannelSwitch[] };
const HISTORY_LIMIT = 50;

export async function createModelChannels({ env = process.env, statePath, fetch: request }: { env?: NodeJS.ProcessEnv; statePath: string; fetch?: typeof fetch }) {
  const ready = new Map<UsageChannel, ChannelConfig>();
  const closers: Array<() => Promise<void>> = [];
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (deepseekKey) {
    const edge = createModelEdge({ upstream: DEEPSEEK_ANTHROPIC_URL, ...(request ? { fetch: request } : {}) });
    ready.set("deepseek", { channel: "deepseek", model: env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL, modelBaseUrl: await edge.listen(), apiKey: deepseekKey });
    closers.push(edge.close);
  }
  const juziKey = env.JUZI_MODELS_KEY?.trim() ?? "";
  if (juziKey) {
    const gateway = createModelGateway({ baseUrl: env.MODEL_GATEWAY_URL || DEFAULT_MODEL_GATEWAY_URL, maxOutputTokens: Number(env.MODEL_MAX_OUTPUT_TOKENS) || 8192, ...(request ? { fetch: request } : {}) });
    ready.set("juzi", { channel: "juzi", model: sdkModelName(env.AGENT_MODEL || DEFAULT_AGENT_MODEL), modelBaseUrl: await gateway.listen(), apiKey: juziKey });
    closers.push(gateway.close);
  }

  const preferred = (env.AGENT_PROVIDER?.trim() || DEFAULT_AGENT_PROVIDER) as UsageChannel;
  const fallback: UsageChannel | undefined = ready.has(preferred) ? preferred : [...ready.keys()][0];
  let state: State = { channel: fallback ?? preferred, history: [] };
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
    const history = Array.isArray(saved.history) ? saved.history.slice(-HISTORY_LIMIT) : [];
    // 上次选的渠道这次没配 key，就退回默认渠道，切换记录照旧保留。
    state = { channel: saved.channel && ready.has(saved.channel) ? saved.channel : state.channel, history };
  } catch { /* 第一次启动或文件损坏：用默认渠道 */ }

  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, statePath);
  };
  const pinned = new AsyncLocalStorage<UsageChannel>();
  const configOf = (channel: UsageChannel) => {
    const config = ready.get(channel);
    if (!config) throw new Error(`模型渠道「${CHANNEL_LABEL[channel]}」没有配置 key`);
    return config;
  };

  return {
    configured: ready.size > 0,
    active: () => state.channel,
    // 当前轮次固定的渠道；不在轮次里时取当前选中的渠道。
    current: () => configOf(pinned.getStore() ?? state.channel),
    pin<T>(work: (channel: UsageChannel) => Promise<T>): Promise<T> {
      const channel = pinned.getStore() ?? state.channel;
      return pinned.run(channel, () => work(channel));
    },
    list: () => (["deepseek", "juzi"] as UsageChannel[]).map((channel) => ({ channel, label: CHANNEL_LABEL[channel], configured: ready.has(channel), active: channel === state.channel, model: ready.get(channel)?.model ?? null })),
    history: () => [...state.history].reverse(),
    select(channel: UsageChannel, by = "管理员") {
      configOf(channel);
      if (channel === state.channel) return;
      state = { channel, history: [...state.history, { at: Date.now(), from: state.channel, to: channel, by }].slice(-HISTORY_LIMIT) };
      save();
    },
    close: async () => { await Promise.all(closers.map((close) => close())); },
  };
}
export type ModelChannels = Awaited<ReturnType<typeof createModelChannels>>;

// 给运行器的配置：model / modelBaseUrl / apiKey 每次读取时取当前轮次的渠道，其余字段原样。
export function liveModelConfig<T extends object>(channels: Pick<ModelChannels, "current">, rest: T): T & { model: string; modelBaseUrl: string; apiKey: string } {
  return Object.defineProperties({ ...rest }, {
    model: { get: () => channels.current().model, enumerable: true },
    modelBaseUrl: { get: () => channels.current().modelBaseUrl, enumerable: true },
    apiKey: { get: () => channels.current().apiKey, enumerable: true },
  }) as T & { model: string; modelBaseUrl: string; apiKey: string };
}
