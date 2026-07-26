import { eq } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import {
  db,
  organizationSettingsTable,
  photosTable,
  photoEmbeddingsTable,
  EMBEDDING_DIMENSION,
} from "@workspace/db";
import { resolveImageForAI } from "./aiPhotoAnalysis";
import { createLimiter } from "./concurrencyLimit";
import { logger } from "./logger";

// Google Vertex AI multimodal embedding model. Images and text queries land in
// the same 1408-dim space, so a text query retrieves images and image↔image
// similarity works. See lib/db photoEmbeddings.ts for the fixed dimension.
export const VERTEX_EMBEDDING_MODEL = "multimodalembedding@001";
export const EMBEDDING_MODEL_TAG = `vertex/${VERTEX_EMBEDDING_MODEL}`;
// Tag for vectors that blend the photo's AI description into the image vector —
// lets the backfill find image-only vectors that should be upgraded once the
// photo has a description.
export const EMBEDDING_MODEL_TAG_BLENDED = `${EMBEDDING_MODEL_TAG}+desc`;

// How much the description's text vector pulls the stored photo vector (image
// stays dominant). Both parts live in the same multimodal space, so a weighted
// blend is a legitimate late fusion; 0 disables blending entirely.
const DESCRIPTION_EMBED_WEIGHT = (() => {
  const raw = parseFloat(process.env.EMBED_DESCRIPTION_WEIGHT ?? "");
  return Number.isFinite(raw) ? Math.min(0.5, Math.max(0, raw)) : 0.3;
})();

function normalizeVec(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

function blendVectors(imageVec: number[], textVec: number[], weight: number): number[] {
  const img = normalizeVec(imageVec);
  const txt = normalizeVec(textVec);
  return normalizeVec(img.map((x, i) => x * (1 - weight) + txt[i] * weight));
}

// Bound concurrent image embeds — each holds a downscaled image in memory while
// the Vertex call is in flight, and uploads fire these without awaiting.
const embeddingLimiter = createLimiter(2);

function vertexConfig(): { project: string | null; location: string } {
  return {
    project: process.env.VERTEX_PROJECT || null,
    location: process.env.VERTEX_LOCATION || "us-central1",
  };
}

let cachedAuth: GoogleAuth | null = null;
function googleAuth(): GoogleAuth {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });
  }
  return cachedAuth;
}

async function getAccessToken(): Promise<string | null> {
  try {
    const client = await googleAuth().getClient();
    const token = await client.getAccessToken();
    return token.token ?? null;
  } catch (err) {
    logger.error({ err }, "Vertex ADC token acquisition failed (check GOOGLE_APPLICATION_CREDENTIALS)");
    return null;
  }
}

// One instance may carry an image, a text, or both — multimodalembedding
// returns a vector for each part it was given, in one prediction.
type EmbedInstance = { image?: { bytesBase64Encoded: string }; text?: string };

interface VertexPrediction {
  imageVec: number[] | null;
  textVec: number[] | null;
}

// Low-level call to the Vertex :predict endpoint. Returns null (never throws) on
// any config/auth/HTTP/shape error, so callers degrade gracefully.
async function callVertexPredict(instance: EmbedInstance): Promise<VertexPrediction | null> {
  const { project, location } = vertexConfig();
  if (!project) {
    logger.warn("VERTEX_PROJECT is not set — skipping embedding");
    return null;
  }
  const token = await getAccessToken();
  if (!token) return null;

  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${VERTEX_EMBEDDING_MODEL}:predict`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [instance] }),
    });
  } catch (err) {
    logger.error({ err }, "Vertex embedding request failed (network)");
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body: body.slice(0, 500) }, "Vertex embedding request failed");
    return null;
  }

  const json = (await res.json().catch(() => null)) as {
    predictions?: Array<{ imageEmbedding?: number[]; textEmbedding?: number[] }>;
  } | null;
  const pred = json?.predictions?.[0];
  const validate = (v: number[] | undefined): number[] | null =>
    v && v.length === EMBEDDING_DIMENSION ? v : null;
  const imageVec = validate(pred?.imageEmbedding);
  const textVec = validate(pred?.textEmbedding);
  if (!imageVec && !textVec) {
    logger.error(
      { imageLen: pred?.imageEmbedding?.length, textLen: pred?.textEmbedding?.length, expected: EMBEDDING_DIMENSION },
      "Vertex embedding: unexpected response",
    );
    return null;
  }
  return { imageVec, textVec };
}

/** Embed a natural-language query (for semantic search). Not concurrency-bounded
 *  so search stays responsive. Returns null when embeddings can't be produced. */
export async function embedText(query: string): Promise<number[] | null> {
  const q = query.trim();
  if (!q) return null;
  const pred = await callVertexPredict({ text: q });
  return pred?.textVec ?? null;
}

async function isEmbeddingEnabled(organizationId: number): Promise<boolean> {
  const [s] = await db
    .select({ enabled: organizationSettingsTable.embeddingEnabled })
    .from(organizationSettingsTable)
    .where(eq(organizationSettingsTable.organizationId, organizationId));
  return Boolean(s?.enabled);
}

/**
 * Generate and upsert the embedding for one photo. The image pixels are the
 * base; when the photo has an AI description, its text vector (same multimodal
 * space, same Vertex call) is blended in at DESCRIPTION_EMBED_WEIGHT so the
 * description influences retrieval — event names, roles and context that the
 * pixels alone can't carry. No-ops (returns false) when embeddings are
 * disabled, the photo/image is unavailable, or Vertex isn't configured — so
 * it's safe to fire-and-forget on upload and to run in CI.
 */
export async function generateAndStorePhotoEmbedding(photoId: number): Promise<boolean> {
  const [photo] = await db
    .select({
      url: photosTable.url,
      storageKey: photosTable.storageKey,
      organizationId: photosTable.organizationId,
      aiDescription: photosTable.aiDescription,
    })
    .from(photosTable)
    .where(eq(photosTable.id, photoId));
  if (!photo) return false;

  // Embeddings are toggled per org (#113).
  if (!(await isEmbeddingEnabled(photo.organizationId))) return false;

  const { dataUrl } = await resolveImageForAI(photo.url, photo.storageKey);
  // Vertex needs the raw image bytes; resolveImageForAI only base64-encodes when
  // the object is fetchable from storage (data: URL). A bare remote URL can't be
  // embedded here.
  if (!dataUrl.startsWith("data:")) {
    logger.warn({ photoId }, "No fetchable image bytes for embedding — skipping");
    return false;
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

  const description = photo.aiDescription?.trim().slice(0, 1000) || null;
  const wantBlend = description != null && DESCRIPTION_EMBED_WEIGHT > 0;

  const pred = await embeddingLimiter(() =>
    callVertexPredict({
      image: { bytesBase64Encoded: base64 },
      ...(wantBlend ? { text: description } : {}),
    }),
  );
  if (!pred?.imageVec) return false;

  const blended = wantBlend && pred.textVec != null;
  const vec = blended
    ? blendVectors(pred.imageVec, pred.textVec!, DESCRIPTION_EMBED_WEIGHT)
    : pred.imageVec;
  const modelTag = blended ? EMBEDDING_MODEL_TAG_BLENDED : EMBEDDING_MODEL_TAG;

  await db
    .insert(photoEmbeddingsTable)
    // organizationId denormalized from the photo (#113) so vector search can
    // stay within a tenant without a join when needed.
    .values({ photoId, organizationId: photo.organizationId, embedding: vec, model: modelTag })
    .onConflictDoUpdate({
      target: photoEmbeddingsTable.photoId,
      set: { embedding: vec, model: modelTag, createdAt: new Date(), organizationId: photo.organizationId },
    });
  return true;
}

export interface EmbeddingConfigStatus {
  enabled: boolean;
  projectConfigured: boolean;
  credentialsConfigured: boolean;
  model: string;
  location: string;
}

/** Config snapshot for the admin UI (no network call). Per-org (#113). */
export async function getEmbeddingConfigStatus(organizationId: number): Promise<EmbeddingConfigStatus> {
  const { project, location } = vertexConfig();
  return {
    enabled: await isEmbeddingEnabled(organizationId),
    projectConfigured: Boolean(project),
    credentialsConfigured: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    model: VERTEX_EMBEDDING_MODEL,
    location,
  };
}
