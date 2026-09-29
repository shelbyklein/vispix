import { Router, type IRouter } from "express";
import { isOrgUploadKey } from "../lib/storageKeys";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, assetsTable, projectsTable } from "@workspace/db";
import {
  ListAssetsQueryParams,
  ListAssetsResponse,
  CreateAssetBody,
  UpdateAssetParams,
  UpdateAssetBody,
  UpdateAssetResponse,
  DeleteAssetParams,
} from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";

const router: IRouter = Router();

// The asset library (brand marks + reference works) deliberately skips the
// photo pipeline: no thumbnails, no AI analysis, no embeddings. Files are
// uploaded through the storage request-url flow first; these routes only
// manage the metadata rows. Deleting an asset removes the row, not the
// storage object — the bucket is shared between environments, and orphaned
// objects are cheaper than a cross-environment delete.

async function buildAssetResponse(id: number, orgId: number) {
  const [row] = await db
    .select({ asset: assetsTable, projectName: projectsTable.name })
    .from(assetsTable)
    .leftJoin(projectsTable, eq(assetsTable.projectId, projectsTable.id))
    .where(and(eq(assetsTable.id, id), eq(assetsTable.organizationId, orgId)));
  if (!row) return null;
  return {
    ...row.asset,
    projectName: row.projectName ?? null,
    createdAt: row.asset.createdAt.toISOString(),
    updatedAt: row.asset.updatedAt.toISOString(),
  };
}

router.get("/assets", requireOrgAuth, async (req, res): Promise<void> => {
  const query = ListAssetsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { kind, projectId } = query.data;

  const rows = await db
    .select({ asset: assetsTable, projectName: projectsTable.name })
    .from(assetsTable)
    .leftJoin(projectsTable, eq(assetsTable.projectId, projectsTable.id))
    .where(
      and(
        eq(assetsTable.organizationId, req.org!.id),
        kind ? eq(assetsTable.kind, kind) : undefined,
        projectId != null ? eq(assetsTable.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(assetsTable.kind), asc(assetsTable.name));

  const assets = rows.map((row) => ({
    ...row.asset,
    projectName: row.projectName ?? null,
    createdAt: row.asset.createdAt.toISOString(),
    updatedAt: row.asset.updatedAt.toISOString(),
  }));
  res.json(ListAssetsResponse.parse(assets));
});

router.post("/assets", requireOrgAuth, async (req, res): Promise<void> => {
  const body = CreateAssetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  // Only accept uploads issued to this org by our upload flow — never another
  // org's object or an arbitrary path.
  if (!isOrgUploadKey(body.data.storageKey, req.org!.id)) {
    res.status(400).json({ error: "storageKey must be an upload of this organization" });
    return;
  }

  if (body.data.projectId != null) {
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, body.data.projectId), eq(projectsTable.organizationId, req.org!.id)));
    if (!project) {
      res.status(400).json({ error: "Project not found" });
      return;
    }
  }

  const [asset] = await db
    .insert(assetsTable)
    .values({ ...body.data, createdById: req.dbUser!.id, organizationId: req.org!.id })
    .returning();

  const full = await buildAssetResponse(asset.id, req.org!.id);
  res.status(201).json(UpdateAssetResponse.parse(full));
});

router.patch("/assets/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateAssetParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAssetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(assetsTable).where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  const { isPrimary, ...fields } = body.data;
  const isPlatformAdmin = req.dbUser!.role === "admin";
  // Editing an asset: its creator or a platform admin (unchanged).
  if (Object.keys(fields).length > 0 && existing.createdById !== req.dbUser!.id && !isPlatformAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Designating the primary logo is an organization decision (#206): owners
  // and admins (or a platform admin), whoever uploaded the asset.
  if (isPrimary !== undefined) {
    if (!isPlatformAdmin && req.orgRole !== "owner" && req.orgRole !== "admin") {
      res.status(403).json({ error: "Only organization owners and admins can set the primary logo" });
      return;
    }
    const kind = fields.kind ?? existing.kind;
    if (isPrimary && (kind !== "brand" || !existing.contentType.startsWith("image/"))) {
      res.status(400).json({ error: "Only brand image assets can be the primary logo" });
      return;
    }
  }

  if (body.data.projectId != null) {
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, body.data.projectId), eq(projectsTable.organizationId, req.org!.id)));
    if (!project) {
      res.status(400).json({ error: "Project not found" });
      return;
    }
  }

  const projectId = fields.projectId !== undefined ? fields.projectId : existing.projectId;
  const movesScope = fields.projectId !== undefined && fields.projectId !== existing.projectId;
  await db.transaction(async (tx) => {
    // One primary per scope (org-wide, or one project): replace the previous.
    if (isPrimary === true) {
      await tx
        .update(assetsTable)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(assetsTable.organizationId, req.org!.id),
            eq(assetsTable.isPrimary, true),
            projectId == null ? isNull(assetsTable.projectId) : eq(assetsTable.projectId, projectId),
          ),
        );
    }
    await tx
      .update(assetsTable)
      .set({
        ...fields,
        // Moving a primary to another scope drops the designation unless it's
        // re-asserted in the same request.
        ...(isPrimary !== undefined ? { isPrimary } : movesScope && existing.isPrimary ? { isPrimary: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(assetsTable.id, params.data.id));
  });

  const full = await buildAssetResponse(params.data.id, req.org!.id);
  res.json(UpdateAssetResponse.parse(full));
});

router.delete("/assets/:id", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteAssetParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(assetsTable).where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.organizationId, req.org!.id)));
  if (!existing) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  if (existing.createdById !== req.dbUser!.id && req.dbUser!.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.delete(assetsTable).where(eq(assetsTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
