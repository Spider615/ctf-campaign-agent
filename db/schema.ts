import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    entryMode: text("entry_mode").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_session_updated_at").on(table.updatedAt)],
);

export const messages = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
    producedVersionId: text("produced_version_id"),
  },
  (table) => [index("idx_message_session_created").on(table.sessionId, table.createdAt)],
);

export const draftVersions = sqliteTable(
  "draft_version",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    briefJson: text("brief_json").notNull(),
    icsOrdersJson: text("ics_orders_json").notNull(),
    createdBy: text("created_by").notNull(),
    patchId: text("patch_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_version_session_seq").on(table.sessionId, table.seq),
    index("idx_version_session_created").on(table.sessionId, table.createdAt),
  ],
);

export const patches = sqliteTable(
  "patch",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    fromVersion: integer("from_version").notNull(),
    opsJson: text("ops_json").notNull(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    model: text("model"),
    tokens: integer("tokens"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_patch_session_created").on(table.sessionId, table.createdAt)],
);

export const storeConstants = sqliteTable(
  "store_constant",
  {
    storeCode: text("store_code").notNull(),
    businessCategory: text("business_category").notNull(),
    concessionRate: integer("concession_rate").notNull(),
    collectionRate: integer("collection_rate").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.storeCode, table.businessCategory] })],
);

export const codeTable = sqliteTable(
  "codetable",
  {
    fieldKey: text("field_key").notNull(),
    value: text("value").notNull(),
    label: text("label").notNull(),
    vintageYear: integer("vintage_year").notNull(),
    sourceImage: text("source_image").notNull(),
    completeness: text("completeness").notNull(),
  },
  (table) => [primaryKey({ columns: [table.fieldKey, table.value] })],
);
