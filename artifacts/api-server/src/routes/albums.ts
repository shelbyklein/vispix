import { Router, type IRouter, type Request } from "express";
import { eq, and, count, sql, desc, avg } from "drizzle-orm";
import { db, albumsTable, photosTable, usersTable, ratingsTable, nearDuplicatePairsTable, nearDuplicateIgnoresTable } from "@workspace/db";
import {
  ListAlbumsResponse,
  ListAlbumsResponseItem,
  CreateAlbumBody,
  GetAlbumParams,
  GetAlbumResponse,
  UpdateAlbumParams,
  UpdateAlbumBody,
  UpdateAlbumResponse,
  DeleteAlbumParams,
  SetAlbumCoverParams,
  SetAlbumCoverBody,
  SetAlbumCoverResponse,
  GetAlbumTopRatedParams,
  GetAlbumTopRatedResponse,
  ReorderAlbumsBody,
  ReorderAlbumsResponse,
} from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse, deletePhotoStorageObjects } from "../lib/photoHelpers";

const router: IRouter = Router();

// Album management (rename/delete/cover) is allowed for the album's creator,
// the active org's owners/admins, or a platform admin. Org owners manage their
// own org's albums — the old creator-or-platform-admin rule left org owners
// unable to delete albums in their own organization (#191 surfaced this).
function canManageAlbum(req: Request, ownerId: number): boolean {
  return (
    ownerId === req.dbUser!.id ||
    req.dbUser!.role === "admin" ||
    req.orgRole === "owner" ||
    req.orgRole === "admin"
  );
}

// Tenant scope (#113): buildAlbumResponse is only ever called with an album the
// caller has already confirmed is in their org, but it re-asserts the org here
// so a foreign album id resolves to null (→ 404) as defense-in-depth.
async function buildAlbumResponse(albumId: number, orgId: number) {
  const [[row], [ratedRow], [unratedRow], [dupRow], [nearRow]] = await Promise.all([
    db
      .select({
        album: albumsTable,
        ownerName: usersTable.name,
        photoCount: count(photosTable.id),
        hiddenCount: sql<number>`cast(count(case when ${photosTable.isHidden} = true then 1 end) as integer)`,
      })
      .from(albumsTable)
      .leftJoin(usersTable, eq(albumsTable.ownerId, usersTable.id))
      .leftJoin(photosTable, eq(albumsTable.id, photosTable.albumId))
      .where(and(eq(albumsTable.id, albumId), eq(albumsTable.organizationId, orgId)))
      .groupBy(albumsTable.id, usersTable.name),
    db
      .select({ ratedCount: sql<number>`cast(count(distinct ${ratingsTable.photoId}) as integer)` })
      .from(ratingsTable)
      .innerJoin(photosTable, eq(ratingsTable.photoId, photosTable.id))
      .where(eq(photosTable.albumId, albumId)),
    // Visible (non-hidden) photos in the album with zero ratings. This mirrors the
    // album detail page's default "Review Unrated" scope, which excludes hidden photos.
    db
      .select({ unratedCount: sql<number>`cast(count(*) as integer)` })
      .from(photosTable)
      .where(
        and(
          eq(photosTable.albumId, albumId),
          eq(photosTable.isHidden, false),
          sql`not exists (select 1 from ${ratingsTable} where ${ratingsTable.photoId} = ${photosTable.id})`,
        ),
      ),
    // Exact duplicates within this album: photos whose content_hash is shared
    // by another photo in the same album (#166).
    db
      .select({ n: sql<number>`cast(count(*) as integer)` })
      .from(photosTable)
      .where(
        and(
          eq(photosTable.albumId, albumId),
          sql`${photosTable.contentHash} is not null`,
          sql`${photosTable.contentHash} in (select content_hash from ${photosTable} where album_id = ${albumId} and content_hash is not null group by content_hash having count(*) > 1)`,
        ),
      ),
    // Near-duplicates: distinct photos in this album that are part of a
    // non-ignored near-duplicate pair (#166), org-scoped.
    db
      .select({ n: sql<number>`cast(count(distinct pid) as integer)` })
      .from(
        sql`(
          select ${nearDuplicatePairsTable.photoA} as pid from ${nearDuplicatePairsTable}
            where ${nearDuplicatePairsTable.organizationId} = ${orgId}
              and ${nearDuplicatePairsTable.photoA} in (select id from ${photosTable} where album_id = ${albumId})
              and not exists (select 1 from ${nearDuplicateIgnoresTable} ni where ni.photo_a = ${nearDuplicatePairsTable.photoA} and ni.photo_b = ${nearDuplicatePairsTable.photoB})
          union
          select ${nearDuplicatePairsTable.photoB} from ${nearDuplicatePairsTable}
            where ${nearDuplicatePairsTable.organizationId} = ${orgId}
              and ${nearDuplicatePairsTable.photoB} in (select id from ${photosTable} where album_id = ${albumId})
              and not exists (select 1 from ${nearDuplicateIgnoresTable} ni where ni.photo_a = ${nearDuplicatePairsTable.photoA} and ni.photo_b = ${nearDuplicatePairsTable.photoB})
        ) t`,
      ),
  ]);

  if (!row) return null;

  let coverPhotoUrl: string | null = null;
  let coverPhotoThumbnailKey: string | null = null;
  if (row.album.coverPhotoId) {
    const [cover] = await db
      .select({ url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
      .from(photosTable)
      .where(eq(photosTable.id, row.album.coverPhotoId));
    coverPhotoUrl = cover?.url ?? null;
    coverPhotoThumbnailKey = cover?.thumbnailKey ?? null;
  }

  return {
    ...row.album,
    ownerName: row.ownerName ?? null,
    photoCount: Number(row.photoCount),
    hiddenCount: Number(row.hiddenCount),
    ratedCount: Number(ratedRow?.ratedCount ?? 0),
    unratedCount: Number(unratedRow?.unratedCount ?? 0),
    duplicateCount: Number(dupRow?.n ?? 0),
    nearDuplicateCount: Number(nearRow?.n ?? 0),
    coverPhotoUrl,
    coverPhotoThumbnailKey,
  };
}

// Registered before the /albums/:id routes so "order" isn't captured as an id.
router.put("/albums/order", requireOrgAuth, async (req, res): Promise<void> => {
  const { ids } = ReorderAlbumsBody.parse(req.body);
  const orgId = req.org!.id;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      const rows = await tx
        .update(albumsTable)
        .set({ sortOrder: i })
        .where(and(eq(albumsTable.id, ids[i]), eq(albumsTable.organizationId, orgId)))
        .returning({ id: albumsTable.id });
      updated += rows.length;
    }
  });
  res.json(ReorderAlbumsResponse.parse({ updated }));
});

router.get("/albums", requireOrgAuth, async (req, res): Promise<void> => {
  // Fetch album rows and ratedCounts in parallel.
  // ratedCounts uses a single aggregate scan — NOT a correlated subquery per album.
  const orgId = req.org!.id;
  const [rows, ratedCountRows] = await Promise.all([
    db
      .select({
        album: albumsTable,
        ownerName: usersTable.name,
        photoCount: count(photosTable.id),
        hiddenCount: sql<number>`cast(count(case when ${photosTable.isHidden} = true then 1 end) as integer)`,
      })
      .from(albumsTable)
      .leftJoin(usersTable, eq(albumsTable.ownerId, usersTable.id))
      .leftJoin(photosTable, eq(albumsTable.id, photosTable.albumId))
      .where(eq(albumsTable.organizationId, orgId))
      .groupBy(albumsTable.id, usersTable.name)
      // Manual card order first (ASC puts nulls last), newest of the
      // never-placed albums after that.
      .orderBy(sql`${albumsTable.sortOrder} asc, ${albumsTable.createdAt} desc`),
    db
      .select({
        albumId: photosTable.albumId,
        ratedCount: sql<number>`cast(count(distinct ${ratingsTable.photoId}) as integer)`,
      })
      .from(ratingsTable)
      .innerJoin(photosTable, eq(ratingsTable.photoId, photosTable.id))
      .where(eq(photosTable.organizationId, orgId))
      .groupBy(photosTable.albumId),
  ]);

  const ratedCountByAlbum = new Map(
    ratedCountRows.map((r) => [r.albumId, Number(r.ratedCount)])
  );

  const albums = await Promise.all(
    rows.map(async (row) => {
      let coverPhotoUrl: string | null = null;
      let coverPhotoThumbnailKey: string | null = null;
      if (row.album.coverPhotoId) {
        const [cover] = await db
          .select({ url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
          .from(photosTable)
          .where(eq(photosTable.id, row.album.coverPhotoId));
        coverPhotoUrl = cover?.url ?? null;
        coverPhotoThumbnailKey = cover?.thumbnailKey ?? null;
      }
      return {
        ...row.album,
        ownerName: row.ownerName ?? null,
        photoCount: Number(row.photoCount),
        hiddenCount: Number(row.hiddenCount),
        ratedCount: ratedCountByAlbum.get(row.album.id) ?? 0,
        coverPhotoUrl,
        coverPhotoThumbnailKey,
      };
    })
  );

  res.json(ListAlbumsResponse.parse(albums));
});

router.post("/albums", requireOrgAuth, async (req, res): Promise<void> => {
  const body = CreateAlbumBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [album] = await db
    .insert(albumsTable)
    .values({ ...body.data, ownerId: req.dbUser!.id, organizationId: req.org!.id })
    .returning();

  const full = await buildAlbumResponse(album.id, req.org!.id);
  res.status(201).json(GetAlbumResponse.parse(full));
});

router.get("/albums/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetAlbumParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const full = await buildAlbumResponse(params.data.id, req.org!.id);
  if (!full) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  res.json(GetAlbumResponse.parse(full));
});

router.patch("/albums/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateAlbumParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateAlbumBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(albumsTable).where(and(eq(albumsTable.id, params.data.id), eq(albumsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  if (!canManageAlbum(req, existing.ownerId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.update(albumsTable).set(body.data).where(eq(albumsTable.id, params.data.id));
  const full = await buildAlbumResponse(params.data.id, req.org!.id);
  res.json(UpdateAlbumResponse.parse(full));
});

router.delete("/albums/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteAlbumParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(albumsTable).where(and(eq(albumsTable.id, params.data.id), eq(albumsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  if (!canManageAlbum(req, existing.ownerId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const photosToClean = await db
    .select({ id: photosTable.id, storageKey: photosTable.storageKey, thumbnailKey: photosTable.thumbnailKey })
    .from(photosTable)
    .where(eq(photosTable.albumId, params.data.id));

  await db.delete(albumsTable).where(eq(albumsTable.id, params.data.id));
  await Promise.all(photosToClean.map((photo) => deletePhotoStorageObjects(photo)));
  res.sendStatus(204);
});

router.patch("/albums/:id/cover", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = SetAlbumCoverParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = SetAlbumCoverBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(albumsTable).where(and(eq(albumsTable.id, params.data.id), eq(albumsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  if (!canManageAlbum(req, existing.ownerId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [coverPhoto] = await db
    .select()
    .from(photosTable)
    .where(eq(photosTable.id, body.data.photoId));
  if (!coverPhoto || coverPhoto.albumId !== params.data.id) {
    res.status(400).json({ error: "Photo does not belong to this album" });
    return;
  }

  await db
    .update(albumsTable)
    .set({ coverPhotoId: body.data.photoId })
    .where(eq(albumsTable.id, params.data.id));

  const full = await buildAlbumResponse(params.data.id, req.org!.id);
  res.json(SetAlbumCoverResponse.parse(full));
});

router.get("/albums/:id/top-rated", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetAlbumTopRatedParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [album] = await db.select().from(albumsTable).where(and(eq(albumsTable.id, params.data.id), eq(albumsTable.organizationId, req.org!.id)));
  if (!album) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  const rows = await db
    .select({ id: photosTable.id, avgRating: avg(ratingsTable.score) })
    .from(photosTable)
    .innerJoin(ratingsTable, eq(ratingsTable.photoId, photosTable.id))
    .where(eq(photosTable.albumId, params.data.id))
    .groupBy(photosTable.id)
    .orderBy(desc(avg(ratingsTable.score)))
    .limit(12);

  const photos = await buildPhotosResponse(rows.map((p) => p.id), req.org!.id, req.dbUser?.id);
  res.json(GetAlbumTopRatedResponse.parse(photos));
});

export default router;
