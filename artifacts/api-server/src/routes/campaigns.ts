import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, campaignsTable, type Campaign } from "@workspace/db";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { generateCampaignSuggestions, generateCampaignConcept } from "../lib/imageGeneration/campaignSuggestions";
import { generationRateLimit, sendGenerationError } from "../lib/imageGeneration/limits";
import { canManageItem } from "../lib/capabilities";

// Campaigns (#192): text briefs that drive AI ad suggestions. Org-scoped; the
// suggestions themselves live in the campaign's image-generation session (see
// campaignSuggestions.ts), fetched via the existing session endpoint.

const router: IRouter = Router();

const CampaignBody = z.object({
  name: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(8000),
});

// `expectedRevision` (#216): the brief revision the client edited. A stale one
// means another tab changed the brief since — refuse rather than overwrite it.
const CampaignPatchBody = CampaignBody.partial().extend({
  expectedRevision: z.number().int().positive().optional(),
});

// Generate from the brief on screen (#216): the brief is saved and the request
// claimed in ONE conditional UPDATE before any generation starts, so generation
// can never read an older brief, a failed/conflicting save starts nothing, and
// a repeated `requestId` (double click, client retry) starts nothing new. An
// empty body keeps the old contract: generate from the persisted brief.
const GenerateBody = z.object({
  brief: z.string().trim().min(1).max(8000).optional(),
  expectedRevision: z.number().int().positive().optional(),
  requestId: z.string().trim().min(8).max(100).optional(),
});

// Bump the revision only when the brief text actually changes. SET expressions
// see the pre-update row, so this compares against the stored brief.
function nextBriefRevision(brief: string): SQL {
  return sql`CASE WHEN ${campaignsTable.brief} IS DISTINCT FROM ${brief} THEN ${campaignsTable.briefRevision} + 1 ELSE ${campaignsTable.briefRevision} END`;
}

function conflictBody(current: Campaign) {
  return {
    error: "This brief was changed elsewhere since you started editing. Review the latest version before saving or generating.",
    conflict: true,
    brief: current.brief,
    briefRevision: current.briefRevision,
  };
}

function serialize(c: Campaign) {
  return {
    id: c.id,
    name: c.name,
    brief: c.brief,
    briefRevision: c.briefRevision,
    sessionId: c.sessionId,
    // Concepts held back for a missing photo/logo by the latest run (#215).
    needsInputConcepts: c.needsInputConcepts ?? [],
    createdById: c.createdById,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function findOrgCampaign(id: number, organizationId: number): Promise<Campaign | undefined> {
  const [row] = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, id), eq(campaignsTable.organizationId, organizationId)));
  return row;
}

router.get("/campaigns", requireOrgAuth, async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.organizationId, req.org!.id))
    .orderBy(desc(campaignsTable.updatedAt));
  res.json(rows.map(serialize));
});

router.post("/campaigns", requireOrgAuth, async (req: Request, res: Response) => {
  const body = CampaignBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Name and brief are required" });
    return;
  }
  const [row] = await db
    .insert(campaignsTable)
    .values({
      organizationId: req.org!.id,
      createdById: req.dbUser!.id,
      name: body.data.name,
      brief: body.data.brief,
    })
    .returning();
  res.status(201).json(serialize(row));
});

router.get("/campaigns/:id", requireOrgAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const row = await findOrgCampaign(id, req.org!.id);
  if (!row) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  res.json(serialize(row));
});

router.patch("/campaigns/:id", requireOrgAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const body = CampaignPatchBody.safeParse(req.body);
  if (!Number.isInteger(id) || !body.success) {
    res.status(400).json({ error: "Invalid campaign update" });
    return;
  }
  const { expectedRevision, ...fields } = body.data;
  // Someone else's campaign: only its creator or an org owner/admin (#218).
  const owned = await findOrgCampaign(id, req.org!.id);
  if (!owned) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (!canManageItem(req, owned.createdById)) {
    res.status(403).json({ error: "Only the campaign's creator or an organization owner/admin can change it" });
    return;
  }
  const conditions = [eq(campaignsTable.id, id), eq(campaignsTable.organizationId, req.org!.id)];
  if (expectedRevision != null) conditions.push(eq(campaignsTable.briefRevision, expectedRevision));
  const [row] = await db
    .update(campaignsTable)
    .set({
      ...fields,
      ...(fields.brief != null ? { briefRevision: nextBriefRevision(fields.brief) } : {}),
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();
  if (!row) {
    const existing = await findOrgCampaign(id, req.org!.id);
    if (!existing) res.status(404).json({ error: "Campaign not found" });
    else res.status(409).json(conflictBody(existing));
    return;
  }
  res.json(serialize(row));
});

router.delete("/campaigns/:id", requireOrgAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const existing = await findOrgCampaign(id, req.org!.id);
  if (!existing) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (!canManageItem(req, existing.createdById)) {
    res.status(403).json({ error: "Only the campaign's creator or an organization owner/admin can delete it" });
    return;
  }
  // The generation session (and its outputs) survive — suggestions already
  // produced remain traceable in Create's session list.
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.sendStatus(204);
});

// Generate N (default 3) fresh suggestions from the brief. Returns pending
// generation rows immediately (#189 async flow); the client polls the session.
router.post("/campaigns/:id/generate", requireOrgAuth, generationRateLimit, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const body = GenerateBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "The brief can't be empty (and must be under 8000 characters)" });
    return;
  }
  const { brief, expectedRevision, requestId } = body.data;
  // Someone else's campaign: only its creator or an org owner/admin (#218).
  const owned = await findOrgCampaign(id, req.org!.id);
  if (!owned) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (!canManageItem(req, owned.createdById)) {
    res.status(403).json({ error: "Only the campaign's creator or an organization owner/admin can change it" });
    return;
  }

  const conditions = [eq(campaignsTable.id, id), eq(campaignsTable.organizationId, req.org!.id)];
  if (expectedRevision != null) conditions.push(eq(campaignsTable.briefRevision, expectedRevision));
  if (requestId) conditions.push(sql`${campaignsTable.lastGenerateRequestId} IS DISTINCT FROM ${requestId}`);
  const [campaign] = await db
    .update(campaignsTable)
    .set({
      ...(brief != null ? { brief, briefRevision: nextBriefRevision(brief) } : {}),
      ...(requestId ? { lastGenerateRequestId: requestId } : {}),
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();
  if (!campaign) {
    const existing = await findOrgCampaign(id, req.org!.id);
    if (!existing) {
      res.status(404).json({ error: "Campaign not found" });
    } else if (requestId && existing.lastGenerateRequestId === requestId) {
      // Already accepted: answer like the original success, start nothing.
      res.json({ duplicate: true, sessionId: existing.sessionId, generations: [], concepts: [], brief: existing.brief, briefRevision: existing.briefRevision });
    } else {
      res.status(409).json(conflictBody(existing));
    }
    return;
  }
  try {
    const result = await generateCampaignSuggestions(campaign, req.dbUser!.id, 3, { requestId });
    res.json({ ...result, brief: campaign.brief, briefRevision: campaign.briefRevision });
  } catch (error) {
    // Nothing was accepted, so the same request may be retried. The brief save
    // stands — it's what the user asked to generate from.
    if (requestId) {
      await db
        .update(campaignsTable)
        .set({ lastGenerateRequestId: null })
        .where(and(eq(campaignsTable.id, id), eq(campaignsTable.lastGenerateRequestId, requestId)));
    }
    sendGenerationError(req, res, error, "Suggestion generation failed. Please try again.", "Campaign suggestion generation failed");
  }
});

// Continue ONE needs_input concept without its missing photo/logo (#215). The
// client sends back the concept the server returned (`resume`) plus the roles
// the person chose to go without; roles not listed still block it. Same
// permission and rate limit as generating.
const ConceptBody = z.object({
  concept: z.object({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(4000),
    format: z.string().trim().min(1).max(20),
    heroPhotoQuery: z.string().max(300).nullable(),
    useLogo: z.boolean(),
  }),
  acknowledgedMissing: z.array(z.enum(["hero_photo", "exact_asset"])).max(2).default([]),
});

router.post("/campaigns/:id/generate-concept", requireOrgAuth, generationRateLimit, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const body = ConceptBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid concept request" });
    return;
  }
  const campaign = await findOrgCampaign(id, req.org!.id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (!canManageItem(req, campaign.createdById)) {
    res.status(403).json({ error: "Only the campaign's creator or an organization owner/admin can change it" });
    return;
  }
  try {
    const result = await generateCampaignConcept(campaign, req.dbUser!.id, body.data.concept, body.data.acknowledgedMissing);
    res.json({ ...result, brief: campaign.brief, briefRevision: campaign.briefRevision });
  } catch (error) {
    sendGenerationError(req, res, error, "Suggestion generation failed. Please try again.", "Campaign concept generation failed");
  }
});

export default router;
