// 轮次上下文：入口用 runInUsageTurn 包住一轮，运行器拼 ANTHROPIC_BASE_URL 时调用 turnBaseUrl，
// 把轮次编号写进本机出口的路径（/t/<轮次>/<来源>）。SDK 子进程发出的每次请求都带着这个前缀，
// 所以同一进程里并发的会话不会串号。评测脚本不经过入口，不在轮次里，地址原样返回，不记录。
import { AsyncLocalStorage } from "node:async_hooks";

import type { ModelRequestFinish, ModelRequestStart, UsageStore } from "./store.ts";

const storage = new AsyncLocalStorage<string>();
let recorder: UsageStore | undefined;

export function setUsageRecorder(store: UsageStore | undefined) { recorder = store; }
export function usageRecorder() { return recorder; }
export function runInUsageTurn<T>(turnId: string, work: () => Promise<T>): Promise<T> { return storage.run(turnId, work); }

// 用量库写失败只记日志，不影响回答。
export function safely(action: () => void) {
  try { action(); } catch (error) { console.error(`[usage] 用量记录写入失败：${error instanceof Error ? error.message : error}`); }
}

export function turnBaseUrl(base: string, source: string): string {
  const turnId = storage.getStore();
  if (!turnId) return base;
  safely(() => recorder?.countSdkStart(turnId));
  return `${base.replace(/\/+$/, "")}/t/${turnId}/${source}`;
}

const TURN_PATH = /^\/t\/([0-9a-f-]{36})\/([a-z0-9-]{1,40})(\/.*)$/;
export function parseTurnPath(path: string): { turnId?: string; source?: string; rest: string } {
  const match = TURN_PATH.exec(path);
  return match ? { turnId: match[1], source: match[2], rest: match[3] } : { rest: path };
}

// 一次上游请求的记录：开始时写一行，收尾只写一次。
export function startModelRequest(start: Omit<ModelRequestStart, "id" | "startedAt">) {
  const id = crypto.randomUUID(); let open = true;
  safely(() => recorder?.startRequest({ ...start, id, startedAt: Date.now() }));
  return (finish: Omit<ModelRequestFinish, "finishedAt">) => {
    if (!open) return; open = false;
    safely(() => recorder?.finishRequest(id, { ...finish, finishedAt: Date.now() }));
  };
}
