import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import sharp from "sharp";
import { and, desc, asc, eq } from "drizzle-orm";
import { db, imageGenerationSessionsTable, imageGenerationsTable, type ImageGeneration } from "@workspace/db";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { runGeneration, GENERATION_FORMATS, type GenerationFormat } from "../lib/imageGeneration/orchestrate";
import { planGeneration } from "../lib/imageGeneration/plan";

// AI image generation — the Create workspace backend (#167). All routes are
// org-scoped; generation itself runs on the org's own OpenAI key.

const router: IRouter = Router();
const storageService = new ObjectStorageService();

const GenerateBody = z.object({
  sessionId: z.number().int().positive().optional(),
  parentGenerationId: z.number().int().positive().optional(),
  prompt: z.string().trim().min(1).max(4000),
  // Optional so revisions can inherit the parent's format; passing one on a
  // revision re-renders the design on that canvas.
  format: z.enum(Object.keys(GENERATION_FORMATS) as [GenerationFormat, ...GenerationFormat[]]).optional(),
  variantCount: z.number().int().min(1).max(3).default(1),
  inputs: z
    .array(
      z.object({
        kind: z.enum(["upload", "photo", "asset"]),
        refId: z.number().int().positive().optional(),
        storageKey: z.string().startsWith("/objects/").optional(),
        role: z.enum(["style", "hero_photo", "exact_asset"]),
        name: z.string().max(200).optional(),
      }),
    )
    .max(8)
    .default([]),
});

function serializeGeneration(g: ImageGeneration) {
  return {
    id: g.id,
    sessionId: g.sessionId,
    parentGenerationId: g.parentGenerationId,
    prompt: g.prompt,
    settings: g.settings,
    inputs: g.inputs,
    usageNotesSnapshot: g.usageNotesSnapshot,
    storageKey: g.storageKey,
    // Served through the org-ACL'd private-object route, so <img> tags work.
    imageUrl: g.storageKey ? `/api/storage${g.storageKey}` : null,
    contentType: g.contentType,
    width: g.width,
    height: g.height,
    status: g.status,
    error: g.error,
    createdAt: g.createdAt instanceof Date ? g.createdAt.toISOString() : String(g.createdAt),
  };
}

const PlanBody = z.object({
  prompt: z.string().trim().min(1).max(4000),
  attachedNames: z.array(z.string().max(200)).max(8).default([]),
});

// Collaborative planning (#167 §3–4): analyze the prompt, propose library
// candidates and clarifying questions. Read-only — generates nothing.
router.post("/image-generation/plan", requireOrgAuth, async (req: Request, res: Response) => {
  const body = PlanBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid plan request" });
    return;
  }
  try {
    const plan = await planGeneration(req.org!.id, body.data.prompt, body.data.attachedNames);
    res.json(plan);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Planning failed";
    if (status >= 500) req.log.error({ err: error }, "Generation planning failed");
    res.status(status).json({ error: message });
  }
});

// Generate one or more variants (or revise an earlier output). Synchronous:
// the client waits — an image call takes roughly 15–60s per variant.
router.post("/image-generation/generate", requireOrgAuth, async (req: Request, res: Response) => {
  const body = GenerateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid generation request" });
    return;
  }
  try {
    const result = await runGeneration({
      organizationId: req.org!.id,
      userId: req.dbUser!.id,
      sessionId: body.data.sessionId,
      parentGenerationId: body.data.parentGenerationId,
      prompt: body.data.prompt,
      format: body.data.format,
      variantCount: body.data.variantCount,
      inputs: body.data.inputs,
    });
    res.json({
      sessionId: result.sessionId,
      generations: result.generations.map(serializeGeneration),
    });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Generation failed";
    if (status >= 500) req.log.error({ err: error }, "Image generation request failed");
    res.status(status).json({ error: message });
  }
});

router.get("/image-generation/sessions", requireOrgAuth, async (req: Request, res: Response) => {
  const sessions = await db
    .select()
    .from(imageGenerationSessionsTable)
    .where(eq(imageGenerationSessionsTable.organizationId, req.org!.id))
    .orderBy(desc(imageGenerationSessionsTable.updatedAt))
    .limit(30);
  res.json(
    sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
  );
});

router.get("/image-generation/sessions/:id", requireOrgAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  const [session] = await db
    .select()
    .from(imageGenerationSessionsTable)
    .where(
      and(eq(imageGenerationSessionsTable.id, id), eq(imageGenerationSessionsTable.organizationId, req.org!.id)),
    );
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const generations = await db
    .select()
    .from(imageGenerationsTable)
    .where(eq(imageGenerationsTable.sessionId, id))
    .orderBy(asc(imageGenerationsTable.createdAt));
  res.json({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    generations: generations.map(serializeGeneration),
  });
});

// Download a generated image as PNG (stored format) or JPG (converted).
router.get("/image-generation/:id/download", requireOrgAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid generation id" });
    return;
  }
  const format = req.query.format === "jpg" ? "jpg" : "png";
  const [gen] = await db
    .select()
    .from(imageGenerationsTable)
    .where(and(eq(imageGenerationsTable.id, id), eq(imageGenerationsTable.organizationId, req.org!.id)));
  if (!gen?.storageKey) {
    res.status(404).json({ error: "Generated image not found" });
    return;
  }
  try {
    const file = await storageService.getObjectEntityFile(gen.storageKey);
    const [buffer] = await file.download();
    const output = format === "jpg" ? await sharp(buffer as Buffer).jpeg({ quality: 92 }).toBuffer() : (buffer as Buffer);
    res.setHeader("Content-Type", format === "jpg" ? "image/jpeg" : "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="vispix-generation-${gen.id}.${format}"`);
    res.send(output);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Generated image not found" });
      return;
    }
    req.log.error({ err: error }, "Generated image download failed");
    res.status(500).json({ error: "Download failed" });
  }
});

export default router;
