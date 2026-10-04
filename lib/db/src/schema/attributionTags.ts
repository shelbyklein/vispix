import { pgTable, serial, text, integer, timestamp, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { photosTable } from "./photos";
import { organizationsTable } from "./organizations";

// User-defined attribution / usage-rights tags: which kinds of use a photo is
// cleared for (e.g. "USA Archery", "World Archery", "Social"). Distinct from
// the descriptive collection tags in tags.ts — these carry rights semantics.
export const attributionTagsTable = pgTable(
  "attribution_tags",
  {
    id: serial("id").primaryKey(),
    // Tenant owner (issue #113).
    organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
    // Unique per organization (migration 0037), not globally: two orgs may
    // both have "Social". The API also refuses case variants within an org.
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("attribution_tags_org_name_unique").on(table.organizationId, table.name)],
);

export const photoAttributionTagsTable = pgTable("photo_attribution_tags", {
  photoId: integer("photo_id").notNull().references(() => photosTable.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").notNull().references(() => attributionTagsTable.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.photoId, table.tagId] }),
]);

export type AttributionTag = typeof attributionTagsTable.$inferSelect;

/**
 * Usage-rights state of one photo at a moment in time (#207). `not_recorded`
 * means unknown — nobody has recorded rights — never "no rights". A recorded
 * tag is the team's own record, not a legal clearance.
 */
export interface UsageRightsSnapshot {
  status: "recorded" | "not_recorded";
  tags: { id: number; name: string }[];
  checkedAt: string;
}
export type PhotoAttributionTag = typeof photoAttributionTagsTable.$inferSelect;
