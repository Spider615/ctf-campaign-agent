import type { FillSheet } from "../campaign/ics1811/fill-sheet.ts";
import { decodeMessage, encodeMessage, type ChatMessage, type StoredMessage } from "../campaign/ics1811/messages.ts";
import type { CampaignDraft } from "../campaign/types.ts";
import { parseCampaignDocument, type CampaignDocument } from "./request-validation.ts";

// 新状态描述整场活动；后三项只为兼容旧会话，其中 confirmed 仅表示旧 1811 填写值已就绪。
export type SessionStatus = "briefing" | "preparing" | "needs_confirmation" | "ics_ready" | "collecting" | "readback" | "confirmed";

export type SessionRecord = {
  id: string;
  title: string;
  entryMode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

// draft 存活动父层（brief_json 列），sheet 继续存单份 1811 填写值快照（ics_orders_json 列）。
export type VersionRecord = {
  id: string;
  seq: number;
  draft: CampaignDraft;
  sheet: FillSheet | null;
  createdBy: "ai" | "human" | "rollback";
  createdAt: string;
};

export type MessageRecord = ChatMessage & { producedVersionId: string | null };

// legacy：会话是旧版本（营销方案 + 拆单）创建的，草稿结构对不上，不再打开。
export type SessionBundle = {
  session: SessionRecord;
  messages: MessageRecord[];
  versions: VersionRecord[];
  legacy: boolean;
};

export type SessionListItem = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  versionCount: number;
};

export type TurnWrite = {
  isNew: boolean;
  now: string;
  session: SessionRecord;
  version: (Omit<VersionRecord, "createdAt" | "draft"> & {
    draft: CampaignDocument;
    patch: { id: string; ops: unknown; source: "ai" | "human"; reason: string } | null;
  }) | null;
  messages: Array<{ id: string; role: "user" | "assistant"; content: StoredMessage; producedVersionId: string | null; createdAt?: string }>;
};

export interface SessionStore {
  list(): Promise<SessionListItem[]>;
  load(id: string): Promise<SessionBundle | null>;
  commit(write: TurnWrite): Promise<void>;
  // 幂等：删不存在的会话不是错误（重复点删除、多个标签页同时删都会走到这里）。
  remove(id: string): Promise<void>;
}

export class ConflictError extends Error {}

type SessionRow = { id: string; title: string; entry_mode: string; status: string; created_at: string; updated_at: string };

const toSession = (row: SessionRow): SessionRecord => ({ id: row.id, title: row.title, entryMode: row.entry_mode, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeStoredDraft(value: unknown): CampaignDraft {
  const draft = parseCampaignDocument(value);
  if (!draft) throw new Error("活动草稿结构不受支持");
  return draft;
}

export function createD1Store(db: D1Database): SessionStore {
  return {
    async list() {
      const result = await db.prepare(`SELECT s.*,
          (SELECT COUNT(*) FROM draft_version v WHERE v.session_id = s.id) AS version_count
        FROM session s ORDER BY s.updated_at DESC LIMIT 30`).all<SessionRow & { version_count: number }>();
      return result.results.map((row) => ({ id: row.id, title: row.title, status: row.status, updatedAt: row.updated_at, versionCount: Number(row.version_count) }));
    },

    async load(id) {
      const row = await db.prepare("SELECT * FROM session WHERE id = ?").bind(id).first<SessionRow>();
      if (!row) return null;
      const [messages, versions] = await Promise.all([
        db.prepare("SELECT id, role, content, created_at, produced_version_id FROM message WHERE session_id = ? ORDER BY created_at, rowid")
          .bind(id)
          .all<{ id: string; role: string; content: string; created_at: string; produced_version_id: string | null }>(),
        db.prepare("SELECT id, seq, brief_json, ics_orders_json, created_by, created_at FROM draft_version WHERE session_id = ? ORDER BY seq")
          .bind(id)
          .all<{ id: string; seq: number; brief_json: string; ics_orders_json: string; created_by: string; created_at: string }>(),
      ]);
      const drafts = versions.results.map((version) => parseCampaignDocument(parseJson(version.brief_json)));
      const legacy = drafts.some((draft) => draft === null);
      return {
        session: toSession(row),
        legacy,
        messages: legacy ? [] : messages.results.map((message) => ({
          id: message.id,
          role: message.role === "user" ? "user" : "assistant",
          createdAt: message.created_at,
          content: decodeMessage(message.role, message.content),
          producedVersionId: message.produced_version_id,
        })),
        versions: legacy ? [] : versions.results.map((version, index) => ({
          id: version.id,
          seq: Number(version.seq),
          draft: drafts[index] as CampaignDraft,
          sheet: (parseJson(version.ics_orders_json) as FillSheet | null) ?? null,
          createdBy: version.created_by === "ai" || version.created_by === "rollback" ? version.created_by : "human",
          createdAt: version.created_at,
        })),
      };
    },

    async commit(write) {
      const { session, version, now } = write;
      const statements: D1PreparedStatement[] = [];
      if (write.isNew) {
        statements.push(db.prepare("INSERT INTO session (id, title, entry_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(session.id, session.title, session.entryMode, session.status, session.createdAt, session.updatedAt));
      } else {
        statements.push(db.prepare("UPDATE session SET title = ?, status = ?, updated_at = ? WHERE id = ?")
          .bind(session.title, session.status, session.updatedAt, session.id));
      }
      if (version) {
        const draft = normalizeStoredDraft(version.draft);
        if (version.patch) {
          statements.push(db.prepare("INSERT INTO patch (id, session_id, from_version, ops_json, source, reason, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(version.patch.id, session.id, version.seq - 1, JSON.stringify(version.patch.ops), version.patch.source, version.patch.reason, null, null, now));
        }
        statements.push(db.prepare("INSERT INTO draft_version (id, session_id, seq, brief_json, ics_orders_json, created_by, patch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(version.id, session.id, version.seq, JSON.stringify(draft), JSON.stringify(version.sheet), version.createdBy, version.patch?.id ?? null, now));
      }
      for (const message of write.messages) {
        statements.push(db.prepare("INSERT INTO message (id, session_id, role, content, created_at, produced_version_id) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(message.id, session.id, message.role, encodeMessage(message.content), message.createdAt ?? now, message.producedVersionId));
      }
      try {
        await db.batch(statements);
      } catch (error) {
        if (String(error instanceof Error ? error.message : error).includes("UNIQUE")) throw new ConflictError("页面已更新，请重试");
        throw error;
      }
    },

    // message、draft_version、patch 都只按 session_id 关联，schema 里没有外键级联，
    // 所以四张表要自己按顺序清干净，漏一张就会留下读不到的孤儿行。
    async remove(id) {
      await db.batch([
        db.prepare("DELETE FROM message WHERE session_id = ?").bind(id),
        db.prepare("DELETE FROM draft_version WHERE session_id = ?").bind(id),
        db.prepare("DELETE FROM patch WHERE session_id = ?").bind(id),
        db.prepare("DELETE FROM session WHERE id = ?").bind(id),
      ]);
    },
  };
}

export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, SessionBundle>();
  return {
    async list() {
      return [...sessions.values()]
        .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))
        .map((bundle) => ({ id: bundle.session.id, title: bundle.session.title, status: bundle.session.status, updatedAt: bundle.session.updatedAt, versionCount: bundle.versions.length }));
    },
    async load(id) {
      const bundle = sessions.get(id);
      if (!bundle) return null;
      const copy = structuredClone(bundle);
      const drafts = copy.versions.map((version) => parseCampaignDocument(version.draft));
      const legacy = drafts.some((draft) => draft === null);
      return {
        ...copy,
        legacy,
        messages: legacy ? [] : copy.messages,
        versions: legacy ? [] : copy.versions.map((version, index) => ({ ...version, draft: drafts[index] as CampaignDraft })),
      };
    },
    async commit(write) {
      const existing = sessions.get(write.session.id);
      if (write.isNew && existing) throw new ConflictError("会话已存在");
      if (!write.isNew && !existing) throw new Error("会话不存在");
      if (write.version && existing?.versions.some((version) => version.seq === write.version!.seq)) throw new ConflictError("页面已更新，请重试");
      // 与 D1 的 message.id 主键一致：跨会话和同一 batch 内都唯一，冲突前不能改变任何数据。
      const messageIds = new Set([...sessions.values()].flatMap((bundle) => bundle.messages.map((message) => message.id)));
      for (const message of write.messages) {
        if (messageIds.has(message.id)) throw new ConflictError("页面已更新，请重试");
        messageIds.add(message.id);
      }
      const bundle: SessionBundle = existing ? structuredClone(existing) : { session: write.session, messages: [], versions: [], legacy: false };
      bundle.session = { ...write.session };
      if (write.version) {
        const { patch: _patch, ...version } = write.version;
        void _patch;
        bundle.versions.push(structuredClone({ ...version, draft: normalizeStoredDraft(version.draft), createdAt: write.now }));
      }
      for (const message of write.messages) {
        bundle.messages.push(structuredClone({ ...message, createdAt: message.createdAt ?? write.now }));
      }
      sessions.set(write.session.id, bundle);
    },
    async remove(id) {
      sessions.delete(id);
    },
  };
}
