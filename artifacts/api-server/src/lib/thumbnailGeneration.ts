import sharp from "sharp";
import exifReader from "exif-reader";
import { randomUUID } from "crypto";
import { objectStorageClient, parseObjectPath, signObjectURL, getPrivateObjectDir } from "./objectStorage";
import { db, photosTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { createLimiter } from "./concurrencyLimit";

const THUMBNAIL_WIDTH = 600;

// Bound concurrent generations: each downloads the full-size source image,
// and uploads fire these off without awaiting.
const thumbnailLimiter = createLimiter(2);

export function parseExifDateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  // EXIF date strings use "YYYY:MM:DD HH:MM:SS" format
  const match = String(value).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(min), Number(sec)));
  return isNaN(date.getTime()) ? null : date;
}

export async function extractExifDate(buffer: Buffer): Promise<Date | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (!metadata.exif) return null;
    const exif = exifReader(metadata.exif);
    const rawDate = (exif.Photo?.DateTimeOriginal ?? exif.Image?.DateTime) as Date | string | null | undefined;
    return parseExifDateValue(rawDate);
  } catch {
    return null;
  }
}

/**
 * Display dimensions of an image: sharp reports the stored pixel grid, so for
 * EXIF orientations 5-8 (90°/270° rotations) width and height are swapped to
 * match how the photo actually renders.
 */
export function extractDisplayDimensions(metadata: {
  width?: number;
  height?: number;
  orientation?: number;
}): { width: number; height: number } | null {
  const { width, height, orientation } = metadata;
  if (!width || !height) return null;
  return (orientation ?? 1) >= 5 ? { width: height, height: width } : { width, height };
}

export type ThumbnailResult = "success" | "skipped" | "failed";

const inProgressPhotoIds = new Set<number>();

export function generateAndStoreThumbnail(photoId: number, storageKey: string): Promise<ThumbnailResult> {
  return thumbnailLimiter(() => generateAndStoreThumbnailUnbounded(photoId, storageKey));
}

async function generateAndStoreThumbnailUnbounded(photoId: number, storageKey: string): Promise<ThumbnailResult> {
  if (inProgressPhotoIds.has(photoId)) {
    logger.info({ photoId }, "Thumbnail generation already in progress for photo, skipping duplicate");
    return "skipped";
  }

  const claimed = await db
    .update(photosTable)
    .set({ thumbnailGenerating: true })
    .where(and(eq(photosTable.id, photoId), eq(photosTable.thumbnailGenerating, false)))
    .returning({ id: photosTable.id });

  if (claimed.length === 0) {
    logger.info({ photoId }, "Thumbnail generation already claimed by another process, skipping duplicate");
    return "skipped";
  }

  inProgressPhotoIds.add(photoId);
  try {
    if (!storageKey.startsWith("/objects/")) {
      logger.warn({ photoId, storageKey }, "Cannot generate thumbnail: unexpected storageKey format");
      return "skipped";
    }

    // Thumbnails are keyed under the photo's org so the storage ACL serves
    // them to that org's members (unprefixed keys gate to the default org).
    const [photoRow] = await db
      .select({ organizationId: photosTable.organizationId })
      .from(photosTable)
      .where(eq(photosTable.id, photoId));
    if (!photoRow) return "skipped";

    const privateObjectDir = getPrivateObjectDir();
    const entityId = storageKey.slice("/objects/".length);
    let entityDir = privateObjectDir;
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const sourceFile = bucket.file(objectName);

    const [exists] = await sourceFile.exists();
    if (!exists) {
      logger.warn({ photoId, storageKey }, "Source file not found, skipping thumbnail generation");
      return "skipped";
    }

    const [sourceBuffer] = await sourceFile.download();

    const sourceMetadata = await sharp(sourceBuffer).metadata();
    const dimensions = extractDisplayDimensions(sourceMetadata);

    const thumbnailBuffer = await sharp(sourceBuffer)
      // Bake EXIF orientation into the pixels: sharp strips metadata on output,
      // so without this a rotated portrait shot renders sideways. Also keeps
      // the stored width/height consistent with how the thumbnail displays.
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();

    const thumbnailId = `orgs/${photoRow.organizationId}/thumbnails/${randomUUID()}`;
    const thumbnailPath = `${entityDir}${thumbnailId}`;
    const { bucketName: thumbBucket, objectName: thumbObject } = parseObjectPath(thumbnailPath);

    const uploadURL = await signObjectURL({
      bucketName: thumbBucket,
      objectName: thumbObject,
      method: "PUT",
      ttlSec: 900,
    });

    // The storage emulator occasionally stalls under bulk-upload load; one
    // retry recovers instead of leaving the photo without a thumbnail.
    let uploadResponse: Response | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        uploadResponse = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: thumbnailBuffer,
          signal: AbortSignal.timeout(60_000),
        });
        if (uploadResponse.ok) break;
      } catch (err) {
        if (attempt === 2) throw err;
        logger.warn({ photoId, err }, "Thumbnail upload attempt failed, retrying");
      }
    }

    if (!uploadResponse?.ok) {
      throw new Error(`Thumbnail upload failed with status ${uploadResponse?.status}`);
    }

    const thumbnailKey = `/objects/${thumbnailId}`;

    await db
      .update(photosTable)
      .set({ thumbnailKey, ...(dimensions ?? {}) })
      .where(eq(photosTable.id, photoId));

    const exifDate = await extractExifDate(sourceBuffer);
    if (exifDate) {
      const updated = await db
        .update(photosTable)
        .set({ takenAt: exifDate })
        .where(and(eq(photosTable.id, photoId), isNull(photosTable.takenAt)))
        .returning({ id: photosTable.id });
      if (updated.length > 0) {
        logger.info({ photoId, takenAt: exifDate }, "takenAt populated from EXIF data");
      }
    }

    logger.info({ photoId, thumbnailKey }, "Thumbnail generated and stored");
    return "success";
  } catch (err) {
    logger.error({ err, photoId, storageKey }, "Thumbnail generation failed");
    return "failed";
  } finally {
    inProgressPhotoIds.delete(photoId);
    await db
      .update(photosTable)
      .set({ thumbnailGenerating: false })
      .where(eq(photosTable.id, photoId));
  }
}
