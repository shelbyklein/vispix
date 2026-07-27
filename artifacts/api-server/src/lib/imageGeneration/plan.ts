import OpenAI from "openai";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, photosTable, assetsTable, photoEmbeddingsTable } from "@workspace/db";
import { embedText } from "../aiEmbedding";
import { withIterativeVectorScan } from "../vectorSearch";
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

/** Semantic photo candidates, falling back to keyword when embeddings are off. */
export async function findPhotoCandidates(organizationId: number, query: string): Promise<PlanCandidate[]> {
  let ids: number[] = [];
  const vec = await embedText(query);
  if (vec) {
    const vecLiteral = `[${vec.join(",")}]`;
    const rows = await withIterativeVectorScan((tx) =>
      tx
        .select({ id: photoEmbeddingsTable.photoId })
        .from(photoEmbeddingsTable)
        .innerJoin(photosTable, eq(photosTable.id, photoEmbeddingsTable.photoId))
        .where(and(eq(photosTable.organizationId, organizationId), eq(photosTable.isHidden, false)))
        .orderBy(sql`${photoEmbeddingsTable.embedding} <=> ${vecLiteral}::vector`)
        .limit(MAX_CANDIDATES),
    );
    ids = rows.map((r) => r.id);
  } else {
    const words = query.split(/\s+/).filter(Boolean);
    const rows = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(
        and(
          eq(photosTable.organizationId, organizationId),
          eq(photosTable.isHidden, false),
          or(...words.map((w) => ilike(photosTable.aiDescription, `%${w}%`))),
        ),
      )
      .limit(MAX_CANDIDATES);
    ids = rows.map((r) => r.id);
  }
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: photosTable.id, filename: photosTable.filename, url: photosTable.url, thumbnailKey: photosTable.thumbnailKey })
    .from(photosTable)
    .where(inArray(photosTable.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      kind: "photo" as const,
      refId: r.id,
      name: r.filename ?? `photo-${r.id}`,
      previewUrl: r.thumbnailKey ? `/api/storage${r.thumbnailKey}` : r.url,
      role: "hero_photo" as const,
    }));
}

export async function findAssetCandidates(organizationId: number, query: string): Promise<PlanCandidate[]> {
  const pattern = `%${query.trim()}%`;
  const rows = await db
    .select({ id: assetsTable.id, name: assetsTable.name, storageKey: assetsTable.storageKey, kind: assetsTable.kind, contentType: assetsTable.contentType })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.organizationId, organizationId),
        ilike(assetsTable.contentType, "image/%"),
        or(ilike(assetsTable.name, pattern), eq(assetsTable.kind, "brand")),
      ),
    )
    // Brand assets (logos) first — they're what the planner usually wants.
    .orderBy(sql`CASE WHEN ${assetsTable.kind} = 'brand' THEN 0 ELSE 1 END`, assetsTable.name)
    .limit(MAX_CANDIDATES);
  return rows.map((r) => ({
    kind: "asset" as const,
    refId: r.id,
    name: r.name,
    previewUrl: `/api/storage${r.storageKey}`,
    role: r.kind === "brand" ? ("exact_asset" as const) : ("style" as const),
  }));
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
    planned.suggestedFormat && planned.suggestedFormat in GENERATION_FORMATS
      ? (planned.suggestedFormat as GenerationFormat)
      : null;

  return {
    summary: planned.summary,
    questions: (planned.clarifyingQuestions ?? []).map((q) => String(q)).filter(Boolean).slice(0, 3),
    suggestedFormat,
    slots,
  };
}
