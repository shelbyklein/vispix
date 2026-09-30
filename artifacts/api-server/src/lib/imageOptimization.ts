import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db, photosTable, organizationSettingsTable } from "@workspace/db";
import { objectStorageClient, parseObjectPath, getPrivateObjectDir } from "./objectStorage";
import { keyBelongsToOrg } from "./storageKeys";
import { logger } from "./logger";
import { createLimiter } from "./concurrencyLimit";

// Balanced WebP settings (see plan): near-lossless quality, only downscale very
// large images, preserve EXIF + orientation.
const WEBP_QUALITY = 82;
const WEBP_EFFORT = 4;
const MAX_EDGE = 4000;

// Surfaced on the admin status endpoint so the UI can describe the settings.
export const IMAGE_OPTIMIZATION_SETTINGS = { quality: WEBP_QUALITY, maxEdge: MAX_EDGE };
// Only replace the original if the WebP is meaningfully smaller — leaves
// already-efficient uploads (e.g. WebP the user already converted) untouched.
const MIN_SAVINGS_RATIO = 0.95;

// Each job downloads + re-encodes a full-size image; bound peak memory like the
// thumbnail / hash pipelines.
const optimizeLimiter = createLimiter(2);

function resolveSourceFile(storageKey: string) {
  const privateObjectDir = getPrivateObjectDir();
  const entityDirBase = privateObjectDir.endsWith("/") ? privateObjectDir : `${privateObjectDir}/`;
  const entityId = storageKey.slice("/objects/".length);
  const objectEntityPath = `${entityDirBase}${entityId}`;
  const { bucketName, objectName } = parseObjectPath(objectEntityPath);
  return objectStorageClient.bucket(bucketName).file(objectName);
}

async function isImageOptimizationEnabled(organizationId: number): Promise<boolean> {
  const [s] = await db
    .select({ enabled: organizationSettingsTable.imageOptimizationEnabled })
    .from(organizationSettingsTable)
    .where(eq(organizationSettingsTable.organizationId, organizationId));
  // Default on: if the org has no settings row yet, still optimize.
  return s ? Boolean(s.enabled) : true;
}

// Swap a filename's extension to .webp so downloads get a correctly-named file
// (the stored bytes are now WebP). Preserves the original stem.
function toWebpFilename(filename: string | null): string | null {
  if (!filename) return filename;
  if (/\.webp$/i.test(filename)) return filename;
  return filename.replace(/\.[^./\\]+$/, "") + ".webp";
}

export type ImageOptimizationResult = "success" | "skipped" | "failed";

/**
 * Re-encode a just-uploaded original to WebP in place (same storage object),
 * preserving EXIF/orientation, and update the row's filesize/filename. Runs
 * before the thumbnail/hash/embedding jobs so they see the final bytes. Safe to
 * fire-and-forget: no-ops (returns "skipped") when disabled, animated, or not
 * worth re-encoding, and returns "failed" (leaving the original intact) on any
 * decode/encode/storage error.
 */
export function optimizeOriginalImage(
  photoId: number,
  storageKey: string,
  organizationId: number,
): Promise<ImageOptimizationResult> {
  return optimizeLimiter(() => optimizeOriginalImageUnbounded(photoId, storageKey, organizationId));
}

async function optimizeOriginalImageUnbounded(
  photoId: number,
  storageKey: string,
  organizationId: number,
): Promise<ImageOptimizationResult> {
  if (!storageKey.startsWith("/objects/")) {
    return "skipped";
  }
  // Never overwrite another org's object through this org's row.
  if (!keyBelongsToOrg(storageKey, organizationId)) {
    logger.warn({ photoId, storageKey, organizationId }, "Refusing to optimize an object outside the photo's organization");
    return "skipped";
  }

  if (!(await isImageOptimizationEnabled(organizationId))) {
    return "skipped";
  }

  try {
    const sourceFile = resolveSourceFile(storageKey);
    const [exists] = await sourceFile.exists();
    if (!exists) {
      logger.warn({ photoId, storageKey }, "Source file not found, skipping optimization");
      return "skipped";
    }

    const [sourceBuffer] = await sourceFile.download();
    const sourceSize = sourceBuffer.length;

    const meta = await sharp(sourceBuffer).metadata();
    // Preserve animated images (GIF/WebP): re-encoding to a still frame would
    // drop the animation.
    if (meta.pages && meta.pages > 1) {
      return "skipped";
    }

    const webp = await sharp(sourceBuffer)
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .keepMetadata() // retain EXIF (incl. DateTimeOriginal) + ICC + orientation
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer();

    // Don't bloat / needlessly churn already-efficient images.
    if (webp.length >= sourceSize * MIN_SAVINGS_RATIO) {
      logger.info(
        { photoId, sourceSize, webpSize: webp.length },
        "Optimization not beneficial, keeping original",
      );
      return "skipped";
    }

    // Overwrite the same object with the WebP bytes + content-type. storageKey /
    // url stay the same, so the already-fired downstream jobs remain valid.
    await sourceFile.save(webp, { resumable: false, contentType: "image/webp" });

    const [current] = await db
      .select({ filename: photosTable.filename })
      .from(photosTable)
      .where(eq(photosTable.id, photoId));

    await db
      .update(photosTable)
      .set({ filesize: webp.length, filename: toWebpFilename(current?.filename ?? null) })
      .where(eq(photosTable.id, photoId));

    logger.info(
      { photoId, sourceSize, webpSize: webp.length, saved: sourceSize - webp.length },
      "Optimized original to WebP",
    );
    return "success";
  } catch (err) {
    logger.error({ err, photoId, storageKey }, "Image optimization failed");
    return "failed";
  }
}
