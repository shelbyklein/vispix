import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Platform-wide saved color palettes (#257), managed by superadmins in the
// palette tool. swatches is string[] of "#RRGGBB"; roles is a RoleAssignment.
export const designPalettesTable = pgTable("design_palettes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  swatches: jsonb("swatches").$type<string[]>().notNull(),
  roles: jsonb("roles").$type<Record<string, string>>().notNull().default({}),
  harmony: text("harmony"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DesignPalette = typeof designPalettesTable.$inferSelect;
