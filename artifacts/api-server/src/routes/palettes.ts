import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, designPalettesTable, type DesignPalette } from "@workspace/db";
import { SavedPaletteInputSchema, type HarmonyRule, type RoleAssignment, type SavedPalette } from "@workspace/api-zod/palette";
import { requireAdmin } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

// Saved palettes (#257). Platform-wide, superadmin only.
const router: IRouter = Router();

// Bounds storage; the palette tool is a handful of curated sets.
const MAX_PALETTES = 200;

function serialize(row: DesignPalette): SavedPalette {
  return {
    id: row.id,
    name: row.name,
    swatches: row.swatches,
    roles: row.roles as RoleAssignment,
    harmony: row.harmony as HarmonyRule | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseId(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= 2147483647 ? n : null;
}

router.get("/platform/palettes", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(designPalettesTable).orderBy(desc(designPalettesTable.updatedAt), desc(designPalettesTable.id));
  res.json(rows.map(serialize));
});

router.post("/platform/palettes", requireAdmin, async (req, res): Promise<void> => {
  const body = SavedPaletteInputSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid palette", issues: body.error.issues });
    return;
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(designPalettesTable);
  if (count >= MAX_PALETTES) {
    res.status(409).json({ error: `Palette limit reached (${MAX_PALETTES}). Delete one to save another.` });
    return;
  }
  const [row] = await db
    .insert(designPalettesTable)
    .values({ ...body.data, createdByUserId: req.dbUser?.id ?? null })
    .returning();
  logger.info({ userId: req.dbUser?.id, paletteId: row.id }, "Palette saved");
  res.status(201).json(serialize(row));
});

router.put("/platform/palettes/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(404).json({ error: "Palette not found" });
    return;
  }
  const body = SavedPaletteInputSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid palette", issues: body.error.issues });
    return;
  }
  const [row] = await db
    .update(designPalettesTable)
    .set({ ...body.data, updatedAt: new Date() })
    .where(eq(designPalettesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Palette not found" });
    return;
  }
  logger.info({ userId: req.dbUser?.id, paletteId: id }, "Palette updated");
  res.json(serialize(row));
});

router.delete("/platform/palettes/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const deleted = id === null ? [] : await db.delete(designPalettesTable).where(eq(designPalettesTable.id, id)).returning({ id: designPalettesTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Palette not found" });
    return;
  }
  logger.info({ userId: req.dbUser?.id, paletteId: id }, "Palette deleted");
  res.status(204).end();
});

export default router;
