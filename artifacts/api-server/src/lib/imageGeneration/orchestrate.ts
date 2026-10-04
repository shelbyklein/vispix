import { createHash, randomUUID } from "crypto";
import sharp from "sharp";
import { and, eq, inArray, or } from "drizzle-orm";
import { isOrgUploadKey } from "../storageKeys";
import {
  db,
  photosTable,
  assetsTable,
  imageGenerationSessionsTable,
  imageGenerationsTable,
  type GenerationInput,
  type ImageGeneration,
  type GenerationCompositionRecord,
} from "@workspace/db";
import { loadUsageRights, snapshotOf, usageNote } from "../usageRights";
import { ObjectStorageService, getPrivateObjectDir, parseObjectPath, signObjectURL } from "../objectStorage";
import { resolveImageForAI } from "../aiPhotoAnalysis";
import { hiddenPhotoCondition } from "../photoHelpers";
import { getOpenAIKeyForOrg } from "../aiProviders";
import { generateImage, type ImageSize } from "./openaiImage";
import { compositeLogo, logoDimensions, PLACEHOLDER_HEX, type Box, type Placement } from "./compose";
import { createLimiter } from "../concurrencyLimit";
import { logger } from "../logger";
import { GENERIC_GENERATION_ERROR, releaseGenerationSlots, reserveGenerationSlots } from "./limits";

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
  /** Photo inputs (#207): rights re-read at generation time, frozen with the output. */
  rights?: ImageGeneration["rightsSnapshot"][number];
  /** Library logo asset inputs with role exact_asset (#215): original bytes, for compositing. */
  assetFile?: { bytes: Buffer; contentType: string; width: number; height: number };
}

const storageService = new ObjectStorageService();

/** Raw bytes of a stored /objects/... file. */
async function loadObjectBytes(storageKey: string): Promise<Buffer> {
  const file = await storageService.getObjectEntityFile(storageKey);
  const [buffer] = await file.download();
  return buffer;
}

const sha12 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);

/** What gets composited onto each output: the original logo file and where it came from. */
interface CompositeJob {
  assetId: number;
  assetName: string;
  /** Internal revision: `<storage key>#<sha256 first 12 hex>`. */
  assetRevision: string;
  bytes: Buffer;
  contentType: string;
  /** Revision re-composite: the parent's recorded layout/placement. Absent -> detect the placeholder. */
  fixed?: { layout: Box; placement: Placement };
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

// The logo that Vispix composites itself (#215): the model must not draw it.
function compositedLogoInstruction(aspectW: number, aspectH: number): string {
  return `LOGO REFERENCE (for proportions and colors only) — do NOT draw, copy or approximate this logo anywhere. Instead, where the logo belongs in the design, leave one flat, solid ${PLACEHOLDER_HEX} (pure magenta) rectangle with an aspect ratio of ${aspectW}:${aspectH} (width:height), sharp square corners, no border, no shadow, no gradient and nothing inside it. Do not use ${PLACEHOLDER_HEX} anywhere else. The finished logo will be placed into that rectangle afterwards.`;
}

// Caller-fixable input problems surface as 400s with their message; anything
// else thrown here is an internal failure and gets a generic 500.
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Resolve requested inputs to image data URLs + usage notes, org-scoped: photo
 * and asset ids must belong to the org, and uploaded reference keys must sit
 * under the org's own upload prefix. A hidden photo resolves like a missing one
 * unless the caller may see hidden photos (#218).
 */
async function resolveInputs(organizationId: number, requested: RequestedInput[], canSeeHidden: boolean): Promise<ResolvedInput[]> {
  const photoIds = requested.filter((i) => i.kind === "photo" && i.refId != null).map((i) => i.refId!);
  const assetIds = requested.filter((i) => i.kind === "asset" && i.refId != null).map((i) => i.refId!);

  const [photos, assets, photoRights] = await Promise.all([
    photoIds.length
      ? db
          .select({ id: photosTable.id, storageKey: photosTable.storageKey, url: photosTable.url, filename: photosTable.filename })
          .from(photosTable)
          .where(and(inArray(photosTable.id, photoIds), eq(photosTable.organizationId, organizationId), hiddenPhotoCondition(canSeeHidden)))
      : Promise.resolve([]),
    assetIds.length
      ? db
          .select({ id: assetsTable.id, storageKey: assetsTable.storageKey, name: assetsTable.name, notes: assetsTable.notes, contentType: assetsTable.contentType })
          .from(assetsTable)
          .where(and(inArray(assetsTable.id, assetIds), eq(assetsTable.organizationId, organizationId)))
      : Promise.resolve([]),
    // Current rights, re-read now (#207) — a change since shortlisting counts.
    loadUsageRights(photoIds, organizationId),
  ]);
  // Upload keys that are really library objects (an original or thumbnail of
  // any photo, hidden or not).
  const uploadKeys = requested.filter((i) => i.kind === "upload" && i.storageKey && isOrgUploadKey(i.storageKey, organizationId)).map((i) => i.storageKey!);
  const libraryKeys = new Set<string>();
  if (uploadKeys.length) {
    const rows = await db
      .select({ storageKey: photosTable.storageKey, thumbnailKey: photosTable.thumbnailKey })
      .from(photosTable)
      .where(or(inArray(photosTable.storageKey, uploadKeys), inArray(photosTable.thumbnailKey, uploadKeys)));
    for (const r of rows) {
      if (r.storageKey) libraryKeys.add(r.storageKey);
      if (r.thumbnailKey) libraryKeys.add(r.thumbnailKey);
    }
  }
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const checkedAt = new Date();

  const resolved: ResolvedInput[] = [];
  for (const req of requested) {
    let storageKey: string | null = null;
    let url = "";
    let name = req.name ?? null;
    const usageNotes: string[] = [];
    let rights: ResolvedInput["rights"];
    let assetFile: ResolvedInput["assetFile"];

    if (req.kind === "photo") {
      const photo = req.refId != null ? photoById.get(req.refId) : undefined;
      if (!photo) throw badRequest(`Photo #${req.refId} not found in this organization.`);
      storageKey = photo.storageKey;
      url = photo.url;
      name = name ?? photo.filename ?? `photo-${photo.id}`;
      // Warning-only (#207): a photo with no recorded rights is still used;
      // the note and snapshot say so, and never call a tag a clearance.
      const current = photoRights.get(photo.id)!;
      usageNotes.push(usageNote(name, current));
      rights = { photoId: photo.id, name, ...snapshotOf(current, checkedAt) };
    } else if (req.kind === "asset") {
      const asset = req.refId != null ? assetById.get(req.refId) : undefined;
      if (!asset) throw badRequest(`Asset #${req.refId} not found in this organization.`);
      if (asset.contentType && !asset.contentType.startsWith("image/")) {
        throw badRequest(`Asset "${asset.name}" (${asset.contentType}) is not a raster image and can't be attached.`);
      }
      storageKey = asset.storageKey;
      name = name ?? asset.name;
      if (req.role === "exact_asset") {
        const bytes = await loadObjectBytes(asset.storageKey);
        const contentType = asset.contentType || "image/png";
        // Fail fast, before any provider spend, on a file that can't be composited.
        const dims = await logoDimensions(bytes, contentType).catch(() => null);
        if (!dims) throw badRequest(`Asset "${asset.name}" can't be read as an image, so it can't be placed as an exact logo.`);
        assetFile = { bytes, contentType, ...dims };
      }
      if (asset.notes?.trim()) usageNotes.push(`Asset "${name}" usage notes: ${asset.notes.trim()}`);
    } else {
      // Uploaded reference: the client passes the objectPath minted by the
      // upload flow. Only keys that flow issues to this org are accepted
      // (`/objects/orgs/<org>/uploads/<uuid>`: isOrgUploadKey allows only
      // [A-Za-z0-9-] after the prefix, so `..`, backslashes and control
      // characters cannot pass). Library objects — a photo's original or
      // thumbnail — must be referenced as kind "photo" so the visibility check
      // applies.
      const key = req.storageKey ?? "";
      if (!isOrgUploadKey(key, organizationId) || libraryKeys.has(key)) {
        throw badRequest("Uploaded reference key is not valid for this organization.");
      }
      storageKey = key;
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
      rights,
      assetFile,
    });
  }
  return resolved;
}

/** Prompts that led to `parent`, oldest first, including its own (bounded walk up the revision chain). */
async function loadPromptChain(parent: ImageGeneration, organizationId: number): Promise<string[]> {
  const prompts = [parent.prompt];
  let next = parent.parentGenerationId;
  for (let depth = 0; next != null && depth < 8; depth++) {
    const [row] = await db
      .select({ prompt: imageGenerationsTable.prompt, parentGenerationId: imageGenerationsTable.parentGenerationId })
      .from(imageGenerationsTable)
      .where(and(eq(imageGenerationsTable.id, next), eq(imageGenerationsTable.organizationId, organizationId)));
    if (!row) break;
    prompts.unshift(row.prompt);
    next = row.parentGenerationId;
  }
  return prompts;
}

/** The first library logo (exact_asset) is composited by Vispix; v1 composites only one (#215). */
function pickCompositeInput(inputs: ResolvedInput[]): ResolvedInput | null {
  return inputs.find((i) => i.kind === "asset" && i.role === "exact_asset" && i.assetFile && i.refId != null) ?? null;
}

function buildBrief(prompt: string, inputs: ResolvedInput[], format: GenerationFormat): string {
  const composited = pickCompositeInput(inputs);
  const lines: string[] = [
    "You are generating a finished marketing graphic. Create exactly one image following the user's creative direction.",
    "",
    `User request: ${prompt}`,
    "",
    `Output: ${GENERATION_FORMATS[format].label}. Fill the entire canvas edge to edge — never letterbox or add bands/borders around the design. Keep any text legible and correctly spelled.`,
  ];
  if (inputs.length > 0) {
    lines.push("", "Attached images, in order, and how each must be treated:");
    inputs.forEach((input, i) => {
      const instruction =
        input === composited
          ? compositedLogoInstruction(input.assetFile!.width, input.assetFile!.height)
          : ROLE_INSTRUCTIONS[input.role];
      lines.push(`${i + 1}. "${input.name}" — ${instruction}`);
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
  /** May library photo inputs include hidden photos? Callers pass
   * `canSeeHiddenPhotos(req)`; omitted → no (#218). */
  canSeeHidden?: boolean;
  /** Omitted on a revision → inherit the parent's format; a value re-renders
   * the design on a different canvas ("turn this into a story"). */
  format?: GenerationFormat;
  variantCount: number;
  /** Revise this earlier output (multi-turn) instead of generating fresh. */
  parentGenerationId?: number;
  /** Extra provenance stored in each generation's settings (e.g. the campaign
   * brief revision, #216). Core settings keys always take precedence. */
  settings?: Record<string, unknown>;
  /** Canvas the person asked for, when it isn't one of the supported ones; the
   * rendered canvas is always `format`. Omitted -> same as rendered (#215). */
  requestedFormat?: string;
  /** Required input roles the person chose to continue without (#215). */
  acknowledgedMissing?: Array<"hero_photo" | "exact_asset">;
}

export interface RunGenerationResult {
  sessionId: number;
  generations: ImageGeneration[];
}

export async function runGeneration(args: RunGenerationArgs): Promise<RunGenerationResult> {
  // Per-org / per-user / global pending caps (#229). Slots are reserved before
  // any heavy work and handed to the background chain, which releases one per
  // job as it finishes or fails; any earlier failure releases them here.
  const reserved = args.parentGenerationId != null ? 1 : Math.min(Math.max(args.variantCount, 1), 3);
  reserveGenerationSlots(args.organizationId, args.userId, reserved);
  const handoff = { transferred: false };
  try {
    return await runGenerationReserved(args, handoff);
  } catch (err) {
    if (!handoff.transferred) releaseGenerationSlots(args.organizationId, args.userId, reserved);
    throw err;
  }
}

async function runGenerationReserved(args: RunGenerationArgs, handoff: { transferred: boolean }): Promise<RunGenerationResult> {
  const key = await getOpenAIKeyForOrg(args.organizationId);
  if (!key) {
    throw Object.assign(new Error("No OpenAI API key configured for this organization — add one in AI settings."), {
      statusCode: 400,
    });
  }

  // Revision: reuse the parent's session.
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
    if (!row.storageKey || row.status !== "succeeded") {
      throw badRequest("That generation has no finished image to revise.");
    }
    parent = row;
  }

  // Revisions carry their own context (OpenAI-side storage is off, so there is
  // no previous_response_id): the parent's output image, downscaled like any
  // AI input, plus the earlier instructions that produced it.
  let parentImage: string | undefined;
  let priorPrompts: string[] = [];
  if (parent) {
    // Regenerate from the BASE image (before logo compositing) so a revision
    // never re-edits a composited logo; rows without one use the final image.
    const { dataUrl } = await resolveImageForAI("", parent.baseStorageKey ?? parent.storageKey);
    if (!dataUrl.startsWith("data:")) throw new Error("Could not load the image to revise.");
    parentImage = dataUrl;
    priorPrompts = await loadPromptChain(parent, args.organizationId);
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

  const resolved = parent ? [] : await resolveInputs(args.organizationId, args.inputs, args.canSeeHidden ?? false);

  // Exact-logo composition (#215). Fresh: the first library logo. Revision: the
  // same asset file revision the parent used, re-composited at the parent's
  // recorded layout (unless the canvas changed, where the layout can't carry
  // over and the placeholder is detected afresh).
  let composite: CompositeJob | null = null;
  let reservedNote = "";
  if (parent) {
    const pc = parent.composition;
    if (pc) {
      const assetKey = pc.assetRevision.split("#")[0];
      const bytes = await loadObjectBytes(assetKey);
      composite = {
        assetId: pc.assetId,
        assetName: pc.assetName,
        assetRevision: `${assetKey}#${sha12(bytes)}`,
        bytes,
        contentType: "",
        fixed: formatChanged ? undefined : { layout: pc.layout, placement: pc.placement },
      };
      if (formatChanged) {
        const d = await logoDimensions(bytes);
        reservedNote = `\nThe logo is placed by the system, not drawn by you. Leave one flat, solid ${PLACEHOLDER_HEX} (pure magenta) rectangle with an aspect ratio of ${d.width}:${d.height}, sharp corners and nothing inside it, where the logo belongs on the new canvas; draw no logo and use that color nowhere else.`;
      } else if (parent.baseStorageKey && pc.placement === "model_placeholder") {
        reservedNote = `\nThe flat solid ${PLACEHOLDER_HEX} rectangle in the image is reserved for the logo: keep it exactly as is (same position, size and color, nothing inside it) and draw no logo. Use ${PLACEHOLDER_HEX} nowhere else.`;
      } else if (parent.baseStorageKey) {
        const l = pc.layout;
        reservedNote = `\nThe logo is overlaid by the system afterwards at x=${l.x}, y=${l.y}, ${l.width}x${l.height} px: keep that area free of important content and draw no logo.`;
      }
    }
  } else {
    const pick = pickCompositeInput(resolved);
    if (pick) {
      composite = {
        assetId: pick.refId!,
        assetName: pick.name ?? `asset-${pick.refId}`,
        assetRevision: `${pick.storageKey}#${sha12(pick.assetFile!.bytes)}`,
        bytes: pick.assetFile!.bytes,
        contentType: pick.assetFile!.contentType,
      };
    }
  }
  // v1 composites ONE logo. Other exact_asset inputs (extra logos, uploaded
  // references) go to the model as before and are recorded as not composited.
  const notComposited = resolved
    .filter((i) => i.role === "exact_asset" && i !== pickCompositeInput(resolved))
    .map((i) => i.name ?? "exact asset");

  const revisionContext = priorPrompts.length
    ? `\n\nContext — the attached image is the current design. It was created from this request${priorPrompts.length > 1 ? " and these follow-up changes (oldest first)" : ""}:\n${priorPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}\nReference photos and assets from the original request are not re-attached; the attached image already contains them, so preserve them exactly as they appear.${reservedNote}`
    : "";
  const brief = parent
    ? (formatChanged
      ? `Re-render the current image adapted to a ${GENERATION_FORMATS[format].label} canvas: keep the same design elements, content, text and style, but RECOMPOSE the layout so it fills the entire new canvas edge to edge. Never letterbox, pillarbox, or place the old design inside bands or borders — rearrange, rescale and re-crop the elements to genuinely inhabit the new aspect ratio. ${args.prompt}`
      : `Revise the current image: ${args.prompt}\nKeep everything else unchanged.`) + revisionContext
    : buildBrief(args.prompt, resolved, format);
  const usageNotesSnapshot = parent
    ? ((parent.usageNotesSnapshot as string[] | null) ?? [])
    : resolved.flatMap((i) => i.usageNotes);
  // A revision keeps its parent's inputs, so it keeps the parent's snapshot too.
  const rightsSnapshot = parent
    ? (parent.rightsSnapshot ?? [])
    : resolved.flatMap((i) => (i.rights ? [i.rights] : []));
  const storedInputs: GenerationInput[] = parent
    ? ((parent.inputs as GenerationInput[] | null) ?? [])
    : resolved.map(({ kind, refId, storageKey, role, name }) => ({ kind, refId, storageKey, role, name }));
  const size = GENERATION_FORMATS[format]?.size ?? "1024x1024";
  // Fidelity records (#215). A revision keeps its parent's photo treatment and
  // grounding acknowledgements unless the caller supplies new ones.
  const photoTreatment: "reinterpreted" | null = parent
    ? (parent.photoTreatment === "reinterpreted" || (parent.photoTreatment == null && (parent.inputs as GenerationInput[]).some((i) => i.role === "hero_photo")) ? "reinterpreted" : null)
    : resolved.some((i) => i.role === "hero_photo") ? "reinterpreted" : null;
  const acknowledgedMissing = args.acknowledgedMissing ?? (parent?.acknowledgedMissing as string[] | null) ?? [];
  const requested = args.requestedFormat ?? format;
  const formatResolution = { requested, rendered: format, supported: requested === format };
  const variantCount = parent ? 1 : Math.min(Math.max(args.variantCount, 1), 3);

  // Async flow (#189): insert PENDING rows and return immediately — the model
  // calls take 15–60s+ per variant, far beyond proxy timeouts, so the client
  // polls the session while a background chain fills the rows in. Each variant
  // is an independent call (independently revisable),
  // processed sequentially: image calls are heavy and org keys have tight
  // rate limits.
  const generations: ImageGeneration[] = [];
  for (let variant = 0; variant < variantCount; variant++) {
    const [row] = await db
      .insert(imageGenerationsTable)
      .values({
        organizationId: args.organizationId,
        sessionId,
        parentGenerationId: parent?.id ?? null,
        prompt: args.prompt,
        settings: {
          ...args.settings,
          format,
          size,
          variantIndex: variant,
          variantCount,
          imageModel: "",
          ...(notComposited.length ? { notComposited } : {}),
        },
        photoTreatment,
        formatResolution,
        acknowledgedMissing,
        inputs: storedInputs,
        usageNotesSnapshot,
        rightsSnapshot,
        status: "pending",
      })
      .returning();
    generations.push(row);
  }

  await db
    .update(imageGenerationSessionsTable)
    .set({ updatedAt: new Date() })
    .where(eq(imageGenerationSessionsTable.id, sessionId));

  const inputImages = parentImage ? [parentImage] : resolved.map((i) => i.dataUrl);
  handoff.transferred = true;
  void (async () => {
    for (const row of generations) {
      try {
        await generationLimiter(() =>
          processGenerationRow(row, {
            apiKey: key.apiKey,
            baseURL: key.baseURL,
            brief,
            inputImages,
            size,
            composite,
          }),
        );
      } catch (err) {
        logger.error({ err, generationId: row.id }, "Generation job crashed");
      } finally {
        releaseGenerationSlots(args.organizationId, args.userId);
      }
    }
  })().catch((err) => logger.error({ err, sessionId }, "Generation background chain crashed"));

  return { sessionId, generations };
}

// Bound concurrent model calls across all in-flight requests — protects the
// org's provider rate limits and the droplet's memory.
const generationLimiter = createLimiter(2);

async function processGenerationRow(
  row: ImageGeneration,
  ctx: {
    apiKey: string;
    baseURL: string | null;
    brief: string;
    inputImages: string[] | undefined;
    size: ImageSize;
    composite: CompositeJob | null;
  },
): Promise<void> {
  try {
    const image = await generateImage({
      apiKey: ctx.apiKey,
      baseURL: ctx.baseURL,
      brief: ctx.brief,
      inputImages: ctx.inputImages,
      size: ctx.size,
    });
    // Exact logo (#215): keep the model's output as the BASE image, then place
    // the original logo file. Any failure here fails the whole generation (it
    // must never end "succeeded" without the logo it was asked to carry).
    let finalBuffer = image.buffer;
    let baseStorageKey: string | null = null;
    let composition: GenerationCompositionRecord | null = null;
    if (ctx.composite) {
      const job = ctx.composite;
      baseStorageKey = (await storeGeneratedPng(row.organizationId, image.buffer)).storageKey;
      const result = await compositeLogo(image.buffer, job.bytes, job.fixed?.layout ?? null, {
        contentType: job.contentType,
        placement: job.fixed?.placement,
      });
      finalBuffer = result.image;
      composition = {
        mode: "exact_logo",
        assetId: job.assetId,
        assetName: job.assetName,
        assetRevision: job.assetRevision,
        layout: result.layout,
        placement: result.placement,
      };
    }
    const stored = await storeGeneratedPng(row.organizationId, finalBuffer);
    const settings = { ...(row.settings as Record<string, unknown>), imageModel: image.imageModel };
    await db
      .update(imageGenerationsTable)
      .set({
        openaiResponseId: image.responseId,
        settings,
        baseStorageKey,
        composition,
        provenance: { model: image.imageModel || null, settings },
        storageKey: stored.storageKey,
        contentType: "image/png",
        width: stored.width,
        height: stored.height,
        status: "succeeded",
      })
      .where(eq(imageGenerationsTable.id, row.id));
  } catch (err) {
    // The real error (provider/storage/db detail) is logged; the row, which the
    // client reads back, only gets a generic message.
    logger.error({ err, generationId: row.id }, "Image generation failed");
    await db
      .update(imageGenerationsTable)
      .set({ status: "failed", error: GENERIC_GENERATION_ERROR })
      .where(eq(imageGenerationsTable.id, row.id))
      .catch(() => {});
  }
}

/**
 * Boot sweep: pending rows can only be in-flight in THIS process (the work is
 * an in-memory background chain), so any row still pending at startup was
 * orphaned by a restart/deploy — fail it so the client's polling settles.
 */
export async function failOrphanedGenerations(): Promise<void> {
  const rows = await db
    .update(imageGenerationsTable)
    .set({ status: "failed", error: "Interrupted by a server restart — try again." })
    .where(eq(imageGenerationsTable.status, "pending"))
    .returning({ id: imageGenerationsTable.id });
  if (rows.length > 0) {
    logger.warn({ count: rows.length }, "Failed orphaned pending generations from a previous process");
  }
}
