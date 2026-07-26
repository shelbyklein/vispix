import { sql, isNotNull, and, eq } from "drizzle-orm";
import { db, photosTable } from "@workspace/db";
import { generateAndStorePhotoEmbedding } from "./aiEmbedding";
import { logger } from "./logger";

// Photos that have a storageKey (so bytes are fetchable) and either no
// embedding yet, or an image-only vector while the photo now has an AI
// description — descriptions are blended into the stored vector, so those get
// progressively re-embedded (the '+desc' model-tag suffix marks blended
// vectors; see aiEmbedding.ts).
const needsEmbedding = and(
  isNotNull(photosTable.storageKey),
  sql`(
    NOT EXISTS (SELECT 1 FROM photo_embeddings pe WHERE pe.photo_id = ${photosTable.id})
    OR (
      ${photosTable.aiDescription} IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM photo_embeddings pe
        WHERE pe.photo_id = ${photosTable.id} AND pe.model NOT LIKE '%+desc'
      )
    )
  )`,
);

// Scope to one org (#113) when an id is given; otherwise instance-wide.
function needsEmbeddingIn(organizationId?: number) {
  return organizationId != null
    ? and(needsEmbedding, eq(photosTable.organizationId, organizationId))
    : needsEmbedding;
}

export async function countPhotosNeedingEmbedding(organizationId?: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as integer)` })
    .from(photosTable)
    .where(needsEmbeddingIn(organizationId));
  return row?.n ?? 0;
}

/** A batch of photo ids still needing (re-)embedding — for the auto scheduler. */
export async function listPhotoIdsNeedingEmbedding(limit: number, organizationId?: number): Promise<number[]> {
  const rows = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(needsEmbeddingIn(organizationId))
    .orderBy(photosTable.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

// --- Cancellable background backfill with live progress (#31) ---
//
// The embedding backfill can run for thousands of photos, so instead of one
// blocking request it runs as a fire-and-forget per-org job the admin can poll
// and stop. State lives in memory — fine for the single-instance droplet; a
// restart just ends the job (already-embedded photos are persisted and the
// admin can resume). One job per org at a time.

export type EmbeddingJob = {
  running: boolean;
  total: number; // photos this batch will attempt (0 until counted)
  processed: number;
  succeeded: number;
  failed: number;
  stopped: boolean; // true if halted early by a stop request
  startedAt: string;
  finishedAt: string | null;
};

type JobInternal = Omit<EmbeddingJob, "startedAt" | "finishedAt"> & {
  stopRequested: boolean;
  startedAt: Date;
  finishedAt: Date | null;
};

const jobs = new Map<number, JobInternal>();

function serialize(j: JobInternal): EmbeddingJob {
  return {
    running: j.running,
    total: j.total,
    processed: j.processed,
    succeeded: j.succeeded,
    failed: j.failed,
    stopped: j.stopped,
    startedAt: j.startedAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  };
}

// The most recent job for an org (running or last-finished), or null if none.
export function getEmbeddingJob(organizationId: number): EmbeddingJob | null {
  const j = jobs.get(organizationId);
  return j ? serialize(j) : null;
}

// Request a clean halt of a running job; the loop stops before the next photo.
export function stopEmbeddingBackfill(organizationId: number): EmbeddingJob | null {
  const j = jobs.get(organizationId);
  if (j && j.running) j.stopRequested = true;
  return j ? serialize(j) : null;
}

// Start (or return the already-running) backfill for an org. Returns immediately
// with the initial job state; the work continues in the background.
export function startEmbeddingBackfill(organizationId: number, limit?: number): EmbeddingJob {
  const existing = jobs.get(organizationId);
  if (existing && existing.running) return serialize(existing);

  const job: JobInternal = {
    running: true,
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    stopped: false,
    stopRequested: false,
    startedAt: new Date(),
    finishedAt: null,
  };
  jobs.set(organizationId, job);
  void runBackfill(organizationId, job, limit);
  return serialize(job);
}

async function runBackfill(organizationId: number, job: JobInternal, limit?: number): Promise<void> {
  try {
    const base = db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(needsEmbeddingIn(organizationId))
      .orderBy(photosTable.createdAt);
    const photos = limit != null ? await base.limit(limit) : await base;
    job.total = photos.length;

    for (const photo of photos) {
      if (job.stopRequested) {
        job.stopped = true;
        break;
      }
      try {
        const ok = await generateAndStorePhotoEmbedding(photo.id);
        if (ok) job.succeeded++;
        else job.failed++;
      } catch (err) {
        job.failed++;
        logger.warn({ err, photoId: photo.id }, "Embedding backfill failed for photo");
      }
      job.processed++;
    }
  } catch (err) {
    logger.error({ err, organizationId }, "Embedding backfill job errored");
  } finally {
    job.running = false;
    job.finishedAt = new Date();
  }
}
