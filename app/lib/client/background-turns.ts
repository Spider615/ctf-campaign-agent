// 进行中的请求按会话登记在模块里，不挂在组件实例上：切换会话只卸载界面，请求继续跑完并落库，
// 切回来时新组件从这里接着读实时状态。同一会话同时只允许一个请求，不同会话互不影响。
// 整页刷新或关闭标签页会断开连接：附件问答随之中止；直接问答带运行标识在服务端跑完，重新打开对话时接上。
import type { AgentTraceEvent } from "../tool-trace.ts";
import type { Snapshot } from "../server/turns.ts";
import type { TurnBody } from "./api.ts";
import { emptyLiveReply, type LiveReply } from "./live-reply.ts";

export type BackgroundEntry<T> = { token: symbol; controller: AbortController; state: T };
const NO_KEYS: ReadonlySet<string> = new Set();

export function createBackgroundRegistry<T>() {
  const entries = new Map<string, BackgroundEntry<T>>();
  const listeners = new Set<() => void>();
  let keys = NO_KEYS;
  const emit = () => {
    keys = entries.size ? new Set(entries.keys()) : NO_KEYS;
    listeners.forEach((listener) => listener());
  };
  const owns = (key: string, token: symbol) => entries.get(key)?.token === token;

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get(key: string): BackgroundEntry<T> | undefined {
      return entries.get(key);
    },
    // 侧栏用来标「回复中」；同一份集合对象在两次变化之间保持不变，满足 useSyncExternalStore。
    activeKeys(): ReadonlySet<string> {
      return keys;
    },
    serverKeys(): ReadonlySet<string> {
      return NO_KEYS;
    },
    has(key: string): boolean {
      return entries.has(key);
    },
    begin(key: string, state: T, controller = new AbortController()): BackgroundEntry<T> | null {
      if (entries.has(key) || controller.signal.aborted) return null;
      const entry = { token: Symbol(key), controller, state };
      entries.set(key, entry);
      emit();
      return entry;
    },
    // 只有这次请求本人还登记着、且没被停止时才算数；停止或被替换后迟到的事件一律丢弃。
    isLive(key: string, token: symbol): boolean {
      return owns(key, token) && !entries.get(key)!.controller.signal.aborted;
    },
    patch(key: string, token: symbol, change: (state: T) => T) {
      const entry = entries.get(key);
      if (!entry || entry.token !== token) return;
      entries.set(key, { ...entry, state: change(entry.state) });
      emit();
    },
    end(key: string, token: symbol): boolean {
      if (!owns(key, token)) return false;
      entries.delete(key);
      emit();
      return true;
    },
    // keep=true 时保留登记直到请求自己收尾（期间仍算忙），否则立刻释放。
    abort(key: string, options: { keep?: boolean; change?: (state: T) => T } = {}): BackgroundEntry<T> | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entry.controller.abort();
      if (options.keep) entries.set(key, { ...entry, state: options.change ? options.change(entry.state) : entry.state });
      else entries.delete(key);
      emit();
      return entry;
    },
  };
}

// 活动会话（/c/[id] 和营销对话里嵌着的活动）：按活动 id 登记。
export type CampaignLiveTurn = {
  kind: TurnBody["type"];
  pendingText: string | null;
  pendingAt: string | null;
  trace: AgentTraceEvent[];
  reply: LiveReply;
  phase: "analyzing" | "writing" | null;
  startedAt: number | null;
  stopping: boolean;
};

export function campaignLiveTurn(kind: TurnBody["type"], streams: boolean, text?: string): CampaignLiveTurn {
  return {
    kind,
    pendingText: text ?? null,
    pendingAt: text === undefined ? null : new Date().toISOString(),
    trace: [],
    reply: emptyLiveReply(),
    phase: streams ? "analyzing" : null,
    startedAt: streams ? Date.now() : null,
    stopping: false,
  };
}

export const campaignTurns = createBackgroundRegistry<CampaignLiveTurn>();

// 两份快照取更新的那份：先比版本，再比消息条数（不改字段的回合只多消息不加版本）。
export function newerSnapshot(current: Snapshot | null, next: Snapshot): Snapshot {
  if (!current || current.session.id !== next.session.id) return next;
  if (next.latest.seq !== current.latest.seq) return next.latest.seq > current.latest.seq ? next : current;
  return next.messages.length >= current.messages.length ? next : current;
}

// 营销对话（数据分析、新建活动）按浏览器里的对话 id 登记；附件问答按所在活动 id 登记。
// 刷新或关页时浏览器会切断进行中的连接；带运行标识的回答仍在服务端跑，这时不能记成失败，留给新页面接上。
let unloading = false;
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => { unloading = true; });
  window.addEventListener("pagehide", () => { unloading = true; });
  window.addEventListener("pageshow", () => { unloading = false; });
}
export const analysisTurns = { ...createBackgroundRegistry<{ replyId?: string; clock: number; pendingCreation?: string; runId?: string }>(), unloading: () => unloading };
export const fileTurns = createBackgroundRegistry<{ id: string; started: number }>();
