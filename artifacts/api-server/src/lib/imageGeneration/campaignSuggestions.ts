import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db, campaignsTable, imageGenerationSessionsTable, type Campaign } from "@workspace/db";
import { getOpenAIKeyForOrg } from "../aiProviders";
import { findPhotoCandidates, findDesignatedPrimaryLogo, REQUIRED_INPUT_MESSAGES, type RequiredInput } from "./plan";
import { runGeneration, GENERATION_FORMATS, type GenerationFormat, type RequestedInput, type RunGenerationResult } from "./orchestrate";
import { logger } from "../logger";
import { assertGenerationCapacity, GenerationLimitError } from "./limits";

// Campaign suggestions (#192): an LLM reads the campaign's text brief and
// proposes up to 3 DISTINCT ad concepts (unlike variants, which re-render one
// prompt). Each concept is grounded in the library — top matching hero photo
// and, when a logo makes sense, the top brand asset — then fired through the
// async generation pipeline into the campaign's own session.

const CONCEPT_MODEL = process.env.OPENAI_IMAGE_TEXT_MODEL || "gpt-5-mini";

export interface AdConcept {
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

export type AcknowledgedRole = RequiredInput["role"];

export interface CampaignConceptResult {
  title: string;
  /** "needs_input": a required photo/logo couldn't be grounded, so nothing was rendered (#215). */
  status: "generated" | "needs_input";
  missing?: RequiredInput[];
  /** needs_input only: everything needed to continue this concept without its missing inputs. */
  resume?: AdConcept;
}

export interface CampaignSuggestionResult {
  sessionId: number;
  generations: RunGenerationResult["generations"];
  concepts: CampaignConceptResult[];
  /** Things the user should know about the inputs, e.g. no primary logo. */
  notices: string[];
}

export const NO_PRIMARY_LOGO_NOTICE =
  "No primary logo is designated, so suggestions that need your logo were not generated. Mark your primary logo in Assets, or generate those suggestions without a logo.";

const LIMIT_NOTICE = "Only some suggestions were started because your organization hit its image generation limit. Generate again once these finish.";

const GROUNDING_FAILED_MESSAGE = "We couldn't search your library for this just now. Try again, or continue without it.";

/** Nearest supported canvas for a requested ratio like "16:9" ("1:1" if unparseable). */
export function nearestSupportedFormat(requested: string): GenerationFormat {
  if (Object.hasOwn(GENERATION_FORMATS, requested)) return requested as GenerationFormat;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(requested);
  const ratio = m ? Number(m[1]) / Number(m[2]) : NaN;
  if (!Number.isFinite(ratio) || ratio <= 0) return "1:1";
  let best: GenerationFormat = "1:1";
  let bestDistance = Infinity;
  for (const [id, f] of Object.entries(GENERATION_FORMATS) as [GenerationFormat, { size: string }][]) {
    const [w, h] = f.size.split("x").map(Number);
    const distance = Math.abs(Math.log(ratio / (w / h)));
    if (distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}

type PrimaryLogo = Awaited<ReturnType<typeof findDesignatedPrimaryLogo>>;

// Passing Lane A's optional run args (#215) through without depending on
// whether this base's RunGenerationArgs declares them yet.
type RunArgsWithFidelity = Parameters<typeof runGeneration>[0] & {
  acknowledgedMissing?: AcknowledgedRole[];
  requestedFormat?: string;
};

async function ensureCampaignSession(campaign: Campaign, userId: number): Promise<number> {
  if (campaign.sessionId != null) return campaign.sessionId;
  const [session] = await db
    .insert(imageGenerationSessionsTable)
    .values({
      organizationId: campaign.organizationId,
      userId,
      title: `Campaign: ${campaign.name}`.slice(0, 120),
    })
    .returning({ id: imageGenerationSessionsTable.id });
  await db
    .update(campaignsTable)
    .set({ sessionId: session.id, updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  return session.id;
}

/**
 * Ground one concept in the library: its best-matching hero photo (when it
 * asks for one) and the designated primary logo (when it wants a logo). An
 * input that can't be found is reported as missing — never silently dropped —
 * unless the person acknowledged going without that role.
 */
async function groundConcept(
  campaign: Campaign,
  concept: AdConcept,
  acknowledged: AcknowledgedRole[],
  logo: { value?: PrimaryLogo },
): Promise<{ inputs: RequestedInput[]; missing: RequiredInput[]; acknowledgedUsed: AcknowledgedRole[] }> {
  const inputs: RequestedInput[] = [];
  const missing: RequiredInput[] = [];
  const acknowledgedUsed: AcknowledgedRole[] = [];
  const handle = (role: AcknowledgedRole, slot: string, message: string) => {
    if (acknowledged.includes(role)) acknowledgedUsed.push(role);
    else missing.push({ role, slot, status: "missing", message });
  };

  if (concept.heroPhotoQuery?.trim()) {
    try {
      const [photo] = await findPhotoCandidates(campaign.organizationId, concept.heroPhotoQuery.trim());
      if (photo) inputs.push({ kind: "photo", refId: photo.refId, role: "hero_photo", name: photo.name });
      else handle("hero_photo", "Hero photo", REQUIRED_INPUT_MESSAGES.heroMissing);
    } catch (err) {
      logger.warn({ err, campaignId: campaign.id }, "Campaign concept photo grounding failed");
      handle("hero_photo", "Hero photo", GROUNDING_FAILED_MESSAGE);
    }
  }
  if (concept.useLogo) {
    // Only the designated primary mark is attached automatically (#206).
    try {
      if (logo.value === undefined) logo.value = await findDesignatedPrimaryLogo(campaign.organizationId);
      if (logo.value) inputs.push({ kind: "asset", refId: logo.value.refId, role: logo.value.role, name: logo.value.name });
      else handle("exact_asset", "Primary logo", REQUIRED_INPUT_MESSAGES.primaryLogoMissing);
    } catch (err) {
      logger.warn({ err, campaignId: campaign.id }, "Campaign concept logo grounding failed");
      handle("exact_asset", "Primary logo", GROUNDING_FAILED_MESSAGE);
    }
  }
  return { inputs, missing, acknowledgedUsed };
}

/** Ground and (when every required input is satisfied) start one concept. */
async function processConcept(
  campaign: Campaign,
  userId: number,
  sessionId: number,
  concept: AdConcept,
  acknowledged: AcknowledgedRole[],
  logo: { value?: PrimaryLogo },
  context: { requestId?: string },
): Promise<{ result: CampaignConceptResult; generations: RunGenerationResult["generations"] }> {
  const { inputs, missing, acknowledgedUsed } = await groundConcept(campaign, concept, acknowledged, logo);
  if (missing.length > 0) {
    return { result: { title: concept.title, status: "needs_input", missing, resume: concept }, generations: [] };
  }
  // An unsupported ratio is rendered on the nearest canvas and the request is
  // recorded alongside it — never relabelled (#215).
  const requestedFormat = concept.format.trim().slice(0, 20) || "1:1";
  const args: RunArgsWithFidelity = {
    organizationId: campaign.organizationId,
    userId,
    sessionId,
    prompt: `${concept.title}: ${concept.prompt}`,
    inputs,
    format: nearestSupportedFormat(requestedFormat),
    requestedFormat,
    variantCount: 1,
    ...(acknowledgedUsed.length > 0 ? { acknowledgedMissing: acknowledgedUsed } : {}),
    // Which brief revision (and request) this suggestion came from (#216),
    // so outputs stay attributable after the brief is edited again.
    settings: {
      campaignId: campaign.id,
      campaignBriefRevision: campaign.briefRevision,
      ...(context.requestId ? { campaignRequestId: context.requestId } : {}),
    },
  };
  const run = await runGeneration(args);
  return { result: { title: concept.title, status: "generated" }, generations: run.generations };
}

export async function generateCampaignSuggestions(
  campaign: Campaign,
  userId: number,
  count = 3,
  context: { requestId?: string } = {},
): Promise<CampaignSuggestionResult> {
  const key = await getOpenAIKeyForOrg(campaign.organizationId);
  if (!key) {
    throw Object.assign(new Error("No OpenAI API key configured for this organization — add one in AI settings."), {
      statusCode: 400,
    });
  }

  // Fail fast before paying for the concept LLM call; runGeneration reserves
  // the slots for real, one concept at a time.
  assertGenerationCapacity(campaign.organizationId, userId, count);
  const concepts = await generateConcepts(key, campaign.brief, count);
  if (concepts.length === 0) {
    throw Object.assign(new Error("No concepts could be derived from the brief — add more detail."), {
      statusCode: 422,
    });
  }

  // The campaign's dedicated session (lazily created + linked).
  const sessionId = await ensureCampaignSession(campaign, userId);

  // Ground each concept, then fire the (async) generation — pending rows
  // return immediately and the client polls the session. A concept whose
  // required inputs can't be grounded is NOT rendered: it comes back as
  // needs_input and the person decides (#215).
  const generations: RunGenerationResult["generations"] = [];
  const results: CampaignConceptResult[] = [];
  const logo: { value?: PrimaryLogo } = {};
  let limitHit = false;
  let started = 0;
  for (const concept of concepts) {
    try {
      const out = await processConcept(campaign, userId, sessionId, concept, [], logo, context);
      results.push(out.result);
      generations.push(...out.generations);
      if (out.result.status === "generated") started++;
    } catch (err) {
      // A concurrent request took the slots we pre-checked: keep what was
      // already queued rather than failing a half-started batch.
      if (err instanceof GenerationLimitError && started > 0) {
        limitHit = true;
        break;
      }
      throw err;
    }
  }

  await db.update(campaignsTable).set({ updatedAt: new Date() }).where(eq(campaignsTable.id, campaign.id));

  const missingLogo = results.some((r) => r.missing?.some((m) => m.role === "exact_asset" && m.message === REQUIRED_INPUT_MESSAGES.primaryLogoMissing));
  return {
    sessionId,
    generations,
    concepts: results,
    notices: [
      ...(missingLogo ? [NO_PRIMARY_LOGO_NOTICE] : []),
      ...(limitHit ? [LIMIT_NOTICE] : []),
    ],
  };
}

/**
 * Continue one needs_input concept (#215): the person chose to go without the
 * roles in `acknowledgedMissing`. Re-grounds the concept (a photo or logo added
 * since is used), then generates it. Roles not acknowledged still block it.
 */
export async function generateCampaignConcept(
  campaign: Campaign,
  userId: number,
  concept: AdConcept,
  acknowledgedMissing: AcknowledgedRole[],
  context: { requestId?: string } = {},
): Promise<CampaignSuggestionResult> {
  assertGenerationCapacity(campaign.organizationId, userId, 1);
  const sessionId = await ensureCampaignSession(campaign, userId);
  const out = await processConcept(campaign, userId, sessionId, concept, [...new Set(acknowledgedMissing)], {}, context);
  await db.update(campaignsTable).set({ updatedAt: new Date() }).where(eq(campaignsTable.id, campaign.id));
  return { sessionId, generations: out.generations, concepts: [out.result], notices: [] };
}
