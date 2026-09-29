import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";
import { imageGenerationSessionsTable } from "./imageGeneration";

// Campaigns (#192): a plain-text brief describing an upcoming marketing need
// (event, dates, location, imagery notes) that drives AI ad suggestions. Each
// campaign owns one image-generation session (created lazily on first
// generate); its suggestions are that session's generations, so lineage,
// polling and downloads reuse the #167 machinery unchanged.
export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  createdById: integer("created_by")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // The instructions an agent works from — freeform text/markdown.
  brief: text("brief").notNull(),
  // Bumped on every brief change (#216): a client sends the revision it edited
  // so another tab's newer brief is never silently overwritten or generated
  // from, and each suggestion records the revision it was generated from.
  briefRevision: integer("brief_revision").notNull().default(1),
  // The last generate request accepted for this campaign (#216), so a repeated
  // click or retry of the same request doesn't start duplicate generation.
  lastGenerateRequestId: text("last_generate_request_id"),
  // The campaign's generation session; null until the first Generate.
  sessionId: integer("session_id").references(() => imageGenerationSessionsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("campaigns_org_idx").on(table.organizationId, table.updatedAt),
]);

export type Campaign = typeof campaignsTable.$inferSelect;
