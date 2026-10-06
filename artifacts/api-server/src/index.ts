import app from "./app";
import { logger } from "./lib/logger";
import { generateAndStoreThumbnail } from "./lib/thumbnailGeneration";
import { backfillContentHashes } from "./lib/contentHash";
import { startAiAutoBackfillScheduler } from "./lib/aiAutoBackfillScheduler";
import { startBillingReconcileScheduler } from "./lib/billing/reconcileScheduler";
import { db, photosTable } from "@workspace/db";
import { isNull, isNotNull, and, eq } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function backfillMissingThumbnails(): Promise<void> {
  try {
    // Clear any stuck thumbnailGenerating=true flags left over from a previous interrupted process.
    await db
      .update(photosTable)
      .set({ thumbnailGenerating: false })
      .where(and(isNull(photosTable.thumbnailKey), eq(photosTable.thumbnailGenerating, true)));

    const photos = await db
      .select({ id: photosTable.id, storageKey: photosTable.storageKey })
      .from(photosTable)
      .where(and(isNull(photosTable.thumbnailKey), isNotNull(photosTable.storageKey), eq(photosTable.thumbnailGenerating, false)));

    if (photos.length === 0) {
      logger.info("Startup thumbnail backfill: no photos missing thumbnails");
      return;
    }

    logger.info({ count: photos.length }, "Startup thumbnail backfill: beginning background generation");

    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const photo of photos) {
      if (!photo.storageKey) continue;
      const result = await generateAndStoreThumbnail(photo.id, photo.storageKey);
      if (result === "success") {
        succeeded++;
      } else if (result === "skipped") {
        skipped++;
      } else {
        failed++;
        logger.warn({ photoId: photo.id }, "Startup thumbnail backfill: failed for photo");
      }
    }

    logger.info({ succeeded, skipped, failed }, "Startup thumbnail backfill: complete");
  } catch (err) {
    logger.error({ err }, "Startup thumbnail backfill: unexpected error");
  }
}

async function backfillMissingContentHashes(): Promise<void> {
  try {
    const result = await backfillContentHashes();
    if (result.processed === 0) {
      logger.info("Startup content hash backfill: no photos missing a content hash");
      return;
    }
    logger.info(result, "Startup content hash backfill: complete");
  } catch (err) {
    logger.error({ err }, "Startup content hash backfill: unexpected error");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  void backfillMissingThumbnails();
  void backfillMissingContentHashes();
  startAiAutoBackfillScheduler();
  startBillingReconcileScheduler(); // no-op unless Stripe is configured
});
