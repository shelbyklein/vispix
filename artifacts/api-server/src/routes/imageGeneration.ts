import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import sharp from "sharp";
import { and, desc, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  db,
  imageGenerationSessionsTable,
  imageGenerationsTable,
  campaignsTable,
  usersTable,
  type ImageGeneration,
} from "@workspace/db";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { runGeneration, GENERATION_FORMATS, type GenerationFormat } from "../lib/imageGeneration/orchestrate";
import { planGeneration, type RequiredInput } from "../lib/imageGeneration/plan";
import { canSeeHiddenPhotos } from "../lib/capabilities";
import { loadGenerationView, redactInputs, redactRights, redactUsageNotes, type GenerationView } from "../lib/imageGeneration/redact";
import { generationProvenance, visibleHeroPhotos } from "../lib/imageGeneration/provenance";
import { generationRateLimit, sendGenerationError, GENERIC_GENERATION_ERROR } from "../lib/imageGeneration/limits";

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
  // #215: required inputs the person explicitly chose to go without. The
  // server records them; it doesn't re-derive requirements from the client.
  acknowledgedMissing: z
    .array(z.enum(["hero_photo", "exact_asset"]))
    .max(4)
    .optional()
    .transform((roles) => (roles ? [...new Set(roles)] : [])),
  // #215: the plan's required inputs, sent by clients that planned first
  // (Create). When present the server enforces them; callers without a plan
  // (MCP, direct API, revisions) omit it and are not checked.
  requiredInputs: z
    .array(
      z.object({
        role: z.enum(["hero_photo", "exact_asset"]),
        slot: z.string().max(100),
        status: z.enum(["found", "missing", "ambiguous"]),
        message: z.string().max(400),
      }),
    )
    .max(4)
    .optional(),
});

function serializeGeneration(g: ImageGeneration, view: GenerationView) {
  return {
    id: g.id,
    sessionId: g.sessionId,
    parentGenerationId: g.parentGenerationId,
    prompt: g.prompt,
    settings: g.settings,
    inputs: redactInputs(g.inputs ?? [], view),
    usageNotesSnapshot: redactUsageNotes(g.usageNotesSnapshot ?? [], g, view),
    storageKey: g.storageKey,
    // Served through the org-ACL'd private-object route, so <img> tags work.
    imageUrl: g.storageKey ? `/api/storage${g.storageKey}` : null,
    contentType: g.contentType,
    width: g.width,
    height: g.height,
    status: g.status,
    error: g.error,
    createdAt: g.createdAt instanceof Date ? g.createdAt.toISOString() : String(g.createdAt),
    // How it was made (#215): composition, photo treatment, grounding, format, model.
    fidelity: generationProvenance(g, { canSeeHidden: view.canSeeHidden }),
  };
}

const PlanBody = z.object({
  prompt: z.string().trim().min(1).max(4000),
  attachedNames: z.array(z.string().max(200)).max(8).default([]),
});

// Collaborative planning (#167 §3–4): analyze the prompt, propose library
// candidates and clarifying questions. Read-only — generates nothing.
router.post("/image-generation/plan", requireOrgAuth, generationRateLimit, async (req: Request, res: Response) => {
  const body = PlanBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid plan request" });
    return;
  }
  try {
    const plan = await planGeneration(req.org!.id, body.data.prompt, body.data.attachedNames);
    res.json(plan);
  } catch (error) {
    sendGenerationError(req, res, error, "Planning failed — try again or generate directly.", "Generation planning failed");
  }
});

// Generate one or more variants (or revise an earlier output). Synchronous:
// the client waits — an image call takes roughly 15–60s per variant.
router.post("/image-generation/generate", requireOrgAuth, generationRateLimit, async (req: Request, res: Response) => {
  const body = GenerateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid generation request" });
    return;
  }
  if (body.data.requiredInputs) {
    const attachedRoles = new Set<string>(body.data.inputs.map((i) => i.role));
    const acknowledged = new Set<string>(body.data.acknowledgedMissing);
    const unresolved = body.data.requiredInputs.filter(
      (r) => !attachedRoles.has(r.role) && !acknowledged.has(r.role),
    );
    if (unresolved.length > 0) {
      // Same shape as the client's InputRequiredError.
      const refusal: { error: string; code: "input_required"; missing: RequiredInput[] } = {
        error: "A required input is missing",
        code: "input_required",
        missing: unresolved,
      };
      res.status(409).json(refusal);
      return;
    }
  }
  try {
    // acknowledgedMissing is a Lane A run arg (#215); typed so this compiles
    // whether or not RunGenerationArgs declares it yet.
    const args: Parameters<typeof runGeneration>[0] & { acknowledgedMissing?: ("hero_photo" | "exact_asset")[] } = {
      organizationId: req.org!.id,
      userId: req.dbUser!.id,
      sessionId: body.data.sessionId,
      parentGenerationId: body.data.parentGenerationId,
      prompt: body.data.prompt,
      format: body.data.format,
      variantCount: body.data.variantCount,
      inputs: body.data.inputs,
      canSeeHidden: canSeeHiddenPhotos(req),
      ...(body.data.acknowledgedMissing.length > 0 ? { acknowledgedMissing: body.data.acknowledgedMissing } : {}),
    };
    const result = await runGeneration(args);
    const view = await loadGenerationView(req.org!.id, canSeeHiddenPhotos(req), result.generations);
    res.json({
      sessionId: result.sessionId,
      generations: result.generations.map((g) => serializeGeneration(g, view)),
    });
  } catch (error) {
    sendGenerationError(req, res, error, GENERIC_GENERATION_ERROR, "Image generation request failed");
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
  const view = await loadGenerationView(req.org!.id, canSeeHiddenPhotos(req), generations);
  res.json({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    generations: generations.map((g) => serializeGeneration(g, view)),
  });
});

// Past generations (#194): a read-only gallery of every image the org has
// generated, newest first. This is a view over image_generations ONLY — it never
// touches photos, so generated images stay outside the AI analysis, evaluation,
// embedding and search pipeline. Keyset paging on (createdAt, id).
const AllGenerationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(100).optional(),
  includeFailed: z.enum(["true", "false"]).default("false"),
});

function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: number } | null {
  const [iso, rawId] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(iso ?? "");
  const id = Number(rawId);
  if (Number.isNaN(createdAt.getTime()) || !Number.isInteger(id)) return null;
  return { createdAt, id };
}

router.get("/image-generation/all", requireOrgAuth, async (req: Request, res: Response) => {
  const query = AllGenerationsQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const { limit, cursor, includeFailed } = query.data;
  const orgId = req.org!.id;
  const conditions = [
    eq(imageGenerationsTable.organizationId, orgId),
    inArray(imageGenerationsTable.status, includeFailed === "true" ? ["succeeded", "failed"] : ["succeeded"]),
  ];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
    // The cursor carries millisecond precision (JS Date) while Postgres stores
    // microseconds, so compare at millisecond precision or same-batch rows drop.
    const createdMs = sql`date_trunc('milliseconds', ${imageGenerationsTable.createdAt})`;
    conditions.push(
      or(sql`${createdMs} < ${decoded.createdAt.toISOString()}::timestamptz`, and(sql`${createdMs} = ${decoded.createdAt.toISOString()}::timestamptz`, lt(imageGenerationsTable.id, decoded.id)))!,
    );
  }
  const rows = await db
    .select({
      gen: imageGenerationsTable,
      sessionTitle: imageGenerationSessionsTable.title,
      creatorId: usersTable.id,
      creatorName: usersTable.name,
      campaignId: campaignsTable.id,
      campaignName: campaignsTable.name,
    })
    .from(imageGenerationsTable)
    .innerJoin(imageGenerationSessionsTable, eq(imageGenerationSessionsTable.id, imageGenerationsTable.sessionId))
    .leftJoin(usersTable, eq(usersTable.id, imageGenerationSessionsTable.userId))
    .leftJoin(
      campaignsTable,
      and(eq(campaignsTable.sessionId, imageGenerationsTable.sessionId), eq(campaignsTable.organizationId, orgId)),
    )
    .where(and(...conditions))
    // Order on the same millisecond-truncated time the cursor compares, so rows
    // sharing a millisecond are ordered by id on both sides of a page boundary.
    .orderBy(desc(sql`date_trunc('milliseconds', ${imageGenerationsTable.createdAt})`), desc(imageGenerationsTable.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const view = await loadGenerationView(orgId, canSeeHiddenPhotos(req), page.map((r) => r.gen));
  const last = page[page.length - 1];
  res.json({
    items: page.map((r) => {
      const settings = r.gen.settings as { format?: string; size?: string; quality?: string };
      return {
        id: r.gen.id,
        imageUrl: r.gen.storageKey ? `/api/storage${r.gen.storageKey}` : null,
        prompt: r.gen.prompt,
        format: settings.format ?? null,
        width: r.gen.width,
        height: r.gen.height,
        status: r.gen.status,
        createdAt: r.gen.createdAt.toISOString(),
        // Rights of each photo input, frozen at generation time (#207).
        rightsConsidered: redactRights(r.gen.rightsSnapshot ?? [], view),
        fidelity: generationProvenance(r.gen, { canSeeHidden: view.canSeeHidden }),
        heroPhotos: visibleHeroPhotos(r.gen.inputs ?? [], view),
        creator: r.creatorId != null ? { id: r.creatorId, name: r.creatorName } : null,
        source: r.campaignId != null
          ? { type: "campaign" as const, sessionId: r.gen.sessionId, sessionTitle: r.sessionTitle, campaignId: r.campaignId, campaignName: r.campaignName }
          : { type: "session" as const, sessionId: r.gen.sessionId, sessionTitle: r.sessionTitle, campaignId: null, campaignName: null },
      };
    }),
    nextCursor: rows.length > limit && last ? encodeCursor(last.gen.createdAt, last.gen.id) : null,
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
