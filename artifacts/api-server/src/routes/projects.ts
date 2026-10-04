import { Router, type IRouter } from "express";
import { eq, count, sql, and } from "drizzle-orm";
import { db, projectsTable, projectPhotosTable, photosTable } from "@workspace/db";
import {
  ListProjectsResponse,
  CreateProjectBody,
  GetProjectParams,
  GetProjectResponse,
  UpdateProjectParams,
  UpdateProjectBody,
  UpdateProjectResponse,
  DeleteProjectParams,
  AddPhotoToProjectParams,
  AddPhotoToProjectBody,
  RemovePhotoFromProjectParams,
  ReorderProjectsBody,
  ReorderProjectsResponse,
  GetProjectRightsCheckResponse,
} from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse, hiddenPhotoCondition } from "../lib/photoHelpers";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { ZipArchive } from "archiver";
import { canManageItem, canSeeHiddenPhotos } from "../lib/capabilities";
import { loadUsageRights, snapshotOf, rightsChange } from "../lib/usageRights";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Keep only characters that are safe inside a Content-Disposition filename.
function safeZipName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 _.-]+/g, "").trim().replace(/\s+/g, "-");
  return (cleaned || "project") + ".zip";
}

// `canSeeHidden` (#218): for callers who may not see hidden photos, the count
// and cover skip them.
async function buildProjectResponse(projectId: number, orgId: number, canSeeHidden: boolean) {
  const [row] = await db
    .select({
      project: projectsTable,
      photoCount: count(photosTable.id),
    })
    .from(projectsTable)
    .leftJoin(projectPhotosTable, eq(projectsTable.id, projectPhotosTable.projectId))
    .leftJoin(photosTable, and(eq(projectPhotosTable.photoId, photosTable.id), hiddenPhotoCondition(canSeeHidden)))
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.organizationId, orgId)))
    .groupBy(projectsTable.id);

  if (!row) return null;

  const coverPhotoRow = await db
    .select({ url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
    .from(projectPhotosTable)
    .innerJoin(photosTable, eq(projectPhotosTable.photoId, photosTable.id))
    .where(and(eq(projectPhotosTable.projectId, projectId), hiddenPhotoCondition(canSeeHidden)))
    .orderBy(sql`${projectPhotosTable.addedAt} desc`)
    .limit(1);

  return {
    ...row.project,
    createdAt: row.project.createdAt.toISOString(),
    updatedAt: row.project.updatedAt.toISOString(),
    photoCount: Number(row.photoCount),
    coverPhotoUrl: coverPhotoRow[0]?.url ?? null,
    coverPhotoThumbnailKey: coverPhotoRow[0]?.thumbnailKey ?? null,
  };
}

// Streams a zip of every photo in the project (original files, store-level —
// JPEGs don't recompress). Entries keep their original filenames; collisions
// get a "-<photoId>" suffix. Missing storage objects are skipped, not fatal.
// Usage rights of a project's photos, re-read now (#207): the current status
// of each, and what changed since it was shortlisted. Warning-only — export
// is never blocked; this feeds the export confirmation and the zip manifest.
async function projectRightsCheck(projectId: number, orgId: number, canSeeHidden: boolean) {
  const rows = await db
    .select({ id: photosTable.id, filename: photosTable.filename, snapshot: projectPhotosTable.rightsSnapshot })
    .from(projectPhotosTable)
    .innerJoin(photosTable, eq(projectPhotosTable.photoId, photosTable.id))
    .where(and(eq(projectPhotosTable.projectId, projectId), eq(photosTable.organizationId, orgId), hiddenPhotoCondition(canSeeHidden)))
    .orderBy(sql`${projectPhotosTable.addedAt} asc`);
  const checkedAt = new Date();
  const current = await loadUsageRights(rows.map((r) => r.id), orgId);
  const photos = rows.map((r) => {
    const usageRights = current.get(r.id)!;
    return {
      photoId: r.id,
      filename: r.filename,
      usageRights,
      shortlistedRights: r.snapshot ?? null,
      changedSinceShortlist: rightsChange(r.snapshot, usageRights),
    };
  });
  return {
    checkedAt: checkedAt.toISOString(),
    counts: {
      total: photos.length,
      recorded: photos.filter((p) => p.usageRights.status === "recorded").length,
      notRecorded: photos.filter((p) => p.usageRights.status === "not_recorded").length,
      changedSinceShortlist: photos.filter((p) => p.changedSinceShortlist).length,
      notCapturedAtShortlist: photos.filter((p) => !p.shortlistedRights).length,
    },
    photos,
  };
}

router.get("/projects/:id/rights-check", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(raw, 10);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [project] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.organizationId, req.org!.id)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(GetProjectRightsCheckResponse.parse(await projectRightsCheck(projectId, req.org!.id, canSeeHiddenPhotos(req))));
});

router.get("/projects/:id/download", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(raw, 10);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.organizationId, req.org!.id)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const photos = await db
    .select({ id: photosTable.id, filename: photosTable.filename, storageKey: photosTable.storageKey })
    .from(projectPhotosTable)
    .innerJoin(photosTable, eq(projectPhotosTable.photoId, photosTable.id))
    .where(and(eq(projectPhotosTable.projectId, projectId), hiddenPhotoCondition(canSeeHiddenPhotos(req))))
    .orderBy(sql`${projectPhotosTable.addedAt} asc`);

  if (photos.length === 0) {
    res.status(404).json({ error: "Project has no photos" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeZipName(project.name)}"`);

  const archive = new ZipArchive({ store: true });
  archive.on("warning", (err: Error) => logger.warn({ err, projectId }, "Project zip warning"));
  archive.on("error", (err: Error) => {
    logger.error({ err, projectId }, "Project zip failed");
    res.destroy(err);
  });
  archive.pipe(res);

  // What was recorded at download time (#207). Recorded rights are the team's
  // own records, not a legal clearance; not_recorded means unknown.
  const rights = await projectRightsCheck(projectId, req.org!.id, canSeeHiddenPhotos(req));
  archive.append(
    JSON.stringify(
      {
        project: { id: project.id, name: project.name },
        ...rights,
        note: "Usage rights as recorded in Vispix by your team at download time. 'recorded' is not a legal clearance; 'not_recorded' means nobody has recorded rights for the photo.",
      },
      null,
      2,
    ),
    { name: "usage-rights.json" },
  );

  const usedNames = new Set<string>();
  for (const p of photos) {
    if (!p.storageKey) continue;
    let name = p.filename?.trim() || `photo-${p.id}.jpg`;
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf(".");
      name = dot > 0 ? `${name.slice(0, dot)}-${p.id}${name.slice(dot)}` : `${name}-${p.id}`;
    }
    usedNames.add(name);
    try {
      const file = await objectStorageService.getObjectEntityFile(p.storageKey);
      archive.append(file.createReadStream(), { name });
    } catch (err) {
      logger.warn({ err, photoId: p.id, projectId }, "Skipping photo missing from storage in project download");
    }
  }

  await archive.finalize();
});

// Registered before the /projects/:id routes so "order" isn't captured as an id.
router.put("/projects/order", requireOrgAuth, async (req, res): Promise<void> => {
  const { ids } = ReorderProjectsBody.parse(req.body);
  let updated = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      const rows = await tx
        .update(projectsTable)
        .set({ sortOrder: i })
        .where(and(eq(projectsTable.id, ids[i]), eq(projectsTable.organizationId, req.org!.id)))
        .returning({ id: projectsTable.id });
      updated += rows.length;
    }
  });
  res.json(ReorderProjectsResponse.parse({ updated }));
});

router.get("/projects", requireOrgAuth, async (req, res): Promise<void> => {
  const canSeeHidden = canSeeHiddenPhotos(req);
  const rows = await db
    .select({
      project: projectsTable,
      photoCount: count(photosTable.id),
    })
    .from(projectsTable)
    .leftJoin(projectPhotosTable, eq(projectsTable.id, projectPhotosTable.projectId))
    .leftJoin(photosTable, and(eq(projectPhotosTable.photoId, photosTable.id), hiddenPhotoCondition(canSeeHidden)))
    .where(eq(projectsTable.organizationId, req.org!.id))
    .groupBy(projectsTable.id)
    // Manual card order first (ASC puts nulls last), recently-touched
    // never-placed projects after that.
    .orderBy(sql`${projectsTable.sortOrder} asc, ${projectsTable.updatedAt} desc`);

  const projects = await Promise.all(
    rows.map(async (row) => {
      const coverPhotoRow = await db
        .select({ url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
        .from(projectPhotosTable)
        .innerJoin(photosTable, eq(projectPhotosTable.photoId, photosTable.id))
        .where(and(eq(projectPhotosTable.projectId, row.project.id), hiddenPhotoCondition(canSeeHidden)))
        .orderBy(sql`${projectPhotosTable.addedAt} desc`)
        .limit(1);

      return {
        ...row.project,
        createdAt: row.project.createdAt.toISOString(),
        updatedAt: row.project.updatedAt.toISOString(),
        photoCount: Number(row.photoCount),
        coverPhotoUrl: coverPhotoRow[0]?.url ?? null,
        coverPhotoThumbnailKey: coverPhotoRow[0]?.thumbnailKey ?? null,
      };
    })
  );

  res.json(ListProjectsResponse.parse(projects));
});

router.post("/projects", requireOrgAuth, async (req, res): Promise<void> => {
  const body = CreateProjectBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({ ...body.data, createdById: req.dbUser!.id, organizationId: req.org!.id })
    .returning();

  const full = await buildProjectResponse(project.id, req.org!.id, canSeeHiddenPhotos(req));
  res.status(201).json(GetProjectResponse.parse(full));
});

router.get("/projects/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const full = await buildProjectResponse(params.data.id, req.org!.id, canSeeHiddenPhotos(req));
  if (!full) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const photoRows = await db
    .select({ id: projectPhotosTable.photoId })
    .from(projectPhotosTable)
    .where(eq(projectPhotosTable.projectId, params.data.id))
    .orderBy(projectPhotosTable.addedAt, projectPhotosTable.photoId);

  const photos = await buildPhotosResponse(photoRows.map((p) => p.id), req.org!.id, req.dbUser?.id, { canSeeHidden: canSeeHiddenPhotos(req) });

  res.json(GetProjectResponse.parse({ ...full, photos }));
});

router.patch("/projects/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateProjectBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!canManageItem(req, existing.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db
    .update(projectsTable)
    .set({ ...body.data, updatedAt: new Date() })
    .where(eq(projectsTable.id, params.data.id));

  const full = await buildProjectResponse(params.data.id, req.org!.id, canSeeHiddenPhotos(req));
  res.json(UpdateProjectResponse.parse(full));
});

router.delete("/projects/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!canManageItem(req, existing.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.delete(projectsTable).where(eq(projectsTable.id, params.data.id));
  res.sendStatus(204);
});

router.post("/projects/:id/photos", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = AddPhotoToProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = AddPhotoToProjectBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.organizationId, req.org!.id)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!canManageItem(req, project.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Only a photo in this org can be added — blocks cross-tenant photo ids. A
  // hidden photo reads as nonexistent to callers who can't see it (#218).
  const [photo] = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(and(eq(photosTable.id, body.data.photoId), eq(photosTable.organizationId, req.org!.id), hiddenPhotoCondition(canSeeHiddenPhotos(req))));
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  // Record the rights as they stand when shortlisted, so export can report
  // later changes (#207). Re-adding keeps the original snapshot.
  const rights = await loadUsageRights([body.data.photoId], req.org!.id);
  await db
    .insert(projectPhotosTable)
    .values({ projectId: params.data.id, photoId: body.data.photoId, rightsSnapshot: snapshotOf(rights.get(body.data.photoId)!, new Date()) })
    .onConflictDoNothing();

  await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, params.data.id));

  res.sendStatus(204);
});

router.delete("/projects/:id/photos/:photoId", requireOrgAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawPhotoId = Array.isArray(req.params.photoId) ? req.params.photoId[0] : req.params.photoId;
  const params = RemovePhotoFromProjectParams.safeParse({
    id: parseInt(rawId, 10),
    photoId: parseInt(rawPhotoId, 10),
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.organizationId, req.org!.id)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!canManageItem(req, project.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db
    .delete(projectPhotosTable)
    .where(
      and(
        eq(projectPhotosTable.projectId, params.data.id),
        eq(projectPhotosTable.photoId, params.data.photoId)
      )
    );

  await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, params.data.id));

  res.sendStatus(204);
});

export default router;
