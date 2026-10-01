import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, collectionsTable, tagsTable, collectionTagsTable } from "@workspace/db";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { z } from "zod";
import { canManageItem } from "../lib/capabilities";

const router: IRouter = Router();

const CollectionTagParams = z.object({ id: z.coerce.number() });
const AddCollectionTagBody = z.object({ tagName: z.string().min(1).max(50) });
const RemoveCollectionTagParams = z.object({ id: z.coerce.number(), tagName: z.string().min(1) });

router.get("/collections/:id/tags", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = CollectionTagParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [collection] = await db
    .select({ id: collectionsTable.id })
    .from(collectionsTable)
    .where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const rows = await db
    .select({ name: tagsTable.name })
    .from(collectionTagsTable)
    .innerJoin(tagsTable, eq(collectionTagsTable.tagId, tagsTable.id))
    .where(eq(collectionTagsTable.collectionId, params.data.id))
    .orderBy(tagsTable.name);

  res.json(rows.map((r) => r.name));
});

router.post("/collections/:id/tags", requireOrgAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = CollectionTagParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = AddCollectionTagBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [collection] = await db
    .select({ id: collectionsTable.id, createdById: collectionsTable.createdById })
    .from(collectionsTable)
    .where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const tagName = body.data.tagName.trim().toLowerCase();

  const [existingTag] = await db
    .insert(tagsTable)
    .values({ name: tagName })
    .onConflictDoNothing()
    .returning();

  const tag = existingTag ?? (await db
    .select({ id: tagsTable.id })
    .from(tagsTable)
    .where(eq(tagsTable.name, tagName))
    .then(([r]) => r));

  if (!tag) {
    res.status(500).json({ error: "Failed to resolve tag" });
    return;
  }

  await db
    .insert(collectionTagsTable)
    .values({ collectionId: params.data.id, tagId: tag.id })
    .onConflictDoNothing();

  res.sendStatus(204);
});

router.delete("/collections/:id/tags/:tagName", requireOrgAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawTagName = Array.isArray(req.params.tagName) ? req.params.tagName[0] : req.params.tagName;

  const params = RemoveCollectionTagParams.safeParse({
    id: parseInt(rawId, 10),
    tagName: rawTagName,
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [collection] = await db
    .select({ id: collectionsTable.id, createdById: collectionsTable.createdById })
    .from(collectionsTable)
    .where(and(eq(collectionsTable.id, params.data.id), eq(collectionsTable.organizationId, req.org!.id)));
  if (!collection) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  if (!canManageItem(req, collection.createdById)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [tag] = await db
    .select({ id: tagsTable.id })
    .from(tagsTable)
    .where(eq(tagsTable.name, params.data.tagName));

  if (tag) {
    await db
      .delete(collectionTagsTable)
      .where(
        and(
          eq(collectionTagsTable.collectionId, params.data.id),
          eq(collectionTagsTable.tagId, tag.id),
        ),
      );
  }

  res.sendStatus(204);
});

export default router;
