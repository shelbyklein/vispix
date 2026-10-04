import { resolveSuggestionAsManual } from "../lib/collectionSuggestions";
import { Router, type IRouter } from "express";
import { eq, count, sql, and } from "drizzle-orm";
import { db, collectionsTable, photoCollectionsTable, collectionNegativePhotosTable, photosTable, collectionTagsTable, tagsTable } from "@workspace/db";
import {
  ListCollectionsResponse,
  CreateCollectionBody,
  GetCollectionParams,
  GetCollectionResponse,
  UpdateCollectionParams,
  UpdateCollectionBody,
  UpdateCollectionResponse,
  DeleteCollectionParams,
  AddPhotoToCollectionParams,
  AddPhotoToCollectionBody,
  RemovePhotoFromCollectionParams,
  SetCollectionCoverParams,
  SetCollectionCoverBody,
  SetCollectionCoverResponse,
  GetSmartCollectionPhotosResponse,
  AddNegativePhotoToCollectionParams,
  AddNegativePhotoToCollectionBody,
  RemoveNegativePhotoFromCollectionParams,
  ListCollectionNegativePhotosParams,
  ListCollectionNegativePhotosResponse,
  ReorderCollectionsBody,
  ReorderCollectionsResponse,
} from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse, hiddenPhotoCondition } from "../lib/photoHelpers";
import { resolveSmartCollectionPhotoIds } from "../lib/smartCollectionPhotos";
import { canManageItem, canSeeHiddenPhotos } from "../lib/capabilities";

const router: IRouter = Router();

async function getCollectionTags(collectionId: number): Promise<string[]> {
  const rows = await db
    .select({ name: tagsTable.name })
    .from(collectionTagsTable)
    .innerJoin(tagsTable, eq(collectionTagsTable.tagId, tagsTable.id))
    .where(eq(collectionTagsTable.collectionId, collectionId))
    .orderBy(tagsTable.name);
  return rows.map((r) => r.name);
}

// `canSeeHidden` (#218): for callers who may not see hidden photos, the count
// and cover skip them.
async function buildCollectionResponse(collectionId: number, orgId: number, canSeeHidden: boolean) {
  const [row] = await db
    .select({
      collection: collectionsTable,
      photoCount: count(photosTable.id),
    })
    .from(collectionsTable)
    .leftJoin(photoCollectionsTable, eq(collectionsTable.id, photoCollectionsTable.collectionId))
    .leftJoin(photosTable, and(eq(photoCollectionsTable.photoId, photosTable.id), hiddenPhotoCondition(canSeeHidden)))
    .where(and(eq(collectionsTable.id, collectionId), eq(collectionsTable.organizationId, orgId)))
    .groupBy(collectionsTable.id);

  if (!row) return null;

  const [coverPhotoRow, tags] = await Promise.all([
    row.collection.coverPhotoId
      ? db
          .select({ url: photosTable.url })
          .from(photosTable)
          .where(and(eq(photosTable.id, row.collection.coverPhotoId), hiddenPhotoCondition(canSeeHidden)))
          .limit(1)
      : db
          .select({ url: photosTable.url })
          .from(photoCollectionsTable)
          .innerJoin(photosTable, eq(photoCollectionsTable.photoId, photosTable.id))
          .where(and(eq(photoCollectionsTable.collectionId, collectionId), hiddenPhotoCondition(canSeeHidden)))
          .orderBy(sql`${photoCollectionsTable.photoId} asc`)
          .limit(1),
    getCollectionTags(collectionId),
  ]);

  return {
    ...row.collection,
    createdAt: row.collection.createdAt.toISOString(),
    photoCount: Number(row.photoCount),
    coverPhotoUrl: coverPhotoRow[0]?.url ?? null,
    tags,
  };
}

// Registered before the /collections/:id routes so "order" isn't captured as an id.
router.put("/collections/order", requireOrgAuth, async (req, res): Promise<void> => {
  const { ids } = ReorderCollectionsBody.parse(req.body);
  let updated = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      const rows = await tx
        .update(collectionsTable)
        .set({ sortOrder: i })
        .where(and(eq(collectionsTable.id, ids[i]), eq(collectionsTable.organizationId, req.org!.id)))
        .returning({ id: collectionsTable.id });
      updated += rows.length;
    }
  });
  res.json(ReorderCollectionsResponse.parse({ updated }));
});

router.get("/collections", requireOrgAuth, async (req, res): Promise<void> => {
  const canSeeHidden = canSeeHiddenPhotos(req);
  // Defaults to plain collections so existing consumers never see people;
  // the People pages ask for kind=person explicitly.
  const kind = req.query.kind === "person" ? "person" : "collection";
  const rows = await db
    .select({
      collection: collectionsTable,
      photoCount: count(photosTable.id),
    })
    .from(collectionsTable)
    .leftJoin(photoCollectionsTable, eq(collectionsTable.id, photoCollectionsTable.collectionId))
    .leftJoin(photosTable, and(eq(photoCollectionsTable.photoId, photosTable.id), hiddenPhotoCondition(canSeeHidden)))
    .where(and(eq(collectionsTable.organizationId, req.org!.id), eq(collectionsTable.kind, kind)))
    .groupBy(collectionsTable.id)
    // Manual card order first (ASC puts nulls last), newest never-placed after.
    .orderBy(sql`${collectionsTable.sortOrder} asc, ${collectionsTable.createdAt} desc`);

  // Up to 5 random member photos per collection, resolved to display URLs.
  // Feeds the smart-collection cards' crossfading thumbnails; random per
  // request so the sample rotates between visits.
  const sampleResult = await db.execute<{ collection_id: number; url: string; thumbnail_key: string | null }>(sql`
    SELECT collection_id, url, thumbnail_key FROM (
      SELECT pc.collection_id, p.url, p.thumbnail_key,
             row_number() OVER (PARTITION BY pc.collection_id ORDER BY random()) AS rn
      FROM photo_collections pc
      JOIN photos p ON p.id = pc.photo_id
      WHERE p.is_hidden = false AND p.organization_id = ${req.org!.id}
    ) s WHERE rn <= 5
  `);
  const samplesByCollection = new Map<number, string[]>();
  for (const r of sampleResult.rows) {
    const url = r.thumbnail_key ? `/api/storage${r.thumbnail_key}` : r.url;
    const list = samplesByCollection.get(r.collection_id) ?? [];
    list.push(url);
    samplesByCollection.set(r.collection_id, list);
  }

  const collections = await Promise.all(
    rows.map(async (row) => {
      const [coverPhotoRow, tags] = await Promise.all([
        row.collection.coverPhotoId
          ? db
              .select({ url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
              .from(photosTable)
              .where(and(eq(photosTable.id, row.collection.coverPhotoId), hiddenPhotoCondition(canSeeHidden)))
              .limit(1)
          : db
              .select({ url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
              .from(photoCollectionsTable)
              .innerJoin(photosTable, eq(photoCollectionsTable.photoId, photosTable.id))
              .where(and(eq(photoCollectionsTable.collectionId, row.collection.id), hiddenPhotoCondition(canSeeHidden)))
              .orderBy(sql`${photoCollectionsTable.photoId} asc`)
              .limit(1),
        getCollectionTags(row.collection.id),
      ]);

      return {
        ...row.collection,
        createdAt: row.collection.createdAt.toISOString(),
        photoCount: Number(row.photoCount),
        coverPhotoUrl: coverPhotoRow[0]?.url ?? null,
        coverPhotoThumbnailKey: coverPhotoRow[0]?.thumbnailKey ?? null,
        sampleThumbnailUrls: samplesByCollection.get(row.collection.id) ?? [],
        tags,
      };
    })
  );

  res.json(ListCollectionsResponse.parse(collections));
});

router.post("/collections", requireOrgAuth, async (req, res): Promise<void> => {
  const body = CreateCollectionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [collection] = await db
    .insert(collectionsTable)
    .values({ ...body.data, createdById: req.dbUser!.id, organizationId: req.org!.id })
    .returning();

  const full = await buildCollectionResponse(collection.id, req.org!.id, canSeeHiddenPhotos(req));
  res.status(201).json(GetCollectionResponse.parse(full));
});

router.get("/collections/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetCollectionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const full = await buildCollectionResponse(params.data.id, req.org!.id, canSeeHiddenPhotos(req));
  if (!full) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const photoRows = await db
    .select({ id: photoCollectionsTable.photoId })
    .from(photoCollectionsTable)
    .where(eq(photoCollectionsTable.collectionId, params.data.id))
    .orderBy(photoCollectionsTable.photoId);

  const photos = await buildPhotosResponse(photoRows.map((p) => p.id), req.org!.id, req.dbUser?.id, { canSeeHidden: canSeeHiddenPhotos(req) });

  res.json(GetCollectionResponse.parse({ ...full, photos }));
});

router.patch("/collections/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateCollectionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateCollectionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, existing.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.update(collectionsTable).set(body.data).where(eq(collectionsTable.id, params.data.id));
  const full = await buildCollectionResponse(params.data.id, req.org!.id, canSeeHiddenPhotos(req));
  res.json(UpdateCollectionResponse.parse(full));
});

router.delete("/collections/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteCollectionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, existing.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.delete(collectionsTable).where(eq(collectionsTable.id, params.data.id));
  res.sendStatus(204);
});

router.post("/collections/:id/photos", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = AddPhotoToCollectionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = AddPhotoToCollectionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [photo] = await db.select({ id: photosTable.id }).from(photosTable).where(and(eq(photosTable.id, body.data.photoId), eq(photosTable.organizationId, req.org!.id), hiddenPhotoCondition(canSeeHiddenPhotos(req))));
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  await db
    .insert(photoCollectionsTable)
    .values({ collectionId: params.data.id, photoId: body.data.photoId })
    .onConflictDoNothing();
  // A photo can't be both a positive member and a negative example.
  await db
    .delete(collectionNegativePhotosTable)
    .where(and(eq(collectionNegativePhotosTable.collectionId, params.data.id), eq(collectionNegativePhotosTable.photoId, body.data.photoId)));
  // A hand-added membership resolves a pending AI suggestion for the pair.
  await resolveSuggestionAsManual(params.data.id, body.data.photoId, req.dbUser?.id ?? null);

  res.sendStatus(204);
});

router.delete("/collections/:id/photos/:photoId", requireOrgAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawPhotoId = Array.isArray(req.params.photoId) ? req.params.photoId[0] : req.params.photoId;
  const params = RemovePhotoFromCollectionParams.safeParse({
    id: parseInt(rawId, 10),
    photoId: parseInt(rawPhotoId, 10),
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db
    .delete(photoCollectionsTable)
    .where(
      and(
        eq(photoCollectionsTable.collectionId, params.data.id),
        eq(photoCollectionsTable.photoId, params.data.photoId)
      )
    );

  if (collection.coverPhotoId === params.data.photoId) {
    await db
      .update(collectionsTable)
      .set({ coverPhotoId: null })
      .where(eq(collectionsTable.id, params.data.id));
  }

  res.sendStatus(204);
});

router.patch("/collections/:id/cover", requireOrgAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = SetCollectionCoverParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = SetCollectionCoverBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [photo] = await db.select({ id: photosTable.id }).from(photosTable).where(and(eq(photosTable.id, body.data.photoId), eq(photosTable.organizationId, req.org!.id), hiddenPhotoCondition(canSeeHiddenPhotos(req))));
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  await db.update(collectionsTable).set({ coverPhotoId: body.data.photoId }).where(eq(collectionsTable.id, params.data.id));

  const full = await buildCollectionResponse(params.data.id, req.org!.id, canSeeHiddenPhotos(req));
  res.json(SetCollectionCoverResponse.parse(full));
});

router.get("/collections/:id/smart-photos", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid collection ID" });
    return;
  }

  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const topKRaw = req.query.topK ? parseInt(String(req.query.topK), 10) : 100;
  const topK = Number.isInteger(topKRaw) && topKRaw > 0 ? Math.min(topKRaw, 500) : 100;
  const offsetRaw = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const { ids } = await resolveSmartCollectionPhotoIds(collection, topK, offset, req.org!.id);
  const photos = await buildPhotosResponse(ids, req.org!.id, req.dbUser?.id, { canSeeHidden: canSeeHiddenPhotos(req) });
  res.json(GetSmartCollectionPhotosResponse.parse(photos));
});

router.get("/collections/:id/negative-photos", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListCollectionNegativePhotosParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }
  const rows = await db
    .select({ id: collectionNegativePhotosTable.photoId })
    .from(collectionNegativePhotosTable)
    .where(eq(collectionNegativePhotosTable.collectionId, params.data.id))
    .orderBy(collectionNegativePhotosTable.photoId);
  const photos = await buildPhotosResponse(rows.map((r) => r.id), req.org!.id, req.dbUser?.id, { canSeeHidden: canSeeHiddenPhotos(req) });
  res.json(ListCollectionNegativePhotosResponse.parse(photos));
});

router.post("/collections/:id/negative-photos", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = AddNegativePhotoToCollectionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = AddNegativePhotoToCollectionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }
  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [photo] = await db.select({ id: photosTable.id }).from(photosTable).where(and(eq(photosTable.id, body.data.photoId), eq(photosTable.organizationId, req.org!.id), hiddenPhotoCondition(canSeeHiddenPhotos(req))));
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  await db
    .insert(collectionNegativePhotosTable)
    .values({ collectionId: params.data.id, photoId: body.data.photoId })
    .onConflictDoNothing();
  // A photo can't be both a negative example and a positive member.
  await db
    .delete(photoCollectionsTable)
    .where(and(eq(photoCollectionsTable.collectionId, params.data.id), eq(photoCollectionsTable.photoId, body.data.photoId)));
  res.sendStatus(204);
});

router.delete("/collections/:id/negative-photos/:photoId", requireOrgAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawPhoto = Array.isArray(req.params.photoId) ? req.params.photoId[0] : req.params.photoId;
  const params = RemoveNegativePhotoFromCollectionParams.safeParse({ id: parseInt(rawId, 10), photoId: parseInt(rawPhoto, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [collection] = await db.select().from(collectionsTable).where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }
  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db
    .delete(collectionNegativePhotosTable)
    .where(and(eq(collectionNegativePhotosTable.collectionId, params.data.id), eq(collectionNegativePhotosTable.photoId, params.data.photoId)));
  res.sendStatus(204);
});

export default router;
