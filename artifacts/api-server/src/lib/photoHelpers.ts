import { db, photosTable, ratingsTable, albumsTable, collectionsTable, photoCollectionsTable, photoCollectionSuggestionsTable, photoNewCollectionSuggestionsTable, usersTable, aiAnalysisEventsTable, photoAiEvaluationsTable, projectsTable, projectPhotosTable, attributionTagsTable, photoAttributionTagsTable, type PhotoAiEvaluation } from "@workspace/db";
import { eq, and, avg, count, desc, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

const objectStorageService = new ObjectStorageService();

export type AiStatusFilter = "has_description" | "failed" | "not_analysed";

// Criteria evaluation (#181) as exposed on photo responses.
function serializeAiEvaluation(row: PhotoAiEvaluation | undefined | null) {
  if (!row) return null;
  return {
    technicalQuality: row.technicalQuality,
    composition: row.composition,
    subjectClarity: row.subjectClarity,
    emotionalImpact: row.emotionalImpact,
    marketingUsability: row.marketingUsability,
    overallScore: row.overallScore,
    flaws: Array.isArray(row.flaws) ? row.flaws : [],
    orientationSuitability: row.orientationSuitability ?? null,
    evaluatedAt: row.evaluatedAt instanceof Date ? row.evaluatedAt.toISOString() : String(row.evaluatedAt),
  };
}

export interface AlbumPhotoPageOptions {
  // Tenant scope (issue #113): only photos in this org are returned, even if the
  // album id somehow belonged to another org. Defense-in-depth over the caller's
  // own album-org check.
  organizationId: number;
  canSeeHidden: boolean;
  inCollection?: boolean;
  hasRating?: boolean;
  aiStatus?: AiStatusFilter;
  // Filter by a specific attribution tag, or by having any/none at all.
  attributionTagId?: number;
  hasAttribution?: boolean;
  limit: number;
  offset: number;
}

/**
 * Fetch one page of an album's photo IDs, applying all filters and pagination
 * in SQL (no in-memory Set intersection or slice). Returns the page's IDs in
 * created_at DESC order plus whether more rows exist after this page. `hasMore`
 * is computed by fetching one extra row rather than a separate COUNT.
 */
export async function fetchAlbumPhotoPage(
  albumId: number,
  opts: AlbumPhotoPageOptions,
): Promise<{ ids: number[]; hasMore: boolean }> {
  const conditions: SQL[] = [
    eq(photosTable.albumId, albumId),
    eq(photosTable.organizationId, opts.organizationId),
  ];
  if (!opts.canSeeHidden) conditions.push(eq(photosTable.isHidden, false));

  if (opts.inCollection === true) {
    conditions.push(sql`EXISTS (SELECT 1 FROM photo_collections pc WHERE pc.photo_id = ${photosTable.id})`);
  } else if (opts.inCollection === false) {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM photo_collections pc WHERE pc.photo_id = ${photosTable.id})`);
  }

  if (opts.hasRating === true) {
    conditions.push(sql`EXISTS (SELECT 1 FROM ratings r WHERE r.photo_id = ${photosTable.id})`);
  } else if (opts.hasRating === false) {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM ratings r WHERE r.photo_id = ${photosTable.id})`);
  }

  if (opts.aiStatus === "has_description") {
    conditions.push(isNotNull(photosTable.aiDescription));
  } else if (opts.aiStatus === "not_analysed") {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM ai_analysis_events e WHERE e.photo_id = ${photosTable.id})`);
  } else if (opts.aiStatus === "failed") {
    conditions.push(
      sql`(SELECT e.status FROM ai_analysis_events e WHERE e.photo_id = ${photosTable.id} ORDER BY e.created_at DESC LIMIT 1) = 'failed'`,
    );
  }

  if (opts.attributionTagId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM photo_attribution_tags pat WHERE pat.photo_id = ${photosTable.id} AND pat.tag_id = ${opts.attributionTagId})`,
    );
  } else if (opts.hasAttribution === true) {
    conditions.push(sql`EXISTS (SELECT 1 FROM photo_attribution_tags pat WHERE pat.photo_id = ${photosTable.id})`);
  } else if (opts.hasAttribution === false) {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM photo_attribution_tags pat WHERE pat.photo_id = ${photosTable.id})`);
  }

  const rows = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(and(...conditions))
    .orderBy(desc(photosTable.createdAt))
    .limit(opts.limit + 1)
    .offset(opts.offset);

  const hasMore = rows.length > opts.limit;
  return { ids: rows.slice(0, opts.limit).map((r) => r.id), hasMore };
}

/**
 * Best-effort delete of a photo's original and thumbnail objects from storage.
 * Failures are logged, not thrown — the DB row is the source of truth and is
 * already gone by the time this runs.
 *
 * When PHOTO_STORAGE_DELETE_DISABLED=true, object deletion is skipped and only
 * logged. Used by the dev stack: it has its own database but shares the prod
 * storage bucket, so deleting a dev photo row must not remove image files the
 * prod rows still reference.
 */
export async function deletePhotoStorageObjects(photo: {
  id: number;
  storageKey: string | null;
  thumbnailKey: string | null;
}): Promise<void> {
  if (process.env.PHOTO_STORAGE_DELETE_DISABLED === "true") {
    logger.info({ photoId: photo.id }, "Storage delete skipped (PHOTO_STORAGE_DELETE_DISABLED)");
    return;
  }
  for (const key of [photo.storageKey, photo.thumbnailKey]) {
    if (!key) continue;
    try {
      await objectStorageService.deleteObjectEntity(key);
    } catch (err) {
      logger.error({ err, photoId: photo.id, key }, "Failed to delete photo storage object");
    }
  }
}

export async function buildPhotoResponse(photoId: number, orgId: number, currentUserId?: number) {
  const [photo] = await db
    .select({
      photo: photosTable,
      albumTitle: albumsTable.title,
    })
    .from(photosTable)
    .leftJoin(albumsTable, eq(photosTable.albumId, albumsTable.id))
    // Tenant scope (#113): a foreign-org photo id resolves to null (→ 404).
    .where(and(eq(photosTable.id, photoId), eq(photosTable.organizationId, orgId)));

  if (!photo) return null;

  const [photoCollections, photoProjects, photoAttributionTags, ratingDataArr, ratingsList, suggestedCollections, suggestedNewCollections, latestAiEvents, aiEvaluationRows] = await Promise.all([
    db
      .select({
        id: collectionsTable.id,
        title: collectionsTable.title,
        description: collectionsTable.description,
        createdById: collectionsTable.createdById,
        createdAt: collectionsTable.createdAt,
      })
      .from(collectionsTable)
      .innerJoin(photoCollectionsTable, eq(collectionsTable.id, photoCollectionsTable.collectionId))
      .where(eq(photoCollectionsTable.photoId, photoId)),
    db
      .select({ id: projectsTable.id, name: projectsTable.name })
      .from(projectsTable)
      .innerJoin(projectPhotosTable, eq(projectsTable.id, projectPhotosTable.projectId))
      .where(eq(projectPhotosTable.photoId, photoId)),
    db
      .select({ id: attributionTagsTable.id, name: attributionTagsTable.name })
      .from(attributionTagsTable)
      .innerJoin(photoAttributionTagsTable, eq(attributionTagsTable.id, photoAttributionTagsTable.tagId))
      .where(eq(photoAttributionTagsTable.photoId, photoId)),
    db
      .select({
        averageRating: avg(ratingsTable.score),
        ratingCount: count(ratingsTable.id),
      })
      .from(ratingsTable)
      .where(eq(ratingsTable.photoId, photoId)),
    db
      .select({
        userId: ratingsTable.userId,
        userName: usersTable.name,
        score: ratingsTable.score,
        createdAt: ratingsTable.createdAt,
      })
      .from(ratingsTable)
      .leftJoin(usersTable, eq(ratingsTable.userId, usersTable.id))
      .where(eq(ratingsTable.photoId, photoId))
      .orderBy(ratingsTable.createdAt),
    db
      .select({ id: collectionsTable.id, title: collectionsTable.title })
      .from(photoCollectionSuggestionsTable)
      .innerJoin(collectionsTable, eq(photoCollectionSuggestionsTable.collectionId, collectionsTable.id))
      .where(
        and(
          eq(photoCollectionSuggestionsTable.photoId, photoId),
          eq(photoCollectionSuggestionsTable.status, "pending"),
        ),
      ),
    db
      .select({
        id: photoNewCollectionSuggestionsTable.id,
        suggestedName: photoNewCollectionSuggestionsTable.suggestedName,
      })
      .from(photoNewCollectionSuggestionsTable)
      .where(
        and(
          eq(photoNewCollectionSuggestionsTable.photoId, photoId),
          eq(photoNewCollectionSuggestionsTable.status, "pending"),
        ),
      ),
    db
      .select({ status: aiAnalysisEventsTable.status })
      .from(aiAnalysisEventsTable)
      .where(eq(aiAnalysisEventsTable.photoId, photoId))
      .orderBy(desc(aiAnalysisEventsTable.createdAt))
      .limit(1),
    db
      .select()
      .from(photoAiEvaluationsTable)
      .where(eq(photoAiEvaluationsTable.photoId, photoId)),
  ]);

  const ratingData = ratingDataArr[0];
  const latestAiStatus = latestAiEvents[0]?.status ?? null;
  const aiEvaluation = serializeAiEvaluation(aiEvaluationRows[0]);

  let myRating: number | null = null;
  if (currentUserId) {
    const [myRatingRow] = await db
      .select({ score: ratingsTable.score })
      .from(ratingsTable)
      .where(and(eq(ratingsTable.photoId, photoId), eq(ratingsTable.userId, currentUserId)));
    myRating = myRatingRow?.score ?? null;
  }

  const p = photo.photo;
  return {
    ...p,
    takenAt: p.takenAt instanceof Date ? p.takenAt.toISOString() : (p.takenAt ?? null),
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    albumTitle: photo.albumTitle ?? null,
    photoCollections: photoCollections.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description ?? null,
      createdById: c.createdById,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
      photoCount: 0,
      coverPhotoUrl: null,
    })),
    photoProjects: photoProjects.map((pr) => ({ id: pr.id, name: pr.name })),
    attributionTags: photoAttributionTags.map((t) => ({ id: t.id, name: t.name })),
    averageRating: ratingData?.averageRating ? parseFloat(String(ratingData.averageRating)) : null,
    ratingCount: Number(ratingData?.ratingCount ?? 0),
    myRating,
    ratings: ratingsList.map((r) => ({
      userId: r.userId,
      userName: r.userName ?? null,
      score: r.score,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })),
    suggestedCollections,
    suggestedNewCollections,
    latestAiStatus,
    aiEvaluation,
  };
}

/**
 * Batched equivalent of buildPhotoResponse for a page of photos. Runs a fixed
 * number of `WHERE ... IN (ids)` queries (independent of the page size) instead
 * of ~8 queries per photo, eliminating the N+1 that the previous
 * `Promise.all(ids.map(buildPhotoResponse))` incurred. The returned objects are
 * identical in shape to buildPhotoResponse and preserve the input `photoIds`
 * order; ids with no photo row are dropped (matching the old `.filter(Boolean)`).
 */
export async function buildPhotosResponse(photoIds: number[], orgId: number, currentUserId?: number) {
  if (photoIds.length === 0) return [];

  const [
    photoRows,
    collectionRows,
    projectRows,
    attributionRows,
    ratingAggRows,
    ratingRows,
    suggestedCollectionRows,
    suggestedNewCollectionRows,
    latestAiRows,
    myRatingRows,
    aiEvaluationRows,
  ] = await Promise.all([
    db
      .select({ photo: photosTable, albumTitle: albumsTable.title })
      .from(photosTable)
      .leftJoin(albumsTable, eq(photosTable.albumId, albumsTable.id))
      // Tenant scope (#113): foreign-org ids are dropped even if a caller's
      // upstream query missed them — the defense-in-depth choke point.
      .where(and(inArray(photosTable.id, photoIds), eq(photosTable.organizationId, orgId))),
    db
      .select({
        photoId: photoCollectionsTable.photoId,
        id: collectionsTable.id,
        title: collectionsTable.title,
        description: collectionsTable.description,
        createdById: collectionsTable.createdById,
        createdAt: collectionsTable.createdAt,
      })
      .from(collectionsTable)
      .innerJoin(photoCollectionsTable, eq(collectionsTable.id, photoCollectionsTable.collectionId))
      .where(inArray(photoCollectionsTable.photoId, photoIds)),
    db
      .select({
        photoId: projectPhotosTable.photoId,
        id: projectsTable.id,
        name: projectsTable.name,
      })
      .from(projectsTable)
      .innerJoin(projectPhotosTable, eq(projectsTable.id, projectPhotosTable.projectId))
      .where(inArray(projectPhotosTable.photoId, photoIds)),
    db
      .select({
        photoId: photoAttributionTagsTable.photoId,
        id: attributionTagsTable.id,
        name: attributionTagsTable.name,
      })
      .from(attributionTagsTable)
      .innerJoin(photoAttributionTagsTable, eq(attributionTagsTable.id, photoAttributionTagsTable.tagId))
      .where(inArray(photoAttributionTagsTable.photoId, photoIds)),
    db
      .select({
        photoId: ratingsTable.photoId,
        averageRating: avg(ratingsTable.score),
        ratingCount: count(ratingsTable.id),
      })
      .from(ratingsTable)
      .where(inArray(ratingsTable.photoId, photoIds))
      .groupBy(ratingsTable.photoId),
    db
      .select({
        photoId: ratingsTable.photoId,
        userId: ratingsTable.userId,
        userName: usersTable.name,
        score: ratingsTable.score,
        createdAt: ratingsTable.createdAt,
      })
      .from(ratingsTable)
      .leftJoin(usersTable, eq(ratingsTable.userId, usersTable.id))
      .where(inArray(ratingsTable.photoId, photoIds))
      .orderBy(ratingsTable.createdAt),
    db
      .select({
        photoId: photoCollectionSuggestionsTable.photoId,
        id: collectionsTable.id,
        title: collectionsTable.title,
      })
      .from(photoCollectionSuggestionsTable)
      .innerJoin(collectionsTable, eq(photoCollectionSuggestionsTable.collectionId, collectionsTable.id))
      .where(
        and(
          inArray(photoCollectionSuggestionsTable.photoId, photoIds),
          eq(photoCollectionSuggestionsTable.status, "pending"),
        ),
      ),
    db
      .select({
        photoId: photoNewCollectionSuggestionsTable.photoId,
        id: photoNewCollectionSuggestionsTable.id,
        suggestedName: photoNewCollectionSuggestionsTable.suggestedName,
      })
      .from(photoNewCollectionSuggestionsTable)
      .where(
        and(
          inArray(photoNewCollectionSuggestionsTable.photoId, photoIds),
          eq(photoNewCollectionSuggestionsTable.status, "pending"),
        ),
      ),
    // Latest AI event per photo: DISTINCT ON (photo_id) ordered by created_at DESC.
    db
      .selectDistinctOn([aiAnalysisEventsTable.photoId], {
        photoId: aiAnalysisEventsTable.photoId,
        status: aiAnalysisEventsTable.status,
      })
      .from(aiAnalysisEventsTable)
      .where(inArray(aiAnalysisEventsTable.photoId, photoIds))
      .orderBy(aiAnalysisEventsTable.photoId, desc(aiAnalysisEventsTable.createdAt)),
    currentUserId
      ? db
          .select({ photoId: ratingsTable.photoId, score: ratingsTable.score })
          .from(ratingsTable)
          .where(and(inArray(ratingsTable.photoId, photoIds), eq(ratingsTable.userId, currentUserId)))
      : Promise.resolve([] as { photoId: number; score: number }[]),
    db
      .select()
      .from(photoAiEvaluationsTable)
      .where(inArray(photoAiEvaluationsTable.photoId, photoIds)),
  ]);

  const photoById = new Map(photoRows.map((r) => [r.photo.id, r]));

  const collectionsByPhoto = new Map<number, typeof collectionRows>();
  for (const row of collectionRows) {
    (collectionsByPhoto.get(row.photoId) ?? collectionsByPhoto.set(row.photoId, []).get(row.photoId)!).push(row);
  }
  const projectsByPhoto = new Map<number, typeof projectRows>();
  for (const row of projectRows) {
    (projectsByPhoto.get(row.photoId) ?? projectsByPhoto.set(row.photoId, []).get(row.photoId)!).push(row);
  }
  const attributionByPhoto = new Map<number, typeof attributionRows>();
  for (const row of attributionRows) {
    (attributionByPhoto.get(row.photoId) ?? attributionByPhoto.set(row.photoId, []).get(row.photoId)!).push(row);
  }
  const ratingAggByPhoto = new Map(ratingAggRows.map((r) => [r.photoId, r]));
  const ratingsByPhoto = new Map<number, typeof ratingRows>();
  for (const row of ratingRows) {
    (ratingsByPhoto.get(row.photoId) ?? ratingsByPhoto.set(row.photoId, []).get(row.photoId)!).push(row);
  }
  const suggestedByPhoto = new Map<number, typeof suggestedCollectionRows>();
  for (const row of suggestedCollectionRows) {
    (suggestedByPhoto.get(row.photoId) ?? suggestedByPhoto.set(row.photoId, []).get(row.photoId)!).push(row);
  }
  const suggestedNewByPhoto = new Map<number, typeof suggestedNewCollectionRows>();
  for (const row of suggestedNewCollectionRows) {
    (suggestedNewByPhoto.get(row.photoId) ?? suggestedNewByPhoto.set(row.photoId, []).get(row.photoId)!).push(row);
  }
  const latestAiByPhoto = new Map(latestAiRows.map((r) => [r.photoId, r.status]));
  const myRatingByPhoto = new Map(myRatingRows.map((r) => [r.photoId, r.score]));
  const aiEvaluationByPhoto = new Map(aiEvaluationRows.map((r) => [r.photoId, r]));

  return photoIds
    .map((id) => {
      const row = photoById.get(id);
      if (!row) return null;
      const p = row.photo;
      const ratingData = ratingAggByPhoto.get(id);
      return {
        ...p,
        takenAt: p.takenAt instanceof Date ? p.takenAt.toISOString() : (p.takenAt ?? null),
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
        albumTitle: row.albumTitle ?? null,
        photoCollections: (collectionsByPhoto.get(id) ?? []).map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description ?? null,
          createdById: c.createdById,
          createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
          photoCount: 0,
          coverPhotoUrl: null,
        })),
        photoProjects: (projectsByPhoto.get(id) ?? []).map((pr) => ({ id: pr.id, name: pr.name })),
        attributionTags: (attributionByPhoto.get(id) ?? []).map((t) => ({ id: t.id, name: t.name })),
        averageRating: ratingData?.averageRating ? parseFloat(String(ratingData.averageRating)) : null,
        ratingCount: Number(ratingData?.ratingCount ?? 0),
        myRating: myRatingByPhoto.get(id) ?? null,
        ratings: (ratingsByPhoto.get(id) ?? []).map((r) => ({
          userId: r.userId,
          userName: r.userName ?? null,
          score: r.score,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        })),
        suggestedCollections: (suggestedByPhoto.get(id) ?? []).map((s) => ({ id: s.id, title: s.title })),
        suggestedNewCollections: (suggestedNewByPhoto.get(id) ?? []).map((s) => ({ id: s.id, suggestedName: s.suggestedName })),
        latestAiStatus: latestAiByPhoto.get(id) ?? null,
        aiEvaluation: serializeAiEvaluation(aiEvaluationByPhoto.get(id)),
      };
    })
    .filter(Boolean);
}
