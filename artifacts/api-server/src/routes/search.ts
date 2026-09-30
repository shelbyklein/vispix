import { Router, type IRouter, type Response } from "express";
import { and, avg, desc, eq, ilike, inArray, isNotNull, or } from "drizzle-orm";
import {
  db,
  albumsTable,
  photosTable,
  ratingsTable,
  usersTable,
  tagsTable,
  collectionTagsTable,
  photoCollectionsTable,
  aiAnalysisEventsTable,
  photoAttributionTagsTable,
} from "@workspace/db";
import { SearchPhotosPagedResponse, SemanticSearchPhotosResponse, RetrievePhotosResponse } from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse } from "../lib/photoHelpers";
import { parseSearchFilters, takenAtRange } from "../lib/searchFilters";
import { retrievePhotos, RetrievalError, MAX_PAGE_SIZE } from "../lib/photoRetrieval";

const router: IRouter = Router();

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
    // Same whole-day, inclusive-end semantics as search (#205).
    const dateFiltered = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(and(eq(photosTable.organizationId, organizationId), ...takenAtRange(filters.dateFrom, filters.dateTo)));
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

// Photo search routes are adapters over the shared retrieval service (#213,
// docs/PHOTO_RETRIEVAL.md): /search (keyword, offset pages) and
// /search/semantic (concept, topK array) keep their response shapes;
// /search/photos exposes the full contract.

function retrievalErrorStatus(err: unknown): number | null {
  if (!(err instanceof RetrievalError)) return null;
  return err.code === "search_timeout" ? 503 : err.code === "invalid_scope" ? 500 : 400;
}

/** Aborts the provider call when the client goes away before we answer. */
function abortOnClientClose(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

function intParam(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isInteger(n) ? n : fallback;
}

router.get("/search", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json(SearchPhotosPagedResponse.parse({ photos: [], hasMore: false }));
    return;
  }
  const parsed = parseSearchFilters(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { includeHidden, exclude, ...filters } = parsed.filters;
  try {
    const result = await retrievePhotos({
      organizationId: req.org!.id,
      canSeeHidden: req.dbUser!.role === "admin" && includeHidden,
      mode: "keyword",
      text: q,
      exclude,
      filters,
      limit: Math.min(Math.max(intParam(req.query.limit, 48), 1), 200),
      offset: Math.max(intParam(req.query.offset, 0), 0),
    });
    const photos = await buildPhotosResponse(result.items.map((i) => i.photoId), req.org!.id, req.dbUser?.id);
    res.json(SearchPhotosPagedResponse.parse({ photos, hasMore: result.page.nextCursor != null }));
  } catch (err) {
    const status = retrievalErrorStatus(err);
    if (status == null) throw err;
    res.status(status).json({ error: (err as RetrievalError).message, code: (err as RetrievalError).code });
  }
});

router.get("/search/semantic", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json(SemanticSearchPhotosResponse.parse([]));
    return;
  }
  const parsed = parseSearchFilters(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { includeHidden, exclude, ...filters } = parsed.filters;
  const topKRaw = intParam(req.query.topK, 30);
  try {
    const result = await retrievePhotos({
      organizationId: req.org!.id,
      canSeeHidden: req.dbUser!.role === "admin" && includeHidden,
      mode: "concept",
      text: q,
      exclude,
      filters,
      limit: topKRaw > 0 ? Math.min(topKRaw, 100) : 30,
      signal: abortOnClientClose(res),
    });
    // The array response can't carry states; headers say when nothing was
    // ranked because the embedding provider was unavailable.
    res.setHeader("X-Search-Status", result.status);
    if (result.degraded) res.setHeader("X-Search-Degraded", `${result.degraded.affects}:${result.degraded.reason}`);
    const photos = await buildPhotosResponse(result.items.map((i) => i.photoId), req.org!.id, req.dbUser?.id);
    res.json(SemanticSearchPhotosResponse.parse(photos));
  } catch (err) {
    const status = retrievalErrorStatus(err);
    if (status == null) throw err;
    res.status(status).json({ error: (err as RetrievalError).message, code: (err as RetrievalError).code });
  }
});

router.get("/search/photos", requireOrgAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const mode = req.query.mode ?? "combined";
  if (mode !== "combined" && mode !== "concept" && mode !== "keyword") {
    res.status(400).json({ error: "mode must be combined, concept or keyword", code: "invalid_request" });
    return;
  }
  const parsed = parseSearchFilters(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error, code: "invalid_request" });
    return;
  }
  const { includeHidden, exclude, ...filters } = parsed.filters;
  try {
    const result = await retrievePhotos({
      organizationId: req.org!.id,
      canSeeHidden: req.dbUser!.role === "admin" && includeHidden,
      mode,
      text: q,
      exclude,
      filters,
      limit: Math.min(Math.max(intParam(req.query.limit, 30), 1), MAX_PAGE_SIZE),
      cursor: typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null,
      signal: abortOnClientClose(res),
    });
    const photos = await buildPhotosResponse(result.items.map((i) => i.photoId), req.org!.id, req.dbUser?.id);
    const byId = new Map(photos.flatMap((p) => (p ? [[p.id, p] as const] : [])));
    const { items, ...rest } = result;
    res.json(
      RetrievePhotosResponse.parse({
        ...rest,
        items: items.filter((i) => byId.has(i.photoId)).map((i) => ({ photo: byId.get(i.photoId), match: i.match })),
      }),
    );
  } catch (err) {
    const status = retrievalErrorStatus(err);
    if (status == null) throw err;
    res.status(status).json({ error: (err as RetrievalError).message, code: (err as RetrievalError).code });
  }
});

export { applyFiltersAndFetchIds };
export default router;
