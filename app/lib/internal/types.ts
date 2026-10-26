// 与 Agent 内部接口（agent/usage/store.ts）的返回结构一致；前端不能 import agent/。
import type { InternalChannel } from "./format";

type Tokens = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
export type OverviewDay = { day: string; channel: InternalChannel; turns: number; requests: number; incompleteRequests: number; costYuan: number | null; unpricedRequests: number } & Tokens;
export type OverviewModel = { channel: InternalChannel; model: string; requests: number; inputTokens: number | null; outputTokens: number | null };
export type Overview = { days: OverviewDay[]; statuses: Record<string, number>; models: OverviewModel[]; durations: { turnsMs: { p50: number | null; p90: number | null } } };
export type ConversationRow = { key: string; entry: string; visitor: string | null; title: string; lastQuestion: string; turns: number; channels: InternalChannel[]; inputTokens: number | null; outputTokens: number | null; costYuan: number | null; unpricedRequests: number; durationMs: number; lastAt: number; internal: boolean };
export type TraceStep = { title: string; status: string; summary?: string; startedAt: number; durationMs?: number };
export type RequestRecord = { id: string; source: string; channel: InternalChannel; sdkModel: string; sentModel: string; vendor: string | null; vendorBasis: string; startedAt: number; status: string; httpStatus?: number | null; responseId?: string | null; upstreamModel?: string | null; finishedAt?: number; costYuan: number | null } & Partial<Tokens>;
export type TurnRecord = { id: string; entry: string; channel: InternalChannel; question: string; startedAt: number; status: string; sdkStarts: number; reply?: string | null; error?: string | null; trace?: TraceStep[]; finishedAt?: number; internal: boolean; requests: RequestRecord[]; costYuan: number | null; unpricedRequests: number };
export type ConversationDetail = { key: string; entry: string; visitor: string | null; turns: TurnRecord[] };
