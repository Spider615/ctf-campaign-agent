import type { TopicId } from "../campaign/topics";
import type { Snapshot } from "../server/turns";

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

export type TurnBody =
  | { type: "text"; text: string }
  | { type: "answer"; topic: TopicId; values: Record<string, unknown>; origin: "chat" | "panel" | "tool" }
  | { type: "clarify_submit"; answers: Record<string, unknown> }
  | { type: "interpret" }
  | { type: "generate" }
  | { type: "undo"; versionSeq: number }
  | { type: "rollback"; seq: number };

export function fetchSnapshot(id: string): Promise<Snapshot> {
  return request<Snapshot>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function createSessionRequest(body: { entryMode: "new"; text: string } | { entryMode: "example" }): Promise<Snapshot> {
  return request<Snapshot>("/api/sessions", json(body));
}

export function postTurn(id: string, body: TurnBody & { expectedSeq: number }): Promise<Snapshot> {
  return request<Snapshot>(`/api/sessions/${encodeURIComponent(id)}/turns`, json(body));
}

export function notifySessionsChanged() {
  window.dispatchEvent(new Event(SESSIONS_CHANGED));
}

export function notifySessionUpdated(id: string) {
  window.dispatchEvent(new CustomEvent(SESSION_UPDATED, { detail: id }));
}
