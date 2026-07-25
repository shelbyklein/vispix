import { Router, type IRouter } from "express";
import { and, avg, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  db,
  albumsTable,
  photosTable,
  ratingsTable,
  usersTable,
  tagsTable,
  collectionTagsTable,
  photoCollectionsTable,
  photoEmbeddingsTable,
  photoAiEvaluationsTable,
  aiAnalysisEventsTable,
  photoAttributionTagsTable,
} from "@workspace/db";
import { SearchPhotosPagedResponse, SemanticSearchPhotosResponse } from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse } from "../lib/photoHelpers";
import { embedText } from "../lib/aiEmbedding";
import { withIterativeVectorScan } from "../lib/vectorSearch";

const router: IRouter = Router();

// How hard an excluded concept pushes the semantic query vector away from it.
const NEGATIVE_LAMBDA = 0.75;

// AI criteria evaluation (#181) as a search signal. In semantic search the
// final rank blends embedding similarity with the photo's overall AI score:
// final = similarity * (1 - W) + (score / 10) * W. Small on purpose — relevance
// still dominates; the score breaks ties between similar matches. Photos not
// yet evaluated get a neutral 5/10 so the progressive backfill doesn't bury them.
const SEMANTIC_QUALITY_WEIGHT = 0.15;
const NEUTRAL_QUALITY_SCORE = 5;

// Parse an optional ?minQuality= (0–10) — photos below the AI overall score are
// dropped; photos without an evaluation are dropped too when the filter is set.
function parseMinQuality(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(10, Math.max(0, n));
}

// Parse repeated `?exclude=` query params (or a single one) into trimmed terms.
function parseExcludeTerms(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return arr.map((t) => String(t).trim()).filter((t) => t.length > 0);
}

function normalizeVec(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

interface PhotoFilterOptions {
  search?: string;
  tag?: string;
  categoryId?: number;
  ratingMin?: number;
  ratingMax?: number;
  dateFrom?: string;
  dateTo?: string;
  uploaderId?: number;
  albumId?: number;
  aiStatus?: "has_description" | "failed" | "not_analysed";
  inCollection?: boolean;
  hasRating?: boolean;
  attributionTagId?: number;
  hasAttribution?: boolean;
}

async function applyFiltersAndFetchIds(
  baseIds: number[],
  filters: PhotoFilterOptions,
  // Tenant scope (#113). This function only ever *intersects* baseIds, so an
  // org-scoped baseIds already guarantees isolation; org-scoping the internal
  // scans keeps pagination counts accurate and adds defense-in-depth.
  organizationId: number,
): Promise<number[]> {
  let ids = baseIds;

  const trimmedSearch = filters.search?.trim();
  if (trimmedSearch) {
    const pattern = `%${trimmedSearch}%`;
    const words = trimmedSearch.split(/\s+/).filter(Boolean);
    const orgScope = eq(photosTable.organizationId, organizationId);
    const [byAlbumTitle, byUploader, byAiDescription] = await Promise.all([
      db
        .select({ id: photosTable.id })
        .from(photosTable)
        .innerJoin(albumsTable, eq(photosTable.albumId, albumsTable.id))
        .where(and(ilike(albumsTable.title, pattern), orgScope)),
      db
        .select({ id: photosTable.id })
        .from(photosTable)
        .innerJoin(usersTable, eq(photosTable.uploaderId, usersTable.id))
        .where(and(ilike(usersTable.name, pattern), orgScope)),
      db.select({ id: photosTable.id }).from(photosTable).where(
        and(or(...words.map((word) => ilike(photosTable.aiDescription, `%${word}%`))), orgScope)
      ),
    ]);
    const searchIds = new Set([
      ...byAlbumTitle.map((r) => r.id),
      ...byUploader.map((r) => r.id),
      ...byAiDescription.map((r) => r.id),
    ]);
    ids = ids.filter((id) => searchIds.has(id));
  }

  if (filters.tag) {
    const tagName = filters.tag.trim().toLowerCase();
    const [tagRow] = await db.select({ id: tagsTable.id }).from(tagsTable).where(eq(tagsTable.name, tagName));
    if (!tagRow) {
      return [];
    }
    const collectionsWithTag = await db
      .select({ collectionId: collectionTagsTable.collectionId })
      .from(collectionTagsTable)
      .where(eq(collectionTagsTable.tagId, tagRow.id));
    const collectionIds = collectionsWithTag.map((r) => r.collectionId);
    if (collectionIds.length === 0) {
      return [];
    }
    const photosInCollections = await db
      .select({ photoId: photoCollectionsTable.photoId })
      .from(photoCollectionsTable)
      .where(inArray(photoCollectionsTable.collectionId, collectionIds));
    const tagPhotoIds = new Set(photosInCollections.map((r) => r.photoId));
    ids = ids.filter((id) => tagPhotoIds.has(id));
  }

  if (filters.attributionTagId != null) {
    const rows = await db
      .select({ photoId: photoAttributionTagsTable.photoId })
      .from(photoAttributionTagsTable)
      .where(eq(photoAttributionTagsTable.tagId, filters.attributionTagId));
    const tagged = new Set(rows.map((r) => r.photoId));
    ids = ids.filter((id) => tagged.has(id));
  } else if (filters.hasAttribution != null) {
    const rows = await db
      .selectDistinct({ photoId: photoAttributionTagsTable.photoId })
      .from(photoAttributionTagsTable);
    const tagged = new Set(rows.map((r) => r.photoId));
    ids = ids.filter((id) => (filters.hasAttribution ? tagged.has(id) : !tagged.has(id)));
  }

  if (filters.dateFrom || filters.dateTo) {
    const conditions = [];
    if (filters.dateFrom) conditions.push(gte(photosTable.takenAt, new Date(filters.dateFrom)));
    if (filters.dateTo) conditions.push(lte(photosTable.takenAt, new Date(filters.dateTo)));
    const dateFiltered = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(and(...conditions));
    const dateIds = new Set(dateFiltered.map((r) => r.id));
    ids = ids.filter((id) => dateIds.has(id));
  }

  if (filters.uploaderId) {
    const uploaderFiltered = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(eq(photosTable.uploaderId, filters.uploaderId));
    const uploaderIds = new Set(uploaderFiltered.map((r) => r.id));
    ids = ids.filter((id) => uploaderIds.has(id));
  }

  if (filters.albumId != null) {
    const albumFiltered = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(eq(photosTable.albumId, filters.albumId));
    const albumPhotoIds = new Set(albumFiltered.map((r) => r.id));
    ids = ids.filter((id) => albumPhotoIds.has(id));
  }

  if (filters.ratingMin != null || filters.ratingMax != null) {
    const rated = await db
      .select({ photoId: ratingsTable.photoId, avg: avg(ratingsTable.score) })
      .from(ratingsTable)
      .groupBy(ratingsTable.photoId);
    const ratingMap = new Map(rated.map((r) => [r.photoId, parseFloat(String(r.avg ?? 0))]));
    ids = ids.filter((id) => {
      const r = ratingMap.get(id) ?? 0;
      if (filters.ratingMin != null && r < filters.ratingMin) return false;
      if (filters.ratingMax != null && r > filters.ratingMax) return false;
      return true;
    });
  }

  if (filters.aiStatus) {
    if (filters.aiStatus === "has_description") {
      const rows = await db
        .select({ id: photosTable.id })
        .from(photosTable)
        .where(isNotNull(photosTable.aiDescription));
      const aiIds = new Set(rows.map((r) => r.id));
      ids = ids.filter((id) => aiIds.has(id));
    } else if (filters.aiStatus === "not_analysed") {
      const withEvents = await db
        .selectDistinct({ photoId: aiAnalysisEventsTable.photoId })
        .from(aiAnalysisEventsTable);
      const withEventIds = new Set(withEvents.map((r) => r.photoId).filter((id): id is number => id != null));
      ids = ids.filter((id) => !withEventIds.has(id));
    } else if (filters.aiStatus === "failed") {
      const allEvents = await db
        .select({
          photoId: aiAnalysisEventsTable.photoId,
          status: aiAnalysisEventsTable.status,
        })
        .from(aiAnalysisEventsTable)
        .orderBy(desc(aiAnalysisEventsTable.createdAt));
      const latestStatusMap = new Map<number, string>();
      for (const event of allEvents) {
        if (event.photoId != null && !latestStatusMap.has(event.photoId)) {
          latestStatusMap.set(event.photoId, event.status);
        }
      }
      ids = ids.filter((id) => latestStatusMap.get(id) === "failed");
    }
  }

  if (filters.inCollection != null) {
    const inCollectionRows = await db
      .selectDistinct({ photoId: photoCollectionsTable.photoId })
      .from(photoCollectionsTable);
    const collectionPhotoIds = new Set(
      inCollectionRows.map((r) => r.photoId).filter((id): id is number => id != null),
    );
    if (filters.inCollection) {
      ids = ids.filter((id) => collectionPhotoIds.has(id));
    } else {
      ids = ids.filter((id) => !collectionPhotoIds.has(id));
    }
  }

  if (filters.hasRating != null) {
    const ratedRows = await db
      .selectDistinct({ photoId: ratingsTable.photoId })
      .from(ratingsTable);
    const ratedIds = new Set(ratedRows.map((r) => r.photoId));
    if (filters.hasRating) {
      ids = ids.filter((id) => ratedIds.has(id));
    } else {
      ids = ids.filter((id) => !ratedIds.has(id));
    }
  }

  return ids;
}

router.get("/search", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json(SearchPhotosPagedResponse.parse({ photos: [], hasMore: false }));
    return;
  }

  const limitRaw = req.query.limit ? parseInt(String(req.query.limit), 10) : 48;
  const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : 48, 1), 200);
  const offsetRaw = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
  const offset = Math.max(Number.isInteger(offsetRaw) ? offsetRaw : 0, 0);

  const ratingMin = req.query.ratingMin ? parseFloat(String(req.query.ratingMin)) : undefined;
  const ratingMax = req.query.ratingMax ? parseFloat(String(req.query.ratingMax)) : undefined;
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : undefined;
  const uploaderId = req.query.uploaderId ? parseInt(String(req.query.uploaderId), 10) : undefined;
  const minQuality = parseMinQuality(req.query.minQuality);
  const includeHidden = req.query.includeHidden === "true";
  const canSeeHidden = req.dbUser!.role === "admin" && includeHidden;

  const pattern = `%${q}%`;

  const orgScope = eq(photosTable.organizationId, req.org!.id);
  const hiddenCondition = canSeeHidden ? undefined : eq(photosTable.isHidden, false);

  const [byAlbumTitle, byUploader, byAiDescription] = await Promise.all([
    db
      .select({ id: photosTable.id })
      .from(photosTable)
      .innerJoin(albumsTable, eq(photosTable.albumId, albumsTable.id))
      .where(and(ilike(albumsTable.title, pattern), orgScope, hiddenCondition)),
    db
      .select({ id: photosTable.id })
      .from(photosTable)
      .innerJoin(usersTable, eq(photosTable.uploaderId, usersTable.id))
      .where(and(ilike(usersTable.name, pattern), orgScope, hiddenCondition)),
    db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(and(ilike(photosTable.aiDescription, pattern), orgScope, hiddenCondition)),
  ]);

  const uniqueIds = [
    ...new Set([
      ...byAlbumTitle.map((r) => r.id),
      ...byUploader.map((r) => r.id),
      ...byAiDescription.map((r) => r.id),
    ]),
  ];

  // Drop photos whose AI description matches any excluded term.
  const excludeTerms = parseExcludeTerms(req.query.exclude);
  let candidateIds = uniqueIds;
  if (excludeTerms.length > 0 && uniqueIds.length > 0) {
    const excludedRows = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(or(...excludeTerms.map((t) => ilike(photosTable.aiDescription, `%${t}%`))));
    const excludeSet = new Set(excludedRows.map((r) => r.id));
    candidateIds = uniqueIds.filter((id) => !excludeSet.has(id));
  }

  if (candidateIds.length === 0) {
    res.json(SearchPhotosPagedResponse.parse({ photos: [], hasMore: false }));
    return;
  }

  // The ILIKE union has no inherent order — impose a stable one so offset
  // pagination is consistent across pages: AI quality tier first (#181 — whole
  // scores so recency still matters within a tier; unevaluated photos sort as a
  // middle 5 so the progressive backfill doesn't bury them), then newest-first
  // with an id tiebreaker. An optional minQuality floor drops low scorers.
  const orderedRows = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .leftJoin(photoAiEvaluationsTable, eq(photoAiEvaluationsTable.photoId, photosTable.id))
    .where(
      and(
        inArray(photosTable.id, candidateIds),
        minQuality != null ? gte(photoAiEvaluationsTable.overallScore, minQuality) : undefined,
      ),
    )
    .orderBy(
      sql`round(coalesce(${photoAiEvaluationsTable.overallScore}, ${NEUTRAL_QUALITY_SCORE})) DESC`,
      desc(photosTable.createdAt),
      desc(photosTable.id),
    );

  const filtered = await applyFiltersAndFetchIds(orderedRows.map((r) => r.id), {
    ratingMin,
    ratingMax,
    dateFrom,
    dateTo,
    uploaderId,
  }, req.org!.id);

  const pageIds = filtered.slice(offset, offset + limit);
  const hasMore = filtered.length > offset + limit;

  const photos = await buildPhotosResponse(pageIds, req.org!.id, req.dbUser?.id);
  res.json(SearchPhotosPagedResponse.parse({ photos, hasMore }));
});

router.get("/search/semantic", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json(SemanticSearchPhotosResponse.parse([]));
    return;
  }

  const topKRaw = req.query.topK ? parseInt(String(req.query.topK), 10) : 30;
  const topK = Number.isInteger(topKRaw) && topKRaw > 0 ? Math.min(topKRaw, 100) : 30;
  const minQuality = parseMinQuality(req.query.minQuality);
  const includeHidden = req.query.includeHidden === "true";
  const canSeeHidden = req.dbUser!.role === "admin" && includeHidden;

  // Embed the query into the same space as the image embeddings. Returns null
  // when embeddings aren't enabled/configured — degrade to no results.
  const posVec = await embedText(q);
  if (!posVec) {
    res.json(SemanticSearchPhotosResponse.parse([]));
    return;
  }

  // Steer the query away from excluded concepts: query = norm(pos) - λ·norm(neg).
  let queryVec = posVec;
  const excludeTerms = parseExcludeTerms(req.query.exclude);
  if (excludeTerms.length > 0) {
    const negVec = await embedText(excludeTerms.join(", "));
    if (negVec) {
      const p = normalizeVec(posVec);
      const n = normalizeVec(negVec);
      queryVec = p.map((x, i) => x - NEGATIVE_LAMBDA * n[i]);
    }
  }
  const vecLiteral = `[${queryVec.join(",")}]`;

  // Nearest neighbours by cosine distance (matches the HNSW vector_cosine_ops
  // index). Join photos to respect hidden visibility, and the AI evaluation
  // (#181) for the quality blend — over-fetch so re-ranking has candidates
  // beyond the raw topK to promote from.
  const fetchK = Math.min(topK * 2, 200);
  const rows = await withIterativeVectorScan((tx) =>
    tx
      .select({
        id: photoEmbeddingsTable.photoId,
        similarity: sql<number>`1 - (${photoEmbeddingsTable.embedding} <=> ${vecLiteral}::vector)`,
        aiScore: photoAiEvaluationsTable.overallScore,
      })
      .from(photoEmbeddingsTable)
      .innerJoin(photosTable, eq(photosTable.id, photoEmbeddingsTable.photoId))
      .leftJoin(photoAiEvaluationsTable, eq(photoAiEvaluationsTable.photoId, photoEmbeddingsTable.photoId))
      .where(
        and(
          eq(photosTable.organizationId, req.org!.id),
          canSeeHidden ? undefined : eq(photosTable.isHidden, false),
          minQuality != null ? gte(photoAiEvaluationsTable.overallScore, minQuality) : undefined,
        ),
      )
      .orderBy(sql`${photoEmbeddingsTable.embedding} <=> ${vecLiteral}::vector`)
      .limit(fetchK),
  );

  // Blend similarity with the AI quality score (#181), re-rank, keep topK.
  const ranked = rows
    .map((r) => ({
      id: r.id,
      final:
        Number(r.similarity) * (1 - SEMANTIC_QUALITY_WEIGHT) +
        ((r.aiScore ?? NEUTRAL_QUALITY_SCORE) / 10) * SEMANTIC_QUALITY_WEIGHT,
    }))
    .sort((a, b) => b.final - a.final)
    .slice(0, topK);

  // buildPhotosResponse preserves input id order → results stay ranked.
  const photos = await buildPhotosResponse(ranked.map((r) => r.id), req.org!.id, req.dbUser?.id);
  res.json(SemanticSearchPhotosResponse.parse(photos));
});

export { applyFiltersAndFetchIds };
export default router;
