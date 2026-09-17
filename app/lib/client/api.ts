import type { Snapshot } from "../server/turns.ts";
import type { ClientTurnBody } from "../turn-identity.ts";
import { consumeTurnStream, type TurnStreamHandlers } from "./stream.ts";

export const SESSIONS_CHANGED = "campaign:sessions-changed";
export const SESSION_UPDATED = "campaign:session-updated";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error || "请求失败，请重试");
  return body;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type TurnBody = ClientTurnBody;
type TurnRequestBody = TurnBody & { expectedSeq: number; clientTurnId?: string };

function identifyTurn(body: TurnRequestBody): TurnRequestBody & { clientTurnId: string } {
  return body.clientTurnId ? body as TurnRequestBody & { clientTurnId: string } : { ...body, clientTurnId: crypto.randomUUID() };
}

export function fetchSnapshot(id: string, signal?: AbortSignal): Promise<Snapshot> {
  return request<Snapshot>(`/api/sessions/${encodeURIComponent(id)}`, { signal });
}

export function createSessionRequest(body: { entryMode: "new"; text: string } | { entryMode: "example" }): Promise<Snapshot> {
  return request<Snapshot>("/api/sessions", json(body));
}

export function postTurn(id: string, body: TurnRequestBody): Promise<Snapshot> {
  return request<Snapshot>(`/api/sessions/${encodeURIComponent(id)}/turns`, json(identifyTurn(body)));
}

export async function postTurnStream(
  id: string,
  body: TurnRequestBody,
  handlers: TurnStreamHandlers,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/turns`, {
    ...json(identifyTurn(body)),
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    signal,
  });
  return consumeTurnStream(response, handlers, signal);
}

export function notifySessionsChanged() {
  window.dispatchEvent(new Event(SESSIONS_CHANGED));
}

export function notifySessionUpdated(id: string) {
  window.dispatchEvent(new CustomEvent(SESSION_UPDATED, { detail: id }));
}
