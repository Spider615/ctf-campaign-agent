// 入口建轮次：请求到达就写一行，结束时按真实结果收尾（完成、部分、失败、取消）。
// 轮次编号由服务端生成；访客只存哈希前 12 位；会话编号只认 UUID 或活动编号的安全格式。
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { isTurnCancelled } from "../../app/lib/cancellation.ts";
import type { AgentTraceEvent } from "../../app/lib/tool-trace.ts";
import { runInUsageTurn, safely } from "./context.ts";
import type { TraceStep, TurnFinish, TurnStart, UsageChannel, UsageEntry, UsageStore } from "./store.ts";

export type UsageIdentity = { visitor: string | null; conversationId: string | null; internal: boolean };
type Outcome = Pick<TurnFinish, "status" | "reply">;

const header = (request: IncomingMessage, name: string) => { const value = request.headers[name]; return typeof value === "string" ? value.trim() : ""; };
export const visitorHash = (owner: string) => createHash("sha256").update(owner).digest("hex").slice(0, 12);

// isInternal 由管理员凭据决定（见 admin.ts），客户端不能自报内部流量。
export function usageIdentity(request: IncomingMessage, isInternal: (token: string | undefined) => boolean = () => false): UsageIdentity {
  const owner = header(request, "x-ctf-visitor") || header(request, "x-analytics-owner") || header(request, "x-attachments-owner");
  const conversation = header(request, "x-ctf-conversation");
  return {
    visitor: /^[0-9a-f-]{36}$/.test(owner) ? visitorHash(owner) : null,
    conversationId: /^[A-Za-z0-9-]{1,64}$/.test(conversation) ? conversation : null,
    internal: isInternal(header(request, "x-ctf-admin") || undefined),
  };
}

const traceStep = (event: AgentTraceEvent): TraceStep => ({ title: event.title, status: event.status, ...(event.summary ? { summary: event.summary } : {}), startedAt: event.startedAt, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) });

export async function recordTurn<T>(
  store: UsageStore | undefined,
  start: Omit<TurnStart, "id" | "startedAt"> & { entry: UsageEntry; channel: UsageChannel },
  work: (emitTrace: (event: AgentTraceEvent) => void) => Promise<T>,
  outcome: (result: T) => Outcome,
  signal: AbortSignal,
  publicError: (message: string) => string,
): Promise<T> {
  if (!store) return work(() => {});
  const id = crypto.randomUUID();
  const steps = new Map<string, TraceStep>();
  const emitTrace = (event: AgentTraceEvent) => { steps.set(event.id, traceStep(event)); };
  safely(() => store.startTurn({ ...start, id, startedAt: Date.now() }));
  const finish = (result: Omit<TurnFinish, "trace" | "finishedAt">) => safely(() => store.finishTurn(id, { ...result, trace: [...steps.values()], finishedAt: Date.now() }));
  try {
    const result = await runInUsageTurn(id, () => work(emitTrace));
    if (signal.aborted) finish({ status: "cancelled", reply: null, error: null });
    else { const { status, reply } = outcome(result); finish({ status, reply, error: null }); }
    return result;
  } catch (error) {
    if (signal.aborted || isTurnCancelled(error)) finish({ status: "cancelled", reply: null, error: null });
    else finish({ status: "failed", reply: null, error: publicError(error instanceof Error ? error.message : "执行失败") });
    throw error;
  }
}
