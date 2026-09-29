import { eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import { photosTable, ratingsTable, photoAiEvaluationsTable } from "@workspace/db";

// One filter contract for photo search (#205). Keyword search, semantic search
// and the Photos page all parse filters here and apply the same SQL predicates
// inside their database query — before pagination / topK — so a filter shown
// as active is actually enforced in every mode.
//
//   dateFrom / dateTo  YYYY-MM-DD, whole calendar days, dateTo inclusive.
//                      Capture times are stored as camera wall-clock in UTC
//                      (EXIF has no zone; see exifDateExtraction), so a photo's
//                      calendar day is its UTC date: no browser/org timezone
//                      shift. Undated photos are excluded when a bound is set.
//   ratingMin/Max      average user rating 0–5; unrated counts as 0.
//   minQuality         AI overall score 0–10; unevaluated photos excluded.
//   uploaderId         exact uploader.
//   includeHidden      honoured for admins only.
//   exclude            keyword: hard removal by AI description; semantic: a
//                      ranking preference (the route steers the query vector),
//                      not guaranteed absence.

export interface SearchFilters {
  ratingMin?: number;
  ratingMax?: number;
  minQuality?: number;
  dateFrom?: string;
  dateTo?: string;
  uploaderId?: number;
  includeHidden: boolean;
  exclude: string[];
}

export type ParsedSearchFilters = { ok: true; filters: SearchFilters } | { ok: false; error: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isCalendarDate(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function oneString(raw: unknown): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function numberIn(raw: unknown, name: string, min: number, max: number): number | undefined | { error: string } {
  const v = oneString(raw);
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return { error: `${name} must be a number from ${min} to ${max}` };
  return n;
}

/** Parse and validate search filters from a request's query string. */
export function parseSearchFilters(query: Record<string, unknown>): ParsedSearchFilters {
  const ratingMin = numberIn(query.ratingMin, "ratingMin", 0, 5);
  const ratingMax = numberIn(query.ratingMax, "ratingMax", 0, 5);
  for (const r of [ratingMin, ratingMax]) if (typeof r === "object") return { ok: false, error: r.error };
  // minQuality keeps its historical clamp to 0–10 rather than rejecting.
  const q = oneString(query.minQuality);
  const qn = q != null ? Number(q) : undefined;
  const minQuality = qn != null && Number.isFinite(qn) ? Math.min(10, Math.max(0, qn)) : undefined;

  const dateFrom = oneString(query.dateFrom);
  const dateTo = oneString(query.dateTo);
  for (const [name, d] of [["dateFrom", dateFrom], ["dateTo", dateTo]] as const) {
    if (d != null && !isCalendarDate(d)) return { ok: false, error: `${name} must be a date in YYYY-MM-DD form` };
  }
  if (dateFrom && dateTo && dateFrom > dateTo) return { ok: false, error: "dateFrom must be on or before dateTo" };
  if (typeof ratingMin === "number" && typeof ratingMax === "number" && ratingMin > ratingMax) {
    return { ok: false, error: "ratingMin must be at most ratingMax" };
  }

  const u = oneString(query.uploaderId);
  let uploaderId: number | undefined;
  if (u != null) {
    uploaderId = Number(u);
    if (!Number.isSafeInteger(uploaderId) || uploaderId <= 0) return { ok: false, error: "uploaderId must be a positive integer" };
  }

  const rawExclude = Array.isArray(query.exclude) ? query.exclude : query.exclude != null ? [query.exclude] : [];
  const exclude = rawExclude.map((t) => String(t).trim()).filter((t) => t.length > 0);

  return {
    ok: true,
    filters: {
      ratingMin: ratingMin as number | undefined,
      ratingMax: ratingMax as number | undefined,
      minQuality,
      dateFrom,
      dateTo,
      uploaderId,
      includeHidden: oneString(query.includeHidden) === "true",
      exclude,
    },
  };
}

/**
 * Capture-date bounds. `YYYY-MM-DD` values are whole UTC days with an
 * inclusive `dateTo`; any other parseable value is treated as an exact instant
 * (kept for older callers of the Photos endpoint).
 */
export function takenAtRange(dateFrom?: string, dateTo?: string): SQL[] {
  const out: SQL[] = [];
  if (dateFrom) {
    out.push(gte(photosTable.takenAt, DATE_ONLY.test(dateFrom) ? new Date(`${dateFrom}T00:00:00.000Z`) : new Date(dateFrom)));
  }
  if (dateTo) {
    out.push(
      DATE_ONLY.test(dateTo)
        ? lt(photosTable.takenAt, new Date(new Date(`${dateTo}T00:00:00.000Z`).getTime() + DAY_MS))
        : lte(photosTable.takenAt, new Date(dateTo)),
    );
  }
  return out;
}

const averageRating = sql`coalesce((select avg(${ratingsTable.score}) from ${ratingsTable} where ${ratingsTable.photoId} = ${photosTable.id}), 0)`;

/**
 * SQL predicates on `photos` for every metadata filter plus tenant scope and
 * hidden visibility. Self-contained (subqueries, no joins required), so they
 * drop into any query that selects from or joins `photos`.
 */
export function photoFilterConditions(
  filters: SearchFilters,
  opts: { organizationId: number; canSeeHidden: boolean },
): SQL[] {
  const out: SQL[] = [eq(photosTable.organizationId, opts.organizationId)];
  if (!opts.canSeeHidden) out.push(eq(photosTable.isHidden, false));
  out.push(...takenAtRange(filters.dateFrom, filters.dateTo));
  if (filters.ratingMin != null) out.push(sql`${averageRating} >= ${filters.ratingMin}`);
  if (filters.ratingMax != null) out.push(sql`${averageRating} <= ${filters.ratingMax}`);
  if (filters.uploaderId != null) out.push(eq(photosTable.uploaderId, filters.uploaderId));
  if (filters.minQuality != null) {
    out.push(
      sql`exists (select 1 from ${photoAiEvaluationsTable} where ${photoAiEvaluationsTable.photoId} = ${photosTable.id} and ${photoAiEvaluationsTable.overallScore} >= ${filters.minQuality})`,
    );
  }
  return out;
}
