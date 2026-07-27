import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { db, campaignsTable, type Campaign } from "@workspace/db";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { generateCampaignSuggestions } from "../lib/imageGeneration/campaignSuggestions";

// Campaigns (#192): text briefs that drive AI ad suggestions. Org-scoped; the
// suggestions themselves live in the campaign's image-generation session (see
// campaignSuggestions.ts), fetched via the existing session endpoint.

const router: IRouter = Router();

const CampaignBody = z.object({
  name: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(8000),
});

const CampaignPatchBody = CampaignBody.partial();

function serialize(c: Campaign) {
  return {
    id: c.id,
    name: c.name,
    brief: c.brief,
    sessionId: c.sessionId,
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
  const existing = await findOrgCampaign(id, req.org!.id);
  if (!existing) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  const [row] = await db
    .update(campaignsTable)
    .set({ ...body.data, updatedAt: new Date() })
    .where(eq(campaignsTable.id, id))
    .returning();
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
  // The generation session (and its outputs) survive — suggestions already
  // produced remain traceable in Create's session list.
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.sendStatus(204);
});

// Generate N (default 3) fresh suggestions from the brief. Returns pending
// generation rows immediately (#189 async flow); the client polls the session.
router.post("/campaigns/:id/generate", requireOrgAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const campaign = await findOrgCampaign(id, req.org!.id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  try {
    const result = await generateCampaignSuggestions(campaign, req.dbUser!.id, 3);
    res.json(result);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "Suggestion generation failed";
    if (status >= 500) req.log.error({ err: error }, "Campaign suggestion generation failed");
    res.status(status).json({ error: message });
  }
});

export default router;
