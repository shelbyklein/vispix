import { db, organizationsTable, organizationSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { loadOrgSettings } from "./aiProviders";
import { backfillAiAnalysis, countPhotosNeedingAiAnalysis } from "./aiAnalysisBackfill";
import { listPhotoIdsNeedingEmbedding } from "./embeddingBackfill";
import { generateAndStorePhotoEmbedding } from "./aiEmbedding";
import { logger } from "./logger";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let isRunning = false;

// Photos whose embedding attempt failed this process lifetime — skipped on
// later ticks so a batch of unembeddable photos (missing bytes, Vertex errors)
// can't wedge the sweep retrying forever. In-memory on purpose (single-instance
// droplet): a restart retries them once more.
const embedFailedIds = new Set<number>();

// Per-org (#113): each org opts into automatic AI backfill independently, and a
// tick only processes that org's own photos with that org's provider/key.
async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const orgs = await db.select({ id: organizationsTable.id }).from(organizationsTable);
    for (const org of orgs) {
      const settings = await loadOrgSettings(org.id);
      if (!settings.aiAutoBackfillEnabled) continue;

      const batchSize = settings.aiAutoBackfillBatchSize;

      const missingCount = await countPhotosNeedingAiAnalysis(org.id);
      if (missingCount > 0) {
        logger.info(
          { orgId: org.id, missingCount, batchSize },
          "Automatic AI analysis backfill: starting batch",
        );
        const result = await backfillAiAnalysis(batchSize, "automatic", org.id);
        logger.info({ orgId: org.id, ...result }, "Automatic AI analysis backfill: batch complete");
      }

      // Embedding sweep (same opt-in): covers photos the analysis pass can't
      // reach — analysis-capped photos, and described photos whose vector is
      // still image-only (the description-blend upgrade). Cheap: embedding
      // calls only, no LLM. Successful analyses above already re-embedded
      // their own photos, so this typically has little left to do.
      if (settings.embeddingEnabled) {
        // Over-fetch so already-failed ids don't shrink the effective batch.
        const ids = (await listPhotoIdsNeedingEmbedding(batchSize + embedFailedIds.size, org.id))
          .filter((id) => !embedFailedIds.has(id))
          .slice(0, batchSize);
        if (ids.length > 0) {
          let succeeded = 0;
          for (const id of ids) {
            if (await generateAndStorePhotoEmbedding(id)) succeeded++;
            else embedFailedIds.add(id);
          }
          logger.info(
            { orgId: org.id, attempted: ids.length, succeeded },
            "Automatic embedding backfill: batch complete",
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Automatic AI analysis backfill: unexpected error");
  } finally {
    isRunning = false;
  }
}

export function startAiAutoBackfillScheduler(): void {
  setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
}

export async function getAiAutoBackfillSettings(organizationId: number): Promise<{
  enabled: boolean;
  batchSize: number;
}> {
  const settings = await loadOrgSettings(organizationId);
  return { enabled: settings.aiAutoBackfillEnabled, batchSize: settings.aiAutoBackfillBatchSize };
}

export async function updateAiAutoBackfillSettings(
  organizationId: number,
  input: { enabled?: boolean; batchSize?: number },
): Promise<{ enabled: boolean; batchSize: number }> {
  await loadOrgSettings(organizationId);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.aiAutoBackfillEnabled = input.enabled;
  if (input.batchSize !== undefined) updates.aiAutoBackfillBatchSize = input.batchSize;

  const [updated] = await db
    .update(organizationSettingsTable)
    .set(updates)
    .where(eq(organizationSettingsTable.organizationId, organizationId))
    .returning();

  return { enabled: updated.aiAutoBackfillEnabled, batchSize: updated.aiAutoBackfillBatchSize };
}
