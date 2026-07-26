import { pgTable, serial, integer, text, jsonb, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

// AI image generation (#167): a Create-workspace conversation and its outputs.
// Every generated image is fully traceable — prompt, attached inputs with their
// roles, a snapshot of the usage notes that applied, the OpenAI response id
// (needed to continue multi-turn edits), and revision lineage via
// parentGenerationId.

export const imageGenerationSessionsTable = pgTable("image_generation_sessions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  // First prompt, truncated — shown in the session list.
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("image_gen_sessions_org_idx").on(table.organizationId, table.updatedAt),
]);

// One attached input on a generation: an uploaded reference, a library photo,
// or a brand/reference asset, each with an assigned role (#167 §2).
export interface GenerationInput {
  kind: "upload" | "photo" | "asset";
  /** photo/asset id for library inputs; null for uploads. */
  refId: number | null;
  /** /objects/… key of the image bytes used. */
  storageKey: string;
  role: "style" | "hero_photo" | "exact_asset";
  /** Display name (filename / asset name) for the conversation UI. */
  name: string | null;
}

export const imageGenerationsTable = pgTable("image_generations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => imageGenerationSessionsTable.id, { onDelete: "cascade" }),
  // Revision lineage: set when this generation revises an earlier output.
  parentGenerationId: integer("parent_generation_id").references((): AnyPgColumn => imageGenerationsTable.id, {
    onDelete: "set null",
  }),
  prompt: text("prompt").notNull(),
  // OpenAI Responses API id — continuing an edit passes it as
  // previous_response_id so the model keeps the image context.
  openaiResponseId: text("openai_response_id"),
  // { format, size, quality, variantIndex, variantCount, imageModel }
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  inputs: jsonb("inputs").$type<GenerationInput[]>().notNull().default([]),
  // Usage notes that applied at generation time (photo rights tags, asset
  // notes), frozen so the output stays auditable even if notes change later.
  usageNotesSnapshot: jsonb("usage_notes_snapshot").$type<string[]>().notNull().default([]),
  // /objects/orgs/<org>/generated/<uuid> once stored; null while pending/failed.
  storageKey: text("storage_key"),
  contentType: text("content_type"),
  width: integer("width"),
  height: integer("height"),
  status: text("status").notNull().default("pending"), // pending | succeeded | failed
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("image_generations_session_idx").on(table.sessionId, table.createdAt),
  index("image_generations_org_idx").on(table.organizationId),
]);

export type ImageGenerationSession = typeof imageGenerationSessionsTable.$inferSelect;
export type ImageGeneration = typeof imageGenerationsTable.$inferSelect;
