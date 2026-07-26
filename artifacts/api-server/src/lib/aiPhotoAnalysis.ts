import { and, eq } from "drizzle-orm";
import {
  db,
  photosTable,
  collectionsTable,
  photoCollectionSuggestionsTable,
  photoNewCollectionSuggestionsTable,
  photoAiEvaluationsTable,
  aiAnalysisEventsTable,
  type AiAnalysisEvent,
} from "@workspace/db";
import sharp from "sharp";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { getActiveProvider } from "./aiProviders";
import type { ProviderId } from "./aiProviders";
import { normalizeEvaluation, type PhotoEvaluationScores } from "./aiEvaluation";
import { createLimiter } from "./concurrencyLimit";

const storageService = new ObjectStorageService();

// Bound concurrent analyses: each one holds an image in memory while a slow
// provider call is in flight, and uploads fire these off without awaiting.
const analysisLimiter = createLimiter(2);

// Providers downscale large images anyway; resizing before base64-encoding
// cuts per-job heap usage from tens of MB (full-res photo) to ~1MB.
const AI_IMAGE_MAX_DIM = 1568;

interface ResolvedImage {
  dataUrl: string;
  contentType: string;
}

export async function resolveImageForAI(
  imageUrl: string,
  storageKey: string | null,
): Promise<ResolvedImage> {
  if (storageKey && storageKey.startsWith("/objects/")) {
    try {
      const file = await storageService.getObjectEntityFile(storageKey);
      const [metadata] = await file.getMetadata();
      const [buffer] = await file.download();
      const contentType = (metadata.contentType as string) || "image/jpeg";
      try {
        const resized = await sharp(buffer)
          .resize({
            width: AI_IMAGE_MAX_DIM,
            height: AI_IMAGE_MAX_DIM,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 80 })
          .toBuffer();
        return {
          dataUrl: `data:image/jpeg;base64,${resized.toString("base64")}`,
          contentType: "image/jpeg",
        };
      } catch (resizeErr) {
        logger.warn(
          { err: resizeErr, storageKey },
          "Could not downscale image for AI analysis, sending original",
        );
        return {
          dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
          contentType,
        };
      }
    } catch (err) {
      logger.warn(
        { err, storageKey },
        "Could not fetch private object for AI analysis",
      );
    }
  }
  return { dataUrl: imageUrl, contentType: "image/jpeg" };
}

export interface CollectionForSuggestion {
  id: number;
  title: string;
  description: string | null;
}

export interface PhotoAnalysisResult {
  description: string;
  suggestedCollectionIds: number[];
  suggestedNewCollectionNames: string[];
  /** Normalized criteria scores (#181), or null when the provider omitted/garbled them. */
  evaluation: PhotoEvaluationScores | null;
}

export type AnalyzePhotoOutcome =
  | { status: "success"; provider: ProviderId; result: PhotoAnalysisResult }
  | { status: "skipped"; provider: ProviderId | null; reason: string }
  | { status: "failed"; provider: ProviderId | null; error: string };

export async function analyzePhoto(
  imageUrl: string,
  collections: CollectionForSuggestion[],
  storageKey: string | null,
  organizationId: number,
): Promise<AnalyzePhotoOutcome> {
  const { provider, reason } = await getActiveProvider(organizationId);
  if (!provider) {
    logger.info({ reason }, "Skipping AI photo analysis");
    return { status: "skipped", provider: null, reason: reason ?? "No active provider" };
  }

  const allowedCollectionIds = collections.map((c) => c.id);
  const collectionsBlock = collections
    .map(
      (c) =>
        `- id=${c.id} | "${c.title}"${c.description ? ` — ${c.description}` : ""}`,
    )
    .join("\n");

  const systemPrompt =
    "You are a photo describer for a team photo album. Look at the photo and (1) write one plain-English description (max 60 words) of what is in it — for every person visible include their approximate age range (child/teen/adult/elderly), sex, race/ethnicity, pose (e.g. standing, sitting, crouching), and general disposition or expression (e.g. smiling, laughing, serious, focused); also describe the setting and overall scene; if no people are present, describe the subject, objects, and environment in detail; (2) from the user's existing collections, pick up to 3 that this photo would naturally belong in (only clear thematic matches, otherwise empty; never invent collection ids); (3) if no existing collections match well, suggest 1–2 short new category names (2–4 words each, title case) that would suit this photo — only when existing collections don't already cover it well; (4) evaluate the photo on five criteria, each an integer 0–10 (0–2 unusable, 3–4 poor, 5–6 usable, 7–8 good, 9–10 exceptional; use the full range and be critical — most ordinary photos should land 4–7): technicalQuality (sharpness/focus, exposure, noise — blurry or badly exposed shots score low), composition (framing, subject placement, background clutter), subjectClarity (how clearly the main subject reads — isolation, timing, eye contact), emotionalImpact (expressiveness, energy, storytelling value), marketingUsability (hero-shot potential: would this work in a campaign, website banner or social post?); also list concrete flaws if any (short phrases like \"motion blur\", \"closed eyes\", \"harsh shadows\", \"cluttered background\"; empty list if clean) and one short orientationSuitability phrase describing which crops/uses the framing suits (e.g. \"wide banner\", \"square social crop\", \"tight portrait\").";

  const collectionsText = collections.length
    ? `Existing collections:\n${collectionsBlock}`
    : "The user has no collections yet.";

  const userText = `${collectionsText}\n\nDescribe the photo, pick up to 3 fitting existing collection ids (empty array if none match well), if no existing collections are a good fit suggest 1–2 short new collection names (empty array otherwise), and score the photo on the five evaluation criteria with any flaws and orientation suitability.`;

  let image: ResolvedImage;
  let result: Awaited<ReturnType<typeof provider.analyze>>;
  try {
    image = await resolveImageForAI(imageUrl, storageKey);
    result = await provider.analyze({
      imageDataUrl: image.dataUrl,
      contentType: image.contentType,
      systemPrompt,
      userText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", provider: provider.id, error: message };
  }
  if (!result) {
    return {
      status: "failed",
      provider: provider.id,
      error: "Provider returned no result",
    };
  }

  const suggestedCollectionIds = Array.from(
    new Set(
      result.suggestedCollectionIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && allowedCollectionIds.includes(id)),
    ),
  ).slice(0, 3);

  const rawNewNames = Array.isArray(result.suggestedNewCollectionNames)
    ? result.suggestedNewCollectionNames
    : [];

  const suggestedNewCollectionNames = suggestedCollectionIds.length > 0
    ? []
    : rawNewNames
        .map((n) => String(n).trim())
        .filter((n) => n.length > 0 && n.length <= 80)
        .slice(0, 2);

  return {
    status: "success",
    provider: provider.id,
    result: {
      description: result.description,
      suggestedCollectionIds,
      suggestedNewCollectionNames,
      evaluation: normalizeEvaluation(result.evaluation),
    },
  };
}

/**
 * Run AI analysis for an existing photo and persist the outcome:
 * - Updates `photos.aiDescription` on success
 * - Inserts pending collection suggestions on success
 * - Inserts pending new-collection-name suggestions when no existing collections match
 * - Always records an `ai_analysis_events` row describing the attempt
 *
 * Used by the upload flow and by the admin "Retry" action on failed events.
 * Returns the inserted event row, or null if the photo is missing.
 */
export function runAndRecordPhotoAnalysis(
  photoId: number,
): Promise<AiAnalysisEvent | null> {
  return analysisLimiter(() => runAndRecordPhotoAnalysisUnbounded(photoId));
}

async function runAndRecordPhotoAnalysisUnbounded(
  photoId: number,
): Promise<AiAnalysisEvent | null> {
  const [photo] = await db
    .select()
    .from(photosTable)
    .where(eq(photosTable.id, photoId));
  if (!photo) return null;

  try {
    const collections = await db
      .select({
        id: collectionsTable.id,
        title: collectionsTable.title,
        description: collectionsTable.description,
      })
      .from(collectionsTable)
      // Suggest from the photo's org (#113). People are excluded: matching an AI
      // description against a person's *name* is unreliable — person membership
      // stays manual/similarity-driven.
      .where(and(eq(collectionsTable.organizationId, photo.organizationId), eq(collectionsTable.kind, "collection")));

    const outcome = await analyzePhoto(
      photo.url,
      collections,
      photo.storageKey,
      photo.organizationId,
    );

    if (outcome.status === "skipped") {
      const [ev] = await db
        .insert(aiAnalysisEventsTable)
        .values({
          photoId: photo.id,
          provider: outcome.provider,
          status: "skipped",
          errorMessage: outcome.reason,
        })
        .returning();
      return ev;
    }

    if (outcome.status === "failed") {
      const [ev] = await db
        .insert(aiAnalysisEventsTable)
        .values({
          photoId: photo.id,
          provider: outcome.provider,
          status: "failed",
          errorMessage: outcome.error.slice(0, 1000),
        })
        .returning();
      return ev;
    }

    const result = outcome.result;

    const ev = await db.transaction(async (tx) => {
      await tx
        .delete(photoCollectionSuggestionsTable)
        .where(
          and(
            eq(photoCollectionSuggestionsTable.photoId, photo.id),
            eq(photoCollectionSuggestionsTable.status, "pending"),
          ),
        );

      await tx
        .delete(photoNewCollectionSuggestionsTable)
        .where(
          and(
            eq(photoNewCollectionSuggestionsTable.photoId, photo.id),
            eq(photoNewCollectionSuggestionsTable.status, "pending"),
          ),
        );

      await tx
        .update(photosTable)
        .set({ aiDescription: result.description || null })
        .where(eq(photosTable.id, photo.id));

      // Criteria evaluation (#181): upsert alongside the description. When a
      // provider omits/garbles the block we keep any previous evaluation rather
      // than destroying scores on re-analysis.
      if (result.evaluation) {
        const ev = result.evaluation;
        const evalValues = {
          organizationId: photo.organizationId,
          technicalQuality: ev.technicalQuality,
          composition: ev.composition,
          subjectClarity: ev.subjectClarity,
          emotionalImpact: ev.emotionalImpact,
          marketingUsability: ev.marketingUsability,
          overallScore: ev.overallScore,
          flaws: ev.flaws,
          orientationSuitability: ev.orientationSuitability,
          provider: outcome.provider,
          evaluatedAt: new Date(),
        };
        await tx
          .insert(photoAiEvaluationsTable)
          .values({ photoId: photo.id, ...evalValues })
          .onConflictDoUpdate({ target: photoAiEvaluationsTable.photoId, set: evalValues });
      }

      if (result.suggestedCollectionIds.length > 0) {
        await tx
          .insert(photoCollectionSuggestionsTable)
          .values(
            result.suggestedCollectionIds.map((cid) => ({
              photoId: photo.id,
              collectionId: cid,
              status: "pending" as const,
            })),
          )
          .onConflictDoNothing();
      }

      if (result.suggestedNewCollectionNames.length > 0) {
        await tx
          .insert(photoNewCollectionSuggestionsTable)
          .values(
            result.suggestedNewCollectionNames.map((name) => ({
              photoId: photo.id,
              suggestedName: name,
              status: "pending" as const,
            })),
          );
      }

      const [row] = await tx
        .insert(aiAnalysisEventsTable)
        .values({
          photoId: photo.id,
          provider: outcome.provider,
          status: "success",
        })
        .returning();
      return row;
    });

    // The description influences the stored vector (blended embedding), so
    // re-embed now that it's written. Fire-and-forget; dynamic import because
    // aiEmbedding statically imports resolveImageForAI from this module.
    void import("./aiEmbedding")
      .then(({ generateAndStorePhotoEmbedding }) => generateAndStorePhotoEmbedding(photo.id))
      .catch((err) => logger.warn({ err, photoId: photo.id }, "Post-analysis re-embed failed"));

    return ev;
  } catch (err) {
    logger.error({ err, photoId }, "AI analysis failed");
    try {
      const message = err instanceof Error ? err.message : String(err);
      const [ev] = await db
        .insert(aiAnalysisEventsTable)
        .values({
          photoId,
          provider: null,
          status: "failed",
          errorMessage: message.slice(0, 1000),
        })
        .returning();
      return ev;
    } catch (logErr) {
      logger.error({ err: logErr }, "Failed to record AI analysis failure event");
      return null;
    }
  }
}
