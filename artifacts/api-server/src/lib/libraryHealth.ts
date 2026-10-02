import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, photosTable, aiAnalysisEventsTable } from "@workspace/db";
import { loadOrgSettings, summarizeSettings } from "./aiProviders";
import { getEmbeddingConfigStatus } from "./aiEmbedding";
import { getEmbeddingHealth, type EmbeddingFailureCode } from "./embeddingHealth";
import { countPhotosNeedingEmbedding } from "./embeddingBackfill";
import { getDuplicatesSummary } from "./contentHash";
import { DEFAULT_NEAR_DUP_THRESHOLD, getNearDuplicateIndexStatus, listNearDuplicatePhotoGroups } from "./perceptualHash";
import { isQuotaError } from "./orgIncidentAlerts";

// Dashboard library health (#217): separates "a provider is configured" from
// "it has actually worked recently", and reports processing coverage with
// denominators. Everything is derived from outcomes of REAL operations that
// were already recorded — ai_analysis_events rows, photo_embeddings rows, and
// the in-memory embeddingHealth store. Nothing here calls an AI provider, so
// loading the dashboard is never billable. No alerting is added or triggered.

/**
 * Per-service state:
 *  - not_configured: nothing to run with (no key / feature off / no project)
 *  - configured:     set up, but no real operation observed yet ("not yet verified")
 *  - working:        newest evidence is a success within STALE_EVIDENCE_MS
 *  - failing:        newest evidence is a failure within STALE_EVIDENCE_MS
 *  - stale:          newest evidence (success or failure) is older than STALE_EVIDENCE_MS
 */
export type HealthState = "not_configured" | "configured" | "working" | "failing" | "stale";

/** Evidence older than this is no longer trusted: the state decays to "stale". */
export const STALE_EVIDENCE_DAYS = 7;
export const STALE_EVIDENCE_MS = STALE_EVIDENCE_DAYS * 24 * 60 * 60 * 1000;

export function deriveHealthState(input: {
  configured: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  now?: Date;
}): HealthState {
  if (!input.configured) return "not_configured";
  const { lastSuccessAt, lastFailureAt } = input;
  if (!lastSuccessAt && !lastFailureAt) return "configured";
  const failureIsNewest = lastFailureAt != null && (lastSuccessAt == null || lastFailureAt > lastSuccessAt);
  const newest = failureIsNewest ? lastFailureAt! : lastSuccessAt!;
  const now = (input.now ?? new Date()).getTime();
  if (now - newest.getTime() > STALE_EVIDENCE_MS) return "stale";
  return failureIsNewest ? "failing" : "working";
}

export type FailureReasonCode = "quota" | "auth" | "timeout" | "no_result" | "provider_error";
export interface FailureReason {
  code: FailureReasonCode;
  /** Fixed, secret-free sentence — never the provider's raw text. */
  message: string;
}

const FAILURE_MESSAGES: Record<FailureReasonCode, string> = {
  quota: "Provider quota or rate limit reached",
  auth: "Provider rejected the credentials",
  timeout: "Provider request timed out",
  no_result: "Provider returned no usable result",
  provider_error: "Provider request failed",
};

/** Map a stored analysis error message to a safe, fixed reason (the raw text is never returned). */
export function classifyAnalysisFailure(raw: string | null | undefined): FailureReason {
  const msg = (raw ?? "").toLowerCase();
  let code: FailureReasonCode = "provider_error";
  if (isQuotaError(msg)) code = "quota";
  else if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]{0,20}(api )?key|incorrect api key|permission denied|authentication/.test(msg)) code = "auth";
  else if (/timed? ?out|timeout|etimedout|aborted/.test(msg)) code = "timeout";
  else if (msg.includes("returned no result")) code = "no_result";
  return { code, message: FAILURE_MESSAGES[code] };
}

function embeddingFailureReason(code: EmbeddingFailureCode | null): FailureReason | null {
  if (!code) return null;
  return {
    code: code === "timeout" ? "timeout" : "provider_error",
    message: code === "timeout" ? "Embedding request timed out" : "Embedding request failed",
  };
}

export interface ServiceHealth {
  state: HealthState;
  /** Short human summary of the state, safe to render verbatim. */
  detail: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Reason for the most recent failure, only while a failure is the newest evidence. */
  failureReason: FailureReason | null;
}

export interface LibraryHealth {
  generatedAt: string;
  staleAfterDays: number;
  imageAnalysis: ServiceHealth & {
    /** Configured provider id (e.g. "openai"), or null when none is usable. */
    provider: string | null;
    /** Provider of the most recent real analysis attempt. */
    lastUsedProvider: string | null;
    coverage: { total: number; analysed: number; failed: number; pending: number };
  };
  imageEmbeddings: ServiceHealth & {
    coverage: { total: number; embedded: number; missing: number; refreshPending: number };
  };
  /** Search-time text → vector embedding: is semantic search operational? */
  searchEmbedding: ServiceHealth;
  duplicates: {
    exact: { groups: number; extraCopies: number; hashedPhotos: number; totalPhotos: number };
    near: { groups: number; photos: number; threshold: number; indexedPhotos: number; totalPhotos: number };
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const newer = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

function describe(
  state: HealthState,
  what: { working: string; notConfigured: string; configured: string },
  reason: FailureReason | null,
): string {
  switch (state) {
    case "not_configured":
      return what.notConfigured;
    case "configured":
      return what.configured;
    case "working":
      return what.working;
    case "failing":
      return reason?.message ?? "Last attempt failed";
    case "stale":
      return `No activity in the last ${STALE_EVIDENCE_DAYS} days — not re-checked`;
  }
}

async function imageAnalysisHealth(orgId: number, now: Date): Promise<LibraryHealth["imageAnalysis"]> {
  const settings = summarizeSettings(await loadOrgSettings(orgId));
  const active = settings.providers[settings.activeProvider];
  const configured = settings.enabled && settings.hasUsableActive;

  // Events carry no org id, so scope through the photo they were recorded for.
  const orgEvents = (status: "success" | "failed") =>
    db
      .select({
        at: aiAnalysisEventsTable.createdAt,
        provider: aiAnalysisEventsTable.provider,
        error: aiAnalysisEventsTable.errorMessage,
      })
      .from(aiAnalysisEventsTable)
      .innerJoin(photosTable, eq(photosTable.id, aiAnalysisEventsTable.photoId))
      .where(and(eq(photosTable.organizationId, orgId), eq(aiAnalysisEventsTable.status, status)))
      .orderBy(desc(aiAnalysisEventsTable.createdAt), desc(aiAnalysisEventsTable.id))
      .limit(1);
  const [[lastOk], [lastFail], coverageRes] = await Promise.all([
    orgEvents("success"),
    orgEvents("failed"),
    db.execute<{ total: number; analysed: number; failed: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE p.ai_description IS NOT NULL)::int AS analysed,
             count(*) FILTER (
               WHERE p.ai_description IS NULL
                 AND (SELECT e.status FROM ai_analysis_events e WHERE e.photo_id = p.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'failed'
             )::int AS failed
      FROM photos p WHERE p.organization_id = ${orgId}
    `),
  ]);
  const lastSuccessAt = lastOk?.at ?? null;
  const lastFailureAt = lastFail?.at ?? null;
  const state = deriveHealthState({ configured, lastSuccessAt, lastFailureAt, now });
  const reason = state === "failing" ? classifyAnalysisFailure(lastFail?.error) : null;
  const c = coverageRes.rows[0] ?? { total: 0, analysed: 0, failed: 0 };

  let notConfigured = "No AI provider key for this organization";
  if (!settings.enabled) notConfigured = "AI analysis is turned off for this organization";
  const lastUsed = lastOk && lastFail ? (lastOk.at > lastFail.at ? lastOk : lastFail) : (lastOk ?? lastFail);

  return {
    state,
    detail: describe(
      state,
      {
        working: "Photo analysis is succeeding",
        notConfigured,
        configured: "Provider configured, no analysis attempted yet — not yet verified",
      },
      reason,
    ),
    lastSuccessAt: iso(lastSuccessAt),
    lastFailureAt: iso(lastFailureAt),
    failureReason: reason,
    provider: configured ? active.id : null,
    lastUsedProvider: lastUsed?.provider ?? null,
    coverage: {
      total: c.total,
      analysed: c.analysed,
      failed: c.failed,
      pending: Math.max(0, c.total - c.analysed - c.failed),
    },
  };
}

async function imageEmbeddingsHealth(orgId: number, now: Date): Promise<LibraryHealth["imageEmbeddings"]> {
  const cfg = await getEmbeddingConfigStatus(orgId);
  const configured = cfg.enabled && cfg.projectConfigured;

  const [coverageRes, needing] = await Promise.all([
    db.execute<{ total: number; embedded: number; last_at: Date | string | null }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE pe.photo_id IS NOT NULL)::int AS embedded,
             max(pe.created_at) AS last_at
      FROM photos p LEFT JOIN photo_embeddings pe ON pe.photo_id = p.id
      WHERE p.organization_id = ${orgId} AND p.storage_key IS NOT NULL
    `),
    countPhotosNeedingEmbedding(orgId),
  ]);
  const c = coverageRes.rows[0] ?? { total: 0, embedded: 0, last_at: null };
  const dbLast = c.last_at ? new Date(c.last_at) : null;
  const mem = getEmbeddingHealth("image", orgId);
  const lastSuccessAt = newer(dbLast, mem.lastSuccessAt);
  const lastFailureAt = mem.lastFailureAt;
  const state = deriveHealthState({ configured, lastSuccessAt, lastFailureAt, now });
  const reason = state === "failing" ? embeddingFailureReason(mem.lastFailureCode) : null;
  const missing = Math.max(0, c.total - c.embedded);

  let notConfigured = "Embeddings are turned off for this organization";
  if (cfg.enabled && !cfg.projectConfigured) notConfigured = "Embedding project is not configured on this server";

  return {
    state,
    detail: describe(
      state,
      {
        working: "Photo embeddings are being created",
        notConfigured,
        configured: "Configured, no embedding created yet — not yet verified",
      },
      reason,
    ),
    lastSuccessAt: iso(lastSuccessAt),
    lastFailureAt: iso(lastFailureAt),
    failureReason: reason,
    coverage: {
      total: c.total,
      embedded: c.embedded,
      missing,
      refreshPending: Math.max(0, needing - missing),
    },
  };
}

async function searchEmbeddingHealth(orgId: number, now: Date): Promise<ServiceHealth> {
  const cfg = await getEmbeddingConfigStatus(orgId);
  // Query embedding needs only the server-level Vertex project; evidence is the
  // in-memory record of real searches (no probe is ever made).
  const configured = cfg.projectConfigured;
  const mem = getEmbeddingHealth("query", orgId);
  const state = deriveHealthState({ configured, lastSuccessAt: mem.lastSuccessAt, lastFailureAt: mem.lastFailureAt, now });
  const reason = state === "failing" ? embeddingFailureReason(mem.lastFailureCode) : null;
  return {
    state,
    detail: describe(
      state,
      {
        working: "Search queries are being embedded",
        notConfigured: "Embedding project is not configured on this server — concept search is unavailable",
        configured: "Configured, no search query embedded since the server started — not yet verified",
      },
      reason,
    ),
    lastSuccessAt: iso(mem.lastSuccessAt),
    lastFailureAt: iso(mem.lastFailureAt),
    failureReason: reason,
  };
}

async function duplicatesHealth(orgId: number): Promise<LibraryHealth["duplicates"]> {
  const [exact, nearGroups, nearIndex, hashRes] = await Promise.all([
    getDuplicatesSummary(orgId),
    listNearDuplicatePhotoGroups(DEFAULT_NEAR_DUP_THRESHOLD, orgId),
    getNearDuplicateIndexStatus(orgId),
    db
      .select({
        total: sql<number>`count(*)::int`,
        hashed: sql<number>`count(*) filter (where ${isNotNull(photosTable.contentHash)})::int`,
      })
      .from(photosTable)
      .where(eq(photosTable.organizationId, orgId)),
  ]);
  const totalPhotos = hashRes[0]?.total ?? 0;
  return {
    exact: {
      groups: exact.groupCount,
      extraCopies: exact.extraCount,
      hashedPhotos: hashRes[0]?.hashed ?? 0,
      totalPhotos,
    },
    near: {
      groups: nearGroups.length,
      photos: nearGroups.reduce((n, g) => n + g.photos.length, 0),
      threshold: DEFAULT_NEAR_DUP_THRESHOLD,
      indexedPhotos: nearIndex.hashedPhotos,
      totalPhotos,
    },
  };
}

export async function buildLibraryHealth(organizationId: number, now: Date = new Date()): Promise<LibraryHealth> {
  const [imageAnalysis, imageEmbeddings, searchEmbedding, duplicates] = await Promise.all([
    imageAnalysisHealth(organizationId, now),
    imageEmbeddingsHealth(organizationId, now),
    searchEmbeddingHealth(organizationId, now),
    duplicatesHealth(organizationId),
  ]);
  return {
    generatedAt: now.toISOString(),
    staleAfterDays: STALE_EVIDENCE_DAYS,
    imageAnalysis,
    imageEmbeddings,
    searchEmbedding,
    duplicates,
  };
}
