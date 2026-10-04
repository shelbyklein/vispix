import OpenAI from "openai";
import { and, eq, ilike, inArray, isNull } from "drizzle-orm";
import { db, photosTable, assetsTable, projectsTable, photoAiEvaluationsTable } from "@workspace/db";
import { rankBrandAssets, type MatchConfidence } from "./assetRanking";
import { retrievePhotos } from "../photoRetrieval";
import { loadUsageRights, type UsageRights } from "../usageRights";
import { getOpenAIKeyForOrg } from "../aiProviders";
import { GENERATION_FORMATS, type GenerationFormat } from "./orchestrate";
import { logger } from "../logger";

// Collaborative planning for the Create workspace (#167 §3–4): before
// generating, an LLM reads the prompt, works out what inputs the graphic needs,
// searches the org's library for candidates (hero photos semantically, brand
// assets by keyword), and surfaces clarifying questions. The user picks from
// the proposals and then generates — the planner never generates by itself.

const PLANNER_MODEL = process.env.OPENAI_IMAGE_TEXT_MODEL || "gpt-5-mini";
const MAX_CANDIDATES = 6;

export interface PlanCandidate {
  kind: "photo" | "asset";
  refId: number;
  name: string;
  previewUrl: string;
  role: "style" | "hero_photo" | "exact_asset";
  // Asset candidates (#206): what the asset is and why it was suggested.
  variant?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
  reasons?: string[];
  confidence?: MatchConfidence;
  // Photo candidates (#207): rights at planning time (warning-only — a
  // not_recorded photo is still offered) and AI quality, null when the photo
  // hasn't been evaluated.
  usageRights?: UsageRights;
  quality?: { overallScore: number } | null;
}

export interface CandidateSlot {
  /** Human label for what this slot supplies, e.g. "Hero photo". */
  slot: string;
  role: PlanCandidate["role"];
  /** What the planner searched for — shown so the user understands the picks. */
  query: string;
  items: PlanCandidate[];
}

export interface GenerationPlan {
  summary: string;
  questions: string[];
  suggestedFormat: GenerationFormat | null;
  slots: CandidateSlot[];
}

interface PlannerOutput {
  summary: string;
  clarifyingQuestions: string[];
  heroPhotoQuery: string | null;
  brandAssetQuery: string | null;
  suggestedFormat: string | null;
}

async function callPlanner(
  key: { apiKey: string; baseURL: string | null },
  prompt: string,
  attachedNames: string[],
): Promise<PlannerOutput | null> {
  const client = new OpenAI({ apiKey: key.apiKey, baseURL: key.baseURL ?? undefined });
  const attachedBlock = attachedNames.length
    ? `The user has already attached: ${attachedNames.join(", ")}.`
    : "The user has attached nothing yet.";
  try {
    const response = await client.chat.completions.create({
      model: PLANNER_MODEL,
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are a creative director planning an AI-generated marketing graphic that will be produced from the organization's photo and brand-asset library. Given the user's request, decide what inputs would improve the result and what context is missing. Respond with: (1) summary — one sentence describing the graphic you understand they want; (2) clarifyingQuestions — up to 3 short questions, ONLY for genuinely missing context that changes the output (event name, date, tone, text to include); empty if the request is clear; (3) heroPhotoQuery — when real photography would anchor the graphic and none is attached, a short visual search phrase for the photo library (e.g. 'archer celebrating win close-up'), else null; (4) brandAssetQuery — when a logo/brand mark should appear and none is attached, a 1-3 word search for the asset library, else null; (5) suggestedFormat — one of '1:1', '2:3', '3:2' when the request implies an orientation (social post/story/flyer → '2:3' portrait, banner/header/wide social card → '3:2' landscape, profile/album art → '1:1' square), else null.",
        },
        { role: "user", content: `${attachedBlock}\n\nRequest: ${prompt}` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "generation_plan",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              clarifyingQuestions: { type: "array", items: { type: "string" }, maxItems: 3 },
              heroPhotoQuery: { type: ["string", "null"] },
              brandAssetQuery: { type: ["string", "null"] },
              suggestedFormat: { type: ["string", "null"] },
            },
            required: ["summary", "clarifyingQuestions", "heroPhotoQuery", "brandAssetQuery", "suggestedFormat"],
          },
        },
      },
    });
    const raw = response.choices[0]?.message?.content;
    return raw ? (JSON.parse(raw) as PlannerOutput) : null;
  } catch (err) {
    logger.error({ err }, "Generation planner LLM call failed");
    return null;
  }
}

/**
 * Hero-photo candidates from the shared retrieval service (#213): concept
 * ranking, identical to web and MCP search for the same query. When the
 * embedding provider is unavailable, falls back to keyword retrieval.
 */
export async function findPhotoCandidates(organizationId: number, query: string): Promise<PlanCandidate[]> {
  const request = { organizationId, canSeeHidden: false, text: query, limit: MAX_CANDIDATES };
  let result = await retrievePhotos({ ...request, mode: "concept" });
  if (result.status === "unavailable") {
    logger.warn({ reason: result.degraded?.reason }, "Concept retrieval unavailable; hero photo candidates fall back to keyword");
    result = await retrievePhotos({ ...request, mode: "keyword" });
  }
  const ids = result.items.map((i) => i.photoId);
  if (ids.length === 0) return [];
  const [rows, rights, evaluations] = await Promise.all([
    db
      .select({ id: photosTable.id, filename: photosTable.filename, url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
      .from(photosTable)
      .where(inArray(photosTable.id, ids)),
    loadUsageRights(ids, organizationId),
    db
      .select({ photoId: photoAiEvaluationsTable.photoId, overallScore: photoAiEvaluationsTable.overallScore })
      .from(photoAiEvaluationsTable)
      .where(inArray(photoAiEvaluationsTable.photoId, ids)),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const scoreById = new Map(evaluations.map((e) => [e.photoId, e.overallScore]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      kind: "photo" as const,
      refId: r.id,
      name: r.filename ?? `photo-${r.id}`,
      previewUrl: r.thumbnailKey ? `/api/storage${r.thumbnailKey}` : r.url,
      role: "hero_photo" as const,
      usageRights: rights.get(r.id)!,
      quality: scoreById.has(r.id) ? { overallScore: Math.round(scoreById.get(r.id)! * 10) / 10 } : null,
    }));
}

// Image assets of an org, with what ranking needs.
async function loadRankableAssets(organizationId: number) {
  return db
    .select({
      id: assetsTable.id,
      name: assetsTable.name,
      kind: assetsTable.kind,
      variant: assetsTable.variant,
      notes: assetsTable.notes,
      projectId: assetsTable.projectId,
      projectName: projectsTable.name,
      isPrimary: assetsTable.isPrimary,
      storageKey: assetsTable.storageKey,
    })
    .from(assetsTable)
    .leftJoin(projectsTable, eq(projectsTable.id, assetsTable.projectId))
    .where(and(eq(assetsTable.organizationId, organizationId), ilike(assetsTable.contentType, "image/%")));
}

/**
 * Asset candidates for a request, ranked by the designated primary mark,
 * requested variant, identity words and project (#206) — never "any brand
 * asset, alphabetically". Each carries its variant, notes and match reasons so
 * the user can see why it was suggested. Reference assets appear only when
 * they actually match the request.
 */
export async function findAssetCandidates(
  organizationId: number,
  query: string,
  opts: { projectId?: number | null } = {},
): Promise<PlanCandidate[]> {
  const rows = await loadRankableAssets(organizationId);
  return rankBrandAssets(rows, query, opts)
    .filter((r) => r.asset.kind === "brand" || r.score > 1)
    .slice(0, MAX_CANDIDATES)
    .map((r) => ({
      kind: "asset" as const,
      refId: r.asset.id,
      name: r.asset.name,
      previewUrl: `/api/storage${r.asset.storageKey}`,
      role: r.asset.kind === "brand" ? ("exact_asset" as const) : ("style" as const),
      variant: r.asset.variant,
      notes: r.asset.notes,
      isPrimary: r.isEffectivePrimary,
      reasons: r.reasons,
      confidence: r.confidence,
    }));
}

/**
 * The logo an automatic flow (Campaigns) may attach without asking: the
 * organization's designated primary mark, or none (#206). Never falls back to
 * an arbitrary brand asset.
 */
export async function findDesignatedPrimaryLogo(organizationId: number): Promise<PlanCandidate | null> {
  const [row] = await db
    .select({ id: assetsTable.id, name: assetsTable.name, storageKey: assetsTable.storageKey, variant: assetsTable.variant })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.organizationId, organizationId),
        eq(assetsTable.isPrimary, true),
        isNull(assetsTable.projectId),
        eq(assetsTable.kind, "brand"),
        ilike(assetsTable.contentType, "image/%"),
      ),
    )
    .limit(1);
  return row
    ? {
        kind: "asset",
        refId: row.id,
        name: row.name,
        previewUrl: `/api/storage${row.storageKey}`,
        role: "exact_asset",
        variant: row.variant,
        isPrimary: true,
        reasons: ["Designated primary logo"],
        confidence: "high",
      }
    : null;
}

export async function planGeneration(
  organizationId: number,
  prompt: string,
  attachedNames: string[],
): Promise<GenerationPlan> {
  const key = await getOpenAIKeyForOrg(organizationId);
  if (!key) {
    throw Object.assign(new Error("No OpenAI API key configured for this organization — add one in AI settings."), {
      statusCode: 400,
    });
  }

  const planned = await callPlanner(key, prompt, attachedNames);
  if (!planned) {
    throw Object.assign(new Error("Planning failed — try again or generate directly."), { statusCode: 502 });
  }

  const slots: CandidateSlot[] = [];
  const [photoItems, assetItems] = await Promise.all([
    planned.heroPhotoQuery?.trim() ? findPhotoCandidates(organizationId, planned.heroPhotoQuery.trim()) : Promise.resolve([]),
    planned.brandAssetQuery?.trim() ? findAssetCandidates(organizationId, planned.brandAssetQuery.trim()) : Promise.resolve([]),
  ]);
  if (planned.heroPhotoQuery?.trim()) {
    slots.push({ slot: "Hero photo", role: "hero_photo", query: planned.heroPhotoQuery.trim(), items: photoItems });
  }
  if (planned.brandAssetQuery?.trim()) {
    slots.push({ slot: "Brand asset", role: "exact_asset", query: planned.brandAssetQuery.trim(), items: assetItems });
  }

  const suggestedFormat =
    planned.suggestedFormat && Object.hasOwn(GENERATION_FORMATS, planned.suggestedFormat)
      ? (planned.suggestedFormat as GenerationFormat)
      : null;

  return {
    summary: planned.summary,
    questions: (planned.clarifyingQuestions ?? []).map((q) => String(q)).filter(Boolean).slice(0, 3),
    suggestedFormat,
    slots,
  };
}
