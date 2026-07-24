import { pgTable, pgEnum, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { projectsTable } from "./projects";
import { organizationsTable } from "./organizations";

// The asset library holds non-photo files agents and humans pull into
// deliverables: kind='brand' is logos/marks (the thing you embed in the
// output), kind='reference' is past works (the thing you look at to match
// style). Assets deliberately skip the photo pipeline — no thumbnails, no AI
// analysis, no embeddings — retrieval is by kind/name/variant/project.
export const assetKindEnum = pgEnum("asset_kind", ["brand", "reference"]);

export const assetsTable = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    // Tenant owner (issue #113). Nullable in Phase 1 (backfilled), NOT NULL in P2.
    organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
    kind: assetKindEnum("kind").notNull(),
    name: text("name").notNull(),
    // Distinguishes versions of the same mark: "primary", "white", "icon-only"
    // for brand assets; free-form ("poster", "social") for references.
    variant: text("variant"),
    notes: text("notes"),
    // Optional organizational label grouping assets in the library (#159), same
    // free-text role folders play for albums (#149). Distinct from kind/variant;
    // null = ungrouped.
    folder: text("folder"),
    // Null = org-wide/global asset, served for every project.
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "set null" }),
    // "/objects/…" path in private object storage (same convention as photos).
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    filename: text("filename"),
    fileSize: integer("file_size"),
    createdById: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "Assets for this project" is the MCP hot path.
    index("assets_project_idx").on(table.projectId),
  ],
);

export type Asset = typeof assetsTable.$inferSelect;
export type InsertAsset = typeof assetsTable.$inferInsert;
