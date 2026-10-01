import { Router, type IRouter } from "express";
import { eq, and, inArray, ne, sql } from "drizzle-orm";
import { db, attributionTagsTable, photoAttributionTagsTable, photosTable, albumsTable } from "@workspace/db";
import {
  ListAttributionTagsResponse,
  CreateAttributionTagBody,
  UpdateAttributionTagBody,
  // Also used for the create response — orval doesn't emit schemas for 201s,
  // and the shapes are identical ({ id, name }).
  UpdateAttributionTagResponse,
  BulkSetAttributionTagsBody,
  BulkSetAttributionTagsResponse,
  AddPhotoAttributionTagBody,
  GetAlbumAttributionSummaryResponse,
  SetAlbumAttributionBody,
  SetAlbumAttributionResponse,
} from "@workspace/api-zod";
import { requireOrgAuth, requireOrgRole } from "../middlewares/requireOrg";
import { canSetPhotoRights } from "../lib/capabilities";

const router: IRouter = Router();

// Tag management is an org-admin action (owner/admin in the active org), not an
// instance-superadmin one, now that attribution tags are per-org (#113).
const requireOrgAdmin = [requireOrgAuth, requireOrgRole("owner", "admin")] as const;

const DUPLICATE_TAG = "A tag with that name already exists";

/** Another tag in this org with the same name, ignoring case. Other orgs' names never count. */
async function nameTaken(organizationId: number, name: string, exceptId?: number): Promise<boolean> {
  const [row] = await db
    .select({ id: attributionTagsTable.id })
    .from(attributionTagsTable)
    .where(
      and(
        eq(attributionTagsTable.organizationId, organizationId),
        sql`lower(${attributionTagsTable.name}) = lower(${name})`,
        exceptId != null ? ne(attributionTagsTable.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return !!row;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

router.get("/attribution-tags", requireOrgAuth, async (req, res): Promise<void> => {
  const tags = await db
    .select()
    .from(attributionTagsTable)
    .where(eq(attributionTagsTable.organizationId, req.org!.id))
    .orderBy(attributionTagsTable.name);
  res.json(ListAttributionTagsResponse.parse(tags.map((t) => ({ id: t.id, name: t.name }))));
});

router.post("/attribution-tags", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = CreateAttributionTagBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Tag name cannot be empty" });
    return;
  }
  // Names are unique per organization (migration 0037), ignoring case here so
  // "Social" and "social" can't both exist; another org's tags never matter.
  if (await nameTaken(req.org!.id, name)) {
    res.status(409).json({ error: DUPLICATE_TAG });
    return;
  }
  try {
    const [tag] = await db.insert(attributionTagsTable).values({ name, organizationId: req.org!.id }).returning();
    res.status(201).json(UpdateAttributionTagResponse.parse({ id: tag.id, name: tag.name }));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    res.status(409).json({ error: DUPLICATE_TAG }); // a concurrent create won the race
  }
});

router.patch("/attribution-tags/:id", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid tag id" });
    return;
  }
  const body = UpdateAttributionTagBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Tag name cannot be empty" });
    return;
  }
  if (await nameTaken(req.org!.id, name, id)) {
    res.status(409).json({ error: DUPLICATE_TAG });
    return;
  }
  let tag: typeof attributionTagsTable.$inferSelect | undefined;
  try {
    [tag] = await db
      .update(attributionTagsTable)
      .set({ name })
      .where(and(eq(attributionTagsTable.id, id), eq(attributionTagsTable.organizationId, req.org!.id)))
      .returning();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    res.status(409).json({ error: DUPLICATE_TAG });
    return;
  }
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }
  res.json(UpdateAttributionTagResponse.parse({ id: tag.id, name: tag.name }));
});

router.delete("/attribution-tags/:id", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid tag id" });
    return;
  }
  const deleted = await db
    .delete(attributionTagsTable)
    .where(and(eq(attributionTagsTable.id, id), eq(attributionTagsTable.organizationId, req.org!.id)))
    .returning({ id: attributionTagsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }
  res.status(204).send();
});

// Album-level coverage: for every attribution tag, how many of this album's
// photos carry it. Drives the album page's tri-state pills (none/some/all).
router.get("/albums/:id/attribution-tags", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const albumId = parseInt(raw, 10);
  if (!Number.isInteger(albumId)) {
    res.status(400).json({ error: "Invalid album id" });
    return;
  }
  const [album] = await db.select({ id: albumsTable.id }).from(albumsTable).where(and(eq(albumsTable.id, albumId), eq(albumsTable.organizationId, req.org!.id)));
  if (!album) {
    res.status(404).json({ error: "Album not found" });
    return;
  }

  const countResult = await db.execute<{ photo_count: number }>(
    sql`SELECT count(*)::int AS photo_count FROM photos WHERE album_id = ${albumId}`,
  );
  const tagResult = await db.execute<{ id: number; name: string; count: number }>(sql`
    SELECT t.id, t.name, count(pat.photo_id)::int AS count
    FROM attribution_tags t
    LEFT JOIN photo_attribution_tags pat
      ON pat.tag_id = t.id
      AND pat.photo_id IN (SELECT p.id FROM photos p WHERE p.album_id = ${albumId})
    WHERE t.organization_id = ${req.org!.id}
    GROUP BY t.id, t.name
    ORDER BY t.name
  `);

  res.json(
    GetAlbumAttributionSummaryResponse.parse({
      photoCount: countResult.rows[0]?.photo_count ?? 0,
      tags: tagResult.rows.map((r) => ({ id: r.id, name: r.name, count: r.count })),
    }),
  );
});

// The album-level control: attribution is decided per album, so this adds or
// removes one tag on EVERY photo in the album in a single statement.
router.post("/albums/:id/attribution-tags", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const albumId = parseInt(raw, 10);
  if (!Number.isInteger(albumId)) {
    res.status(400).json({ error: "Invalid album id" });
    return;
  }
  const body = SetAlbumAttributionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { tagId, mode } = body.data;

  const [album] = await db.select({ id: albumsTable.id }).from(albumsTable).where(and(eq(albumsTable.id, albumId), eq(albumsTable.organizationId, req.org!.id)));
  if (!album) {
    res.status(404).json({ error: "Album not found" });
    return;
  }
  const [tag] = await db.select().from(attributionTagsTable).where(and(eq(attributionTagsTable.id, tagId), eq(attributionTagsTable.organizationId, req.org!.id)));
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }

  if (mode === "add") {
    const result = await db.execute(sql`
      INSERT INTO photo_attribution_tags (photo_id, tag_id)
      SELECT p.id, ${tagId} FROM photos p WHERE p.album_id = ${albumId}
      ON CONFLICT DO NOTHING
    `);
    res.json(SetAlbumAttributionResponse.parse({ updated: result.rowCount ?? 0 }));
  } else {
    const result = await db.execute(sql`
      DELETE FROM photo_attribution_tags
      WHERE tag_id = ${tagId}
      AND photo_id IN (SELECT p.id FROM photos p WHERE p.album_id = ${albumId})
    `);
    res.json(SetAlbumAttributionResponse.parse({ updated: result.rowCount ?? 0 }));
  }
});

// Bulk add/remove a tag on a set of photos (the album select-mode flow).
// Registered as /photos/attribution-tags/bulk (not /photos/bulk/...) so it can
// never be shadowed by /photos/:id patterns regardless of mount order.
router.post("/photos/attribution-tags/bulk", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = BulkSetAttributionTagsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { ids, tagId, mode } = body.data;

  const [tag] = await db.select().from(attributionTagsTable).where(and(eq(attributionTagsTable.id, tagId), eq(attributionTagsTable.organizationId, req.org!.id)));
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }

  if (mode === "add") {
    const existing = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(and(inArray(photosTable.id, ids), eq(photosTable.organizationId, req.org!.id)));
    if (existing.length === 0) {
      res.json(BulkSetAttributionTagsResponse.parse({ updated: 0 }));
      return;
    }
    const inserted = await db
      .insert(photoAttributionTagsTable)
      .values(existing.map((p) => ({ photoId: p.id, tagId })))
      .onConflictDoNothing()
      .returning({ photoId: photoAttributionTagsTable.photoId });
    res.json(BulkSetAttributionTagsResponse.parse({ updated: inserted.length }));
  } else {
    const deleted = await db
      .delete(photoAttributionTagsTable)
      .where(and(inArray(photoAttributionTagsTable.photoId, ids), eq(photoAttributionTagsTable.tagId, tagId)))
      .returning({ photoId: photoAttributionTagsTable.photoId });
    res.json(BulkSetAttributionTagsResponse.parse({ updated: deleted.length }));
  }
});

router.post("/photos/:id/attribution-tags", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const photoId = parseInt(raw, 10);
  if (!Number.isInteger(photoId)) {
    res.status(400).json({ error: "Invalid photo id" });
    return;
  }
  const body = AddPhotoAttributionTagBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [photo] = await db
    .select({ id: photosTable.id, uploaderId: photosTable.uploaderId })
    .from(photosTable)
    .where(and(eq(photosTable.id, photoId), eq(photosTable.organizationId, req.org!.id)));
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  // Usage rights: org owners/admins, or the photo's uploader (#218).
  if (!canSetPhotoRights(req, photo.uploaderId)) {
    res.status(403).json({ error: "Only the photo's uploader or an organization owner/admin can set its usage rights" });
    return;
  }
  const [tag] = await db.select().from(attributionTagsTable).where(and(eq(attributionTagsTable.id, body.data.tagId), eq(attributionTagsTable.organizationId, req.org!.id)));
  if (!tag) {
    res.status(404).json({ error: "Tag not found" });
    return;
  }
  await db
    .insert(photoAttributionTagsTable)
    .values({ photoId, tagId: body.data.tagId })
    .onConflictDoNothing();
  res.status(204).send();
});

router.delete("/photos/:id/attribution-tags/:tagId", requireOrgAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawTagId = Array.isArray(req.params.tagId) ? req.params.tagId[0] : req.params.tagId;
  const photoId = parseInt(rawId, 10);
  const tagId = parseInt(rawTagId, 10);
  if (!Number.isInteger(photoId) || !Number.isInteger(tagId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Only touch a photo in this org — otherwise a foreign (photo, tag) link could
  // be removed by id alone.
  const [photo] = await db
    .select({ id: photosTable.id, uploaderId: photosTable.uploaderId })
    .from(photosTable)
    .where(and(eq(photosTable.id, photoId), eq(photosTable.organizationId, req.org!.id)));
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  if (!canSetPhotoRights(req, photo.uploaderId)) {
    res.status(403).json({ error: "Only the photo's uploader or an organization owner/admin can set its usage rights" });
    return;
  }
  await db
    .delete(photoAttributionTagsTable)
    .where(and(eq(photoAttributionTagsTable.photoId, photoId), eq(photoAttributionTagsTable.tagId, tagId)));
  res.status(204).send();
});

export default router;
