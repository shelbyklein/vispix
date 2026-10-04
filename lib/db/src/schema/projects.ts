import { pgTable, text, serial, timestamp, integer, primaryKey, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { photosTable } from "./photos";
import { organizationsTable } from "./organizations";
import type { UsageRightsSnapshot } from "./attributionTags";

// A Project is a user-curated bucket of photos gathered for use in an actual
// deliverable — distinct from Albums (storage/ownership) and Smart Collections
// (keyword-driven auto-groupings). A photo can belong to any number of projects
// regardless of its album.
export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  // Tenant owner (issue #113). Nullable in Phase 1 (backfilled), NOT NULL in P2.
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdById: integer("created_by").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Manual card position on the Projects page (drag-to-reorder). Null = never
  // placed; lists sort sort_order ASC nulls-last, then updated_at desc.
  sortOrder: integer("sort_order"),
});

export const projectPhotosTable = pgTable(
  "project_photos",
  {
    projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
    photoId: integer("photo_id").notNull().references(() => photosTable.id, { onDelete: "cascade" }),
    // Ordering within a project is by date added (v1 has no manual reorder).
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    // Usage rights when the photo was shortlisted (#207), so export can report
    // changes since. Null for photos added before this was recorded.
    rightsSnapshot: jsonb("rights_snapshot").$type<UsageRightsSnapshot>(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.photoId] }),
    // Project detail listing: WHERE project_id = ? ORDER BY added_at ASC.
    index("project_photos_project_added_idx").on(table.projectId, table.addedAt),
  ],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
export type ProjectPhoto = typeof projectPhotosTable.$inferSelect;
