import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db, campaignsTable, imageGenerationSessionsTable, type Campaign } from "@workspace/db";
import { getOpenAIKeyForOrg } from "../aiProviders";
import { findPhotoCandidates, findAssetCandidates } from "./plan";
import { runGeneration, GENERATION_FORMATS, type GenerationFormat, type RequestedInput, type RunGenerationResult } from "./orchestrate";
import { logger } from "../logger";

// Campaign suggestions (#192): an LLM reads the campaign's text brief and
// proposes up to 3 DISTINCT ad concepts (unlike variants, which re-render one
// prompt). Each concept is grounded in the library — top matching hero photo
// and, when a logo makes sense, the top brand asset — then fired through the
// async generation pipeline into the campaign's own session.

const CONCEPT_MODEL = process.env.OPENAI_IMAGE_TEXT_MODEL || "gpt-5-mini";

interface AdConcept {
  title: string;
  prompt: string;
  format: string;
  heroPhotoQuery: string | null;
  useLogo: boolean;
}

async function generateConcepts(
  key: { apiKey: string; baseURL: string | null },
  brief: string,
  count: number,
): Promise<AdConcept[]> {
  const client = new OpenAI({ apiKey: key.apiKey, baseURL: key.baseURL ?? undefined });
  const response = await client.chat.completions.create({
    model: CONCEPT_MODEL,
    max_completion_tokens: 2048,
    messages: [
      {
        role: "system",
        content:
          `You are a creative director generating ad concepts for an organization's marketing campaign, to be rendered by an AI image model using the organization's photo library. Given the campaign brief, propose exactly ${count} DISTINCT ad concepts — different angles, compositions and messages, not variations of one idea. For each concept return: title (short label); prompt (a complete, self-contained image-generation instruction including any headline text to render, visual style, mood and composition — incorporate the brief's specifics like event name, dates and location); format ('1:1' square, '2:3' portrait for social/story/flyer, '3:2' landscape for banners); heroPhotoQuery (a short visual search phrase to find real photography in the library to anchor the ad, or null if the concept is purely graphic); useLogo (true when the organization's logo should appear).`,
      },
      { role: "user", content: `Campaign brief:\n\n${brief}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ad_concepts",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            concepts: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  prompt: { type: "string" },
                  format: { type: "string" },
                  heroPhotoQuery: { type: ["string", "null"] },
                  useLogo: { type: "boolean" },
                },
                required: ["title", "prompt", "format", "heroPhotoQuery", "useLogo"],
              },
            },
          },
          required: ["concepts"],
        },
      },
    },
  });
  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Concept planning returned nothing — try again.");
  const parsed = JSON.parse(raw) as { concepts: AdConcept[] };
  return (parsed.concepts ?? []).slice(0, count);
}

export interface CampaignSuggestionResult {
  sessionId: number;
  generations: RunGenerationResult["generations"];
  concepts: { title: string }[];
}

export async function generateCampaignSuggestions(
  campaign: Campaign,
  userId: number,
  count = 3,
): Promise<CampaignSuggestionResult> {
  const key = await getOpenAIKeyForOrg(campaign.organizationId);
  if (!key) {
    throw Object.assign(new Error("No OpenAI API key configured for this organization — add one in AI settings."), {
      statusCode: 400,
    });
  }

  const concepts = await generateConcepts(key, campaign.brief, count);
  if (concepts.length === 0) {
    throw Object.assign(new Error("No concepts could be derived from the brief — add more detail."), {
      statusCode: 422,
    });
  }

  // The campaign's dedicated session (lazily created + linked).
  let sessionId = campaign.sessionId;
  if (sessionId == null) {
    const [session] = await db
      .insert(imageGenerationSessionsTable)
      .values({
        organizationId: campaign.organizationId,
        userId,
        title: `Campaign: ${campaign.name}`.slice(0, 120),
      })
      .returning({ id: imageGenerationSessionsTable.id });
    sessionId = session.id;
    await db
      .update(campaignsTable)
      .set({ sessionId, updatedAt: new Date() })
      .where(eq(campaignsTable.id, campaign.id));
  }

  // Ground each concept in the library: best-matching hero photo + top brand
  // asset when a logo is wanted. Then fire the (async) generation — pending
  // rows return immediately and the client polls the session.
  const generations: RunGenerationResult["generations"] = [];
  for (const concept of concepts) {
    const inputs: RequestedInput[] = [];
    try {
      if (concept.heroPhotoQuery?.trim()) {
        const [photo] = await findPhotoCandidates(campaign.organizationId, concept.heroPhotoQuery.trim());
        if (photo) inputs.push({ kind: "photo", refId: photo.refId, role: "hero_photo", name: photo.name });
      }
      if (concept.useLogo) {
        const [asset] = await findAssetCandidates(campaign.organizationId, "logo");
        if (asset) inputs.push({ kind: "asset", refId: asset.refId, role: asset.role, name: asset.name });
      }
    } catch (err) {
      logger.warn({ err, campaignId: campaign.id }, "Campaign concept grounding failed — generating without inputs");
    }

    const format: GenerationFormat = (concept.format in GENERATION_FORMATS ? concept.format : "1:1") as GenerationFormat;
    const result = await runGeneration({
      organizationId: campaign.organizationId,
      userId,
      sessionId,
      prompt: `${concept.title}: ${concept.prompt}`,
      inputs,
      format,
      variantCount: 1,
    });
    generations.push(...result.generations);
  }

  await db.update(campaignsTable).set({ updatedAt: new Date() }).where(eq(campaignsTable.id, campaign.id));

  return { sessionId, generations, concepts: concepts.map((c) => ({ title: c.title })) };
}
