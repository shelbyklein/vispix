import { pgTable, integer, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

// Cooldown state for automated org-admin incident alerts: one row per
// (org, alert kind) recording when that alert was last emailed, so a
// recurring condition (e.g. provider quota exhausted, detected every
// scheduler tick) notifies the org's admins once per cooldown window
// instead of on every occurrence. Survives restarts/deploys by design.
export const organizationAlertsTable = pgTable("organization_alerts", {
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  // e.g. "ai_provider_quota"
  kind: text("kind").notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.kind] }),
]);

export type OrganizationAlert = typeof organizationAlertsTable.$inferSelect;
