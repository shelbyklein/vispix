import { randomUUID } from "crypto";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  photosTable,
  assetsTable,
  attributionTagsTable,
  photoAttributionTagsTable,
  imageGenerationSessionsTable,
  imageGenerationsTable,
  type GenerationInput,
  type ImageGeneration,
} from "@workspace/db";
import { getPrivateObjectDir, parseObjectPath, signObjectURL } from "../objectStorage";
import { resolveImageForAI } from "../aiPhotoAnalysis";
import { getOpenAIKeyForOrg } from "../aiProviders";
import { generateImage, type ImageSize } from "./openaiImage";
import { logger } from "../logger";

// Output formats offered by the Create workspace — exactly the image model's
// native canvases, nothing more (#167). Ratios the model can't render (4:5,
// 9:16, print sizes) are deliberately not offered: a fake ratio would need
// cropping, and cropping a composed design amputates it.
export const GENERATION_FORMATS = {
  "1:1": { size: "1024x1024" as ImageSize, label: "Square 1:1" },
  "2:3": { size: "1024x1536" as ImageSize, label: "Portrait 2:3" },
  "3:2": { size: "1536x1024" as ImageSize, label: "Landscape 3:2" },
} as const;

export type GenerationFormat = keyof typeof GENERATION_FORMATS;

export interface RequestedInput {
  kind: "upload" | "photo" | "asset";
  /** photo/asset id for library inputs. */
  refId?: number;
  /** /objects/… path for uploaded references. */
  storageKey?: string;
  role: "style" | "hero_photo" | "exact_asset";
  name?: string;
}

interface ResolvedInput extends GenerationInput {
  dataUrl: string;
  usageNotes: string[];
}

// Role instructions (#167 §2): style influences, photos are preserved with a
// short list of acceptable edits, exact assets must not be regenerated. The
// thin MVP enforces these through the prompt only (no compositor yet).
const ROLE_INSTRUCTIONS: Record<RequestedInput["role"], string> = {
  style:
    "STYLE REFERENCE — take composition, color palette, texture and overall visual direction from it. Do not copy its literal content.",
  hero_photo:
    "HERO PHOTO — this photography is the visual core of the output and must be preserved as closely as possible. Acceptable edits: fades, cropping, removing/replacing the sky or background scenery, adding design elements behind subjects, removing blemishes or unwanted background objects. Do NOT change equipment, faces, or bodies unless the request explicitly asks for it.",
  exact_asset:
    "EXACT ASSET — a logo/icon/product element that must appear faithfully and unmodified: exact shapes, colors and proportions. Never redraw, restyle or approximate it.",
};

/**
 * Resolve requested inputs to image data URLs + usage notes, org-scoped: photo
 * and asset ids must belong to the org, and uploaded reference keys must sit
 * under the org's own upload prefix.
 */
async function resolveInputs(organizationId: number, requested: RequestedInput[]): Promise<ResolvedInput[]> {
  const photoIds = requested.filter((i) => i.kind === "photo" && i.refId != null).map((i) => i.refId!);
  const assetIds = requested.filter((i) => i.kind === "asset" && i.refId != null).map((i) => i.refId!);

  const [photos, assets, photoRights] = await Promise.all([
    photoIds.length
      ? db
          .select({ id: photosTable.id, storageKey: photosTable.storageKey, url: photosTable.url, filename: photosTable.filename })
          .from(photosTable)
          .where(and(inArray(photosTable.id, photoIds), eq(photosTable.organizationId, organizationId)))
      : Promise.resolve([]),
    assetIds.length
      ? db
          .select({ id: assetsTable.id, storageKey: assetsTable.storageKey, name: assetsTable.name, notes: assetsTable.notes, contentType: assetsTable.contentType })
          .from(assetsTable)
          .where(and(inArray(assetsTable.id, assetIds), eq(assetsTable.organizationId, organizationId)))
      : Promise.resolve([]),
    photoIds.length
      ? db
          .select({ photoId: photoAttributionTagsTable.photoId, name: attributionTagsTable.name })
          .from(photoAttributionTagsTable)
          .innerJoin(attributionTagsTable, eq(photoAttributionTagsTable.tagId, attributionTagsTable.id))
          .where(inArray(photoAttributionTagsTable.photoId, photoIds))
      : Promise.resolve([]),
  ]);
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const rightsByPhoto = new Map<number, string[]>();
  for (const r of photoRights) {
    (rightsByPhoto.get(r.photoId) ?? rightsByPhoto.set(r.photoId, []).get(r.photoId)!).push(r.name);
  }

  const resolved: ResolvedInput[] = [];
  for (const req of requested) {
    let storageKey: string | null = null;
    let url = "";
    let name = req.name ?? null;
    const usageNotes: string[] = [];

    if (req.kind === "photo") {
      const photo = req.refId != null ? photoById.get(req.refId) : undefined;
      if (!photo) throw new Error(`Photo #${req.refId} not found in this organization.`);
      storageKey = photo.storageKey;
      url = photo.url;
      name = name ?? photo.filename ?? `photo-${photo.id}`;
      const rights = rightsByPhoto.get(photo.id) ?? [];
      usageNotes.push(
        rights.length > 0
          ? `Photo "${name}" is cleared for: ${rights.join(", ")}.`
          : `Photo "${name}" has NO recorded usage clearances — verify rights before publishing.`,
      );
    } else if (req.kind === "asset") {
      const asset = req.refId != null ? assetById.get(req.refId) : undefined;
      if (!asset) throw new Error(`Asset #${req.refId} not found in this organization.`);
      if (asset.contentType && !asset.contentType.startsWith("image/")) {
        throw new Error(`Asset "${asset.name}" (${asset.contentType}) is not a raster image and can't be attached.`);
      }
      storageKey = asset.storageKey;
      name = name ?? asset.name;
      if (asset.notes?.trim()) usageNotes.push(`Asset "${name}" usage notes: ${asset.notes.trim()}`);
    } else {
      // Uploaded reference: the client passes the objectPath minted by the
      // upload flow. Only accept keys under this org's own upload prefix.
      if (!req.storageKey?.startsWith(`/objects/orgs/${organizationId}/`)) {
        throw new Error("Uploaded reference key is not valid for this organization.");
      }
      storageKey = req.storageKey;
      name = name ?? "uploaded reference";
    }

    // Downscale + base64 exactly like photo analysis does.
    const { dataUrl } = await resolveImageForAI(url, storageKey);
    if (!dataUrl.startsWith("data:")) {
      throw new Error(`Could not load image bytes for "${name}".`);
    }
    resolved.push({
      kind: req.kind,
      refId: req.refId ?? null,
      storageKey: storageKey!,
      role: req.role,
      name,
      dataUrl,
      usageNotes,
    });
  }
  return resolved;
}

function buildBrief(prompt: string, inputs: ResolvedInput[], format: GenerationFormat): string {
  const lines: string[] = [
    "You are generating a finished marketing graphic. Create exactly one image following the user's creative direction.",
    "",
    `User request: ${prompt}`,
    "",
    `Output: ${GENERATION_FORMATS[format].label}. Fill the full canvas; keep any text legible and correctly spelled.`,
  ];
  if (inputs.length > 0) {
    lines.push("", "Attached images, in order, and how each must be treated:");
    inputs.forEach((input, i) => {
      lines.push(`${i + 1}. "${input.name}" — ${ROLE_INSTRUCTIONS[input.role]}`);
    });
  }
  const notes = inputs.flatMap((i) => i.usageNotes);
  if (notes.length > 0) {
    lines.push("", "Usage notes to respect:", ...notes.map((n) => `- ${n}`));
  }
  return lines.join("\n");
}

/** Upload PNG bytes under the org's generated/ prefix; returns the /objects key. */
async function storeGeneratedPng(organizationId: number, buffer: Buffer): Promise<{ storageKey: string; width: number | null; height: number | null }> {
  let entityDir = getPrivateObjectDir();
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const objectId = `orgs/${organizationId}/generated/${randomUUID()}`;
  const { bucketName, objectName } = parseObjectPath(`${entityDir}${objectId}`);
  const uploadURL = await signObjectURL({ bucketName, objectName, method: "PUT", ttlSec: 900 });
  const res = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Storing the generated image failed (${res.status}).`);
  const meta = await sharp(buffer).metadata().catch(() => null);
  return { storageKey: `/objects/${objectId}`, width: meta?.width ?? null, height: meta?.height ?? null };
}

export interface RunGenerationArgs {
  organizationId: number;
  userId: number;
  sessionId?: number;
  prompt: string;
  inputs: RequestedInput[];
  /** Omitted on a revision → inherit the parent's format; a value re-renders
   * the design on a different canvas ("turn this into a story"). */
  format?: GenerationFormat;
  variantCount: number;
  /** Revise this earlier output (multi-turn) instead of generating fresh. */
  parentGenerationId?: number;
}

export interface RunGenerationResult {
  sessionId: number;
  generations: ImageGeneration[];
}

export async function runGeneration(args: RunGenerationArgs): Promise<RunGenerationResult> {
  const key = await getOpenAIKeyForOrg(args.organizationId);
  if (!key) {
    throw Object.assign(new Error("No OpenAI API key configured for this organization — add one in AI settings."), {
      statusCode: 400,
    });
  }

  // Revision: reuse the parent's session + response id and skip re-sending
  // reference images (the Responses API keeps the image context server-side).
  let parent: ImageGeneration | null = null;
  if (args.parentGenerationId != null) {
    const [row] = await db
      .select()
      .from(imageGenerationsTable)
      .where(
        and(
          eq(imageGenerationsTable.id, args.parentGenerationId),
          eq(imageGenerationsTable.organizationId, args.organizationId),
        ),
      );
    if (!row) throw Object.assign(new Error("Generation to revise was not found."), { statusCode: 404 });
    parent = row;
  }

  // Session: reuse, or create titled by the first prompt.
  let sessionId = parent?.sessionId ?? args.sessionId;
  if (sessionId != null) {
    const [session] = await db
      .select({ id: imageGenerationSessionsTable.id })
      .from(imageGenerationSessionsTable)
      .where(
        and(
          eq(imageGenerationSessionsTable.id, sessionId),
          eq(imageGenerationSessionsTable.organizationId, args.organizationId),
        ),
      );
    if (!session) throw Object.assign(new Error("Session not found."), { statusCode: 404 });
  } else {
    const [session] = await db
      .insert(imageGenerationSessionsTable)
      .values({
        organizationId: args.organizationId,
        userId: args.userId,
        title: args.prompt.slice(0, 120),
      })
      .returning({ id: imageGenerationSessionsTable.id });
    sessionId = session.id;
  }

  // Format: fresh generations use the requested format; revisions inherit the
  // parent's unless the caller explicitly asks for a different canvas.
  const parentFormat = parent ? (parent.settings as { format?: GenerationFormat }).format : undefined;
  const format: GenerationFormat = args.format ?? parentFormat ?? "1:1";
  const formatChanged = parent != null && args.format != null && args.format !== parentFormat;

  const resolved = parent ? [] : await resolveInputs(args.organizationId, args.inputs);
  const brief = parent
    ? formatChanged
      ? `Re-render the current image adapted to a ${GENERATION_FORMATS[format].label} canvas: keep the same design, content, text and style, recomposing the layout to suit the new aspect ratio. ${args.prompt}`
      : `Revise the current image: ${args.prompt}\nKeep everything else unchanged.`
    : buildBrief(args.prompt, resolved, format);
  const usageNotesSnapshot = parent
    ? ((parent.usageNotesSnapshot as string[] | null) ?? [])
    : resolved.flatMap((i) => i.usageNotes);
  const storedInputs: GenerationInput[] = parent
    ? ((parent.inputs as GenerationInput[] | null) ?? [])
    : resolved.map(({ kind, refId, storageKey, role, name }) => ({ kind, refId, storageKey, role, name }));
  const size = GENERATION_FORMATS[format]?.size ?? "1024x1024";
  const variantCount = parent ? 1 : Math.min(Math.max(args.variantCount, 1), 3);

  // Variants run as independent calls (each gets its own response id, so any of
  // them can be revised later). Sequential — image calls are heavy and the org
  // key may have tight rate limits.
  const generations: ImageGeneration[] = [];
  for (let variant = 0; variant < variantCount; variant++) {
    const settings = {
      format,
      size,
      variantIndex: variant,
      variantCount,
      imageModel: "",
    };
    try {
      const image = await generateImage({
        apiKey: key.apiKey,
        baseURL: key.baseURL,
        brief,
        inputImages: parent ? undefined : resolved.map((i) => i.dataUrl),
        size,
        previousResponseId: parent?.openaiResponseId ?? null,
      });
      settings.imageModel = image.imageModel;
      const stored = await storeGeneratedPng(args.organizationId, image.buffer);
      const [row] = await db
        .insert(imageGenerationsTable)
        .values({
          organizationId: args.organizationId,
          sessionId,
          parentGenerationId: parent?.id ?? null,
          prompt: args.prompt,
          openaiResponseId: image.responseId,
          settings,
          inputs: storedInputs,
          usageNotesSnapshot,
          storageKey: stored.storageKey,
          contentType: "image/png",
          width: stored.width,
          height: stored.height,
          status: "succeeded",
        })
        .returning();
      generations.push(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId, variant }, "Image generation failed");
      const [row] = await db
        .insert(imageGenerationsTable)
        .values({
          organizationId: args.organizationId,
          sessionId,
          parentGenerationId: parent?.id ?? null,
          prompt: args.prompt,
          settings,
          inputs: storedInputs,
          usageNotesSnapshot,
          status: "failed",
          error: message.slice(0, 1000),
        })
        .returning();
      generations.push(row);
    }
  }

  await db
    .update(imageGenerationSessionsTable)
    .set({ updatedAt: new Date() })
    .where(eq(imageGenerationSessionsTable.id, sessionId));

  return { sessionId, generations };
}
