import { decodeMessage, encodeMessage, type ChatMessage, type StoredMessage } from "../campaign/messages.ts";
import { deriveStatus } from "../campaign/planner.ts";
import { buildIcsDrafts } from "../campaign/split-orders.ts";
import { noIcsOrders } from "../campaign/topics.ts";
import type { CampaignDraft, IcsOrderDraft, PatchOperation } from "../campaign/types.ts";
import { validateDraft } from "../campaign/validator.ts";

export type SessionRecord = {
  id: string;
  title: string;
  entryMode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type VersionRecord = {
  id: string;
  seq: number;
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
  createdBy: "ai" | "human" | "rollback";
  createdAt: string;
};

export type MessageRecord = ChatMessage & { producedVersionId: string | null };

export type SessionBundle = {
  session: SessionRecord;
  messages: MessageRecord[];
  versions: VersionRecord[];
};

export type SessionListItem = {
  id: string;
  title: string;
  status: string;
  noIcs: boolean;
  updatedAt: string;
  versionCount: number;
};

export type TurnWrite = {
  isNew: boolean;
  now: string;
  session: SessionRecord;
  version: (Omit<VersionRecord, "createdAt"> & { patch: { id: string; ops: PatchOperation[]; source: "ai" | "human"; reason: string } | null }) | null;
  messages: Array<{ id: string; role: "user" | "assistant"; content: StoredMessage; producedVersionId: string | null }>;
};

export interface SessionStore {
  list(): Promise<SessionListItem[]>;
  load(id: string): Promise<SessionBundle | null>;
  commit(write: TurnWrite): Promise<void>;
}

export class ConflictError extends Error {}

function listItem(session: SessionRecord, latest: CampaignDraft | null, versionCount: number): SessionListItem {
  return {
    id: session.id,
    title: session.title,
    status: latest ? deriveStatus(latest, validateDraft(latest, buildIcsDrafts(latest))) : session.status,
    noIcs: latest ? noIcsOrders(latest) : false,
    updatedAt: session.updatedAt,
    versionCount,
  };
}

type SessionRow = { id: string; title: string; entry_mode: string; status: string; created_at: string; updated_at: string };

export function createD1Store(db: D1Database): SessionStore {
  return {
    async list() {
      const result = await db.prepare(`SELECT s.*,
          (SELECT COUNT(*) FROM draft_version v WHERE v.session_id = s.id) AS version_count,
          (SELECT v.brief_json FROM draft_version v WHERE v.session_id = s.id ORDER BY v.seq DESC LIMIT 1) AS latest_json
        FROM session s ORDER BY s.updated_at DESC LIMIT 30`).all<SessionRow & { version_count: number; latest_json: string | null }>();
      return result.results.map((row) => {
        let latest: CampaignDraft | null = null;
        try {
          latest = row.latest_json ? (JSON.parse(row.latest_json) as CampaignDraft) : null;
        } catch {
          latest = null;
        }
        return listItem(
          { id: row.id, title: row.title, entryMode: row.entry_mode, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at },
          latest,
          Number(row.version_count),
        );
      });
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
      return {
        session: { id: row.id, title: row.title, entryMode: row.entry_mode, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at },
        messages: messages.results.map((message) => ({
          id: message.id,
          role: message.role === "user" ? "user" : "assistant",
          createdAt: message.created_at,
          content: decodeMessage(message.role, message.content),
          producedVersionId: message.produced_version_id,
        })),
        versions: versions.results.map((version) => ({
          id: version.id,
          seq: Number(version.seq),
          draft: JSON.parse(version.brief_json) as CampaignDraft,
          orders: JSON.parse(version.ics_orders_json) as IcsOrderDraft[],
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
        if (version.patch) {
          statements.push(db.prepare("INSERT INTO patch (id, session_id, from_version, ops_json, source, reason, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(version.patch.id, session.id, version.seq - 1, JSON.stringify(version.patch.ops), version.patch.source, version.patch.reason, version.patch.source === "ai" ? "deepseek-flash" : null, null, now));
        }
        statements.push(db.prepare("INSERT INTO draft_version (id, session_id, seq, brief_json, ics_orders_json, created_by, patch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(version.id, session.id, version.seq, JSON.stringify(version.draft), JSON.stringify(version.orders), version.createdBy, version.patch?.id ?? null, now));
      }
      for (const message of write.messages) {
        statements.push(db.prepare("INSERT INTO message (id, session_id, role, content, created_at, produced_version_id) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(message.id, session.id, message.role, encodeMessage(message.content), now, message.producedVersionId));
      }
      try {
        await db.batch(statements);
      } catch (error) {
        if (String(error instanceof Error ? error.message : error).includes("UNIQUE")) throw new ConflictError("页面已更新，请重试");
        throw error;
      }
    },
  };
}

export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, SessionBundle>();
  return {
    async list() {
      return [...sessions.values()]
        .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))
        .map((bundle) => listItem(bundle.session, bundle.versions.at(-1)?.draft ?? null, bundle.versions.length));
    },
    async load(id) {
      const bundle = sessions.get(id);
      return bundle ? structuredClone(bundle) : null;
    },
    async commit(write) {
      const existing = sessions.get(write.session.id);
      if (write.isNew && existing) throw new ConflictError("会话已存在");
      if (!write.isNew && !existing) throw new Error("会话不存在");
      if (write.version && existing?.versions.some((version) => version.seq === write.version!.seq)) throw new ConflictError("页面已更新，请重试");
      const bundle: SessionBundle = existing ? structuredClone(existing) : { session: write.session, messages: [], versions: [] };
      bundle.session = { ...write.session };
      if (write.version) {
        const { patch: _patch, ...version } = write.version;
        void _patch;
        bundle.versions.push(structuredClone({ ...version, createdAt: write.now }));
      }
      for (const message of write.messages) {
        bundle.messages.push(structuredClone({ ...message, createdAt: write.now }));
      }
      sessions.set(write.session.id, bundle);
    },
  };
}
