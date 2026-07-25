import { pgTable, integer, smallint, real, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { photosTable } from "./photos";
import { organizationsTable } from "./organizations";

// AI criteria evaluation of a photo (#181): alongside the free-text
// aiDescription, the same analysis call scores the photo on a fixed set of
// criteria (0–10 each). The scores feed search ranking/filters, so they live in
// their own 1:1 table — re-evaluation stays a cheap upsert here and the hot
// photos row stays narrow.
export const photoAiEvaluationsTable = pgTable("photo_ai_evaluations", {
  photoId: integer("photo_id")
    .primaryKey()
    .references(() => photosTable.id, { onDelete: "cascade" }),
  // Denormalized tenant owner (#113) — search ranking joins this table
  // directly, so it needs the org here too.
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Criteria scores, 0–10 (see aiPhotoAnalysis.ts for the rubric prompt).
  technicalQuality: smallint("technical_quality").notNull(),
  composition: smallint("composition").notNull(),
  subjectClarity: smallint("subject_clarity").notNull(),
  emotionalImpact: smallint("emotional_impact").notNull(),
  marketingUsability: smallint("marketing_usability").notNull(),
  // Weighted mean of the criteria (weights live in app config so they can be
  // tuned without re-analysis; this stored value is refreshed on re-analysis).
  overallScore: real("overall_score").notNull(),
  // Detected flaws, e.g. ["motion blur", "closed eyes"]. Empty array = clean.
  flaws: jsonb("flaws").$type<string[]>().notNull().default([]),
  // Which crops/uses the framing suits, e.g. "wide banner; square social crop".
  orientationSuitability: text("orientation_suitability"),
  // Provenance: which provider/model produced these scores.
  provider: text("provider"),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Search ranking filters/sorts by score within an org.
  index("photo_ai_eval_org_score_idx").on(table.organizationId, table.overallScore),
]);

export type PhotoAiEvaluation = typeof photoAiEvaluationsTable.$inferSelect;
