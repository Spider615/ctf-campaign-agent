import { getDbBinding } from "../../../db/index.ts";
import type { CampaignDraft, IcsOrderDraft, PatchOperation } from "../campaign/types.ts";
import { deserializeVersion, serializeVersion } from "./session-codec.ts";

type SessionRow = {
  id: string;
  title: string;
  entry_mode: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  produced_version_id: string | null;
};

type VersionRow = {
  id: string;
  seq: number;
  brief_json: string;
  ics_orders_json: string;
  created_by: string;
  patch_id: string | null;
  created_at: string;
};

type PatchRow = {
  id: string;
  from_version: number;
  ops_json: string;
  source: string;
  reason: string;
  model: string | null;
  tokens: number | null;
  created_at: string;
};

export type SessionSummary = SessionRow & { versionCount: number };

export async function listSessions(): Promise<SessionSummary[]> {
  const result = await getDbBinding()
    .prepare(`SELECT s.*, COUNT(v.id) AS version_count
      FROM session s LEFT JOIN draft_version v ON v.session_id = s.id
      GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 30`)
    .all<SessionRow & { version_count: number }>();
  return result.results.map((row) => ({ ...row, versionCount: Number(row.version_count) }));
}

export async function getSession(id: string) {
  const db = getDbBinding();
  const session = await db.prepare("SELECT * FROM session WHERE id = ?").bind(id).first<SessionRow>();
  if (!session) return null;
  const [messagesResult, versionsResult, patchesResult] = await Promise.all([
    db.prepare("SELECT id, role, content, created_at, produced_version_id FROM message WHERE session_id = ? ORDER BY created_at").bind(id).all<MessageRow>(),
    db.prepare("SELECT id, seq, brief_json, ics_orders_json, created_by, patch_id, created_at FROM draft_version WHERE session_id = ? ORDER BY seq").bind(id).all<VersionRow>(),
    db.prepare("SELECT id, from_version, ops_json, source, reason, model, tokens, created_at FROM patch WHERE session_id = ? ORDER BY created_at").bind(id).all<PatchRow>(),
  ]);
  return {
    session,
    messages: messagesResult.results,
    versions: versionsResult.results.map((row) => ({
      id: row.id,
      ...deserializeVersion({ seq: row.seq, draftJson: row.brief_json, ordersJson: row.ics_orders_json }),
      createdBy: row.created_by,
      patchId: row.patch_id,
      createdAt: row.created_at,
    })),
    patches: patchesResult.results.map((row) => ({ ...row, ops: JSON.parse(row.ops_json) as PatchOperation[] })),
  };
}

export async function createSession(input: {
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
  entryMode: string;
  firstMessage?: string;
}) {
  const db = getDbBinding();
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const encoded = serializeVersion(input.draft, input.orders, 1);
  const statements = [
    db.prepare("INSERT INTO session (id, title, entry_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(sessionId, input.draft.title, input.entryMode, "draft", now, now),
    db.prepare("INSERT INTO draft_version (id, session_id, seq, brief_json, ics_orders_json, created_by, patch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(versionId, sessionId, 1, encoded.draftJson, encoded.ordersJson, "human", null, now),
  ];
  if (input.firstMessage) {
    statements.push(
      db.prepare("INSERT INTO message (id, session_id, role, content, created_at, produced_version_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), sessionId, "user", input.firstMessage, now, versionId),
    );
  }
  await db.batch(statements);
  return getSession(sessionId);
}

export async function appendVersion(input: {
  sessionId: string;
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
  source: "ai" | "human" | "rollback";
  reason: string;
  ops?: PatchOperation[];
  message?: string;
}) {
  const db = getDbBinding();
  const latest = await db.prepare("SELECT MAX(seq) AS seq FROM draft_version WHERE session_id = ?").bind(input.sessionId).first<{ seq: number | null }>();
  if (!latest || latest.seq === null) throw new Error("活动记录不存在");
  const nextSeq = latest.seq + 1;
  const now = new Date().toISOString();
  const versionId = crypto.randomUUID();
  const patchId = input.ops?.length ? crypto.randomUUID() : null;
  const encoded = serializeVersion(input.draft, input.orders, nextSeq);
  const statements = [
    db.prepare("UPDATE session SET title = ?, updated_at = ? WHERE id = ?").bind(input.draft.title, now, input.sessionId),
    db.prepare("INSERT INTO draft_version (id, session_id, seq, brief_json, ics_orders_json, created_by, patch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(versionId, input.sessionId, nextSeq, encoded.draftJson, encoded.ordersJson, input.source, patchId, now),
  ];
  if (patchId) {
    statements.push(
      db.prepare("INSERT INTO patch (id, session_id, from_version, ops_json, source, reason, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(patchId, input.sessionId, latest.seq, JSON.stringify(input.ops), input.source, input.reason, input.source === "ai" ? "deepseek-flash" : null, null, now),
    );
  }
  if (input.message) {
    statements.push(
      db.prepare("INSERT INTO message (id, session_id, role, content, created_at, produced_version_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), input.sessionId, input.source === "ai" ? "user" : "assistant", input.message, now, versionId),
    );
  }
  await db.batch(statements);
  return getSession(input.sessionId);
}

