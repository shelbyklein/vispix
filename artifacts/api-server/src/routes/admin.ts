import { Router, type IRouter } from "express";
import { eq, desc, isNull, isNotNull, and, inArray, sql } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  APP_SETTINGS_SINGLETON_ID,
  organizationSettingsTable,
  aiAnalysisEventsTable,
  photosTable,
  photoEmbeddingsTable,
} from "@workspace/db";
import {
  GetRegistrationSettingsResponse,
  UpdateRegistrationSettingsBody,
  UpdateRegistrationSettingsResponse,
  GetAiSettingsResponse,
  UpdateAiSettingsBody,
  UpdateAiSettingsResponse,
  SetAiProviderKeyParams,
  SetAiProviderKeyBody,
  SetAiProviderKeyResponse,
  ClearAiProviderKeyParams,
  ClearAiProviderKeyResponse,
  ListAiAnalysisEventsResponse,
  RetryAiAnalysisEventParams,
  RetryAiAnalysisEventResponse,
  BulkRetryAiAnalysisEventsResponse,
  BackfillThumbnailsResponse,
  BackfillThumbnailsStatusResponse,
  BackfillExifDatesStatusResponse,
  BackfillExifDatesResponse,
  BackfillAiAnalysisStatusResponse,
  BackfillAiAnalysisBody,
  BackfillAiAnalysisResponse,
  BackfillContentHashesStatusResponse,
  BackfillContentHashesResponse,
  BackfillDimensionsStatusResponse,
  BackfillDimensionsResponse,
  AdminHubStatusResponse,
  ListMcpTokensResponse,
  CreateMcpTokenBody,
  CreateMcpTokenResponse,
  DeleteMcpTokenResponse,
  ListDuplicatePhotoGroupsResponse,
  GetDuplicatesSummaryResponse,
  DeleteDuplicateExtrasResponse,
  PerceptualHashBackfillStatusResponse,
  BackfillPerceptualHashesResponse,
  NearDuplicatePhotoGroupsResponse,
  NearDuplicateIndexStatusResponse,
  RebuildNearDuplicateIndexResponse,
  IgnoreNearDuplicatesBody,
  IgnoreNearDuplicatesResponse,
  ServiceStatusResponse,
  ListAiBackfillRunsResponse,
  GetAiAutoBackfillSettingsResponse,
  UpdateAiAutoBackfillSettingsBody,
  UpdateAiAutoBackfillSettingsResponse,
  EmbeddingStatusResponse,
  UpdateEmbeddingSettingsBody,
  BackfillEmbeddingsBody,
  ImageOptimizationStatusResponse,
  UpdateImageOptimizationSettingsBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";
import { buildServiceStatus } from "../lib/serviceStatus";
import { requireOrgAuth, requireOrgRole } from "../middlewares/requireOrg";
import {
  loadAppSettings,
  loadOrgSettings,
  summarizeSettings,
  PROVIDER_IDS,
  PROVIDER_MODEL_OPTIONS,
  type ProviderId,
} from "../lib/aiProviders";

// Provider keys, models, embedding + image-optimization toggles are per-org
// (#113): owner/admin of the active org manage them. registration and the
// maintenance backfills stay instance-admin (requireAdmin).
const requireOrgAdmin = [requireOrgAuth, requireOrgRole("owner", "admin")] as const;
import { encryptSecret, maskKey } from "../lib/secretCrypto";
import { runAndRecordPhotoAnalysis } from "../lib/aiPhotoAnalysis";
import { generateAndStoreThumbnail } from "../lib/thumbnailGeneration";
import { countPhotosWithoutCaptureDate, backfillExifDates } from "../lib/exifDateBackfill";
import { listMcpTokens, createMcpToken, deleteMcpToken } from "../lib/mcpTokens";
import { countPhotosWithoutDimensions, backfillDimensions } from "../lib/dimensionBackfill";
import {
  countPhotosWithoutContentHash,
  backfillContentHashes,
  listDuplicatePhotoGroups,
  getDuplicatesSummary,
  computeDuplicateExtraIds,
} from "../lib/contentHash";
import { deletePhotoStorageObjects } from "../lib/photoHelpers";
import {
  countPhotosWithoutPerceptualHash,
  backfillPerceptualHashes,
  listNearDuplicatePhotoGroups,
  ignoreNearDuplicatePhotos,
  getNearDuplicateIndexStatus,
  rebuildNearDuplicatePairs,
  getExactNearDuplicateSummary,
  computeExactNearDuplicateExtraIds,
  DEFAULT_NEAR_DUP_THRESHOLD,
  MAX_NEAR_DUP_THRESHOLD,
} from "../lib/perceptualHash";
import { countPhotosNeedingAiAnalysis, backfillAiAnalysis, listAiBackfillRuns } from "../lib/aiAnalysisBackfill";
import { getAiAutoBackfillSettings, updateAiAutoBackfillSettings } from "../lib/aiAutoBackfillScheduler";
import { getEmbeddingConfigStatus } from "../lib/aiEmbedding";
import { IMAGE_OPTIMIZATION_SETTINGS } from "../lib/imageOptimization";
import { countPhotosNeedingEmbedding, startEmbeddingBackfill, stopEmbeddingBackfill, getEmbeddingJob } from "../lib/embeddingBackfill";
import { logger } from "../lib/logger";
import { sendEmail, isEmailConfigured } from "../lib/email";
import { testEmail } from "../lib/email/templates";

const router: IRouter = Router();

function resolvePhotoThumbnailUrl(row: { url: string | null; thumbnailKey: string | null }): string | null {
  return row.thumbnailKey ? `/api/storage${row.thumbnailKey}` : row.url;
}

router.get("/registration-settings", async (_req, res): Promise<void> => {
  const settings = await loadAppSettings();
  res.json(GetRegistrationSettingsResponse.parse({ registrationEnabled: settings.registrationEnabled }));
});

router.patch("/admin/registration-settings", requireAdmin, async (req, res): Promise<void> => {
  const body = UpdateRegistrationSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  await loadAppSettings();
  const [updated] = await db
    .update(appSettingsTable)
    .set({ registrationEnabled: body.data.registrationEnabled, updatedAt: new Date() })
    .where(eq(appSettingsTable.id, APP_SETTINGS_SINGLETON_ID))
    .returning();

  res.json(UpdateRegistrationSettingsResponse.parse({ registrationEnabled: updated.registrationEnabled }));
});

// Platform-admin diagnostic: email the signed-in admin a test message so they
// can confirm SMTP delivery end-to-end from the Superadmin page. `configured`
// lets the UI distinguish "no SMTP set up" from "configured but send failed".
router.post("/admin/test-email", requireAdmin, async (req, res): Promise<void> => {
  const to = req.dbUser!.email;
  const configured = isEmailConfigured();
  const { subject, html, text } = testEmail();
  const ok = await sendEmail({ to, subject, html, text });
  res.json({ ok, to, configured });
});

router.get("/admin/ai-settings", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const settings = await loadOrgSettings(req.org!.id);
  res.json(GetAiSettingsResponse.parse(summarizeSettings(settings)));
});

router.patch("/admin/ai-settings", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = UpdateAiSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  await loadOrgSettings(req.org!.id);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.data.enabled === "boolean") updates.aiEnabled = body.data.enabled;
  if (body.data.activeProvider) updates.activeProvider = body.data.activeProvider;

  const providerModels = body.data.providerModels;
  if (providerModels) {
    const modelColumns: Record<ProviderId, "openaiModel" | "anthropicModel" | "geminiModel"> = {
      openai: "openaiModel",
      anthropic: "anthropicModel",
      gemini: "geminiModel",
    };
    for (const id of PROVIDER_IDS) {
      const requested = providerModels[id];
      if (typeof requested !== "string") continue;
      if (!PROVIDER_MODEL_OPTIONS[id].includes(requested)) {
        res.status(400).json({
          error: `Unsupported model "${requested}" for provider "${id}"`,
        });
        return;
      }
      updates[modelColumns[id]] = requested;
    }
  }

  const [updated] = await db
    .update(organizationSettingsTable)
    .set(updates)
    .where(eq(organizationSettingsTable.organizationId, req.org!.id))
    .returning();

  res.json(UpdateAiSettingsResponse.parse(summarizeSettings(updated)));
});

function keyColumns(provider: ProviderId) {
  if (provider === "openai") {
    return {
      ciphertext: "openaiKeyCiphertext",
      iv: "openaiKeyIv",
      tag: "openaiKeyTag",
      preview: "openaiKeyPreview",
    } as const;
  }
  if (provider === "anthropic") {
    return {
      ciphertext: "anthropicKeyCiphertext",
      iv: "anthropicKeyIv",
      tag: "anthropicKeyTag",
      preview: "anthropicKeyPreview",
    } as const;
  }
  return {
    ciphertext: "geminiKeyCiphertext",
    iv: "geminiKeyIv",
    tag: "geminiKeyTag",
    preview: "geminiKeyPreview",
  } as const;
}

router.put(
  "/admin/ai-settings/providers/:provider/key",
  ...requireOrgAdmin,
  async (req, res): Promise<void> => {
    const params = SetAiProviderKeyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = SetAiProviderKeyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const provider = params.data.provider as ProviderId;
    if (!PROVIDER_IDS.includes(provider)) {
      res.status(400).json({ error: "Unknown provider" });
      return;
    }

    await loadOrgSettings(req.org!.id);
    const apiKey = body.data.apiKey.trim();
    const enc = encryptSecret(apiKey);
    const cols = keyColumns(provider);
    const [updated] = await db
      .update(organizationSettingsTable)
      .set({
        [cols.ciphertext]: enc.ciphertext,
        [cols.iv]: enc.iv,
        [cols.tag]: enc.tag,
        [cols.preview]: maskKey(apiKey),
        updatedAt: new Date(),
      })
      .where(eq(organizationSettingsTable.organizationId, req.org!.id))
      .returning();

    res.json(SetAiProviderKeyResponse.parse(summarizeSettings(updated)));
  },
);

router.delete(
  "/admin/ai-settings/providers/:provider/key",
  ...requireOrgAdmin,
  async (req, res): Promise<void> => {
    const params = ClearAiProviderKeyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const provider = params.data.provider as ProviderId;
    if (!PROVIDER_IDS.includes(provider)) {
      res.status(400).json({ error: "Unknown provider" });
      return;
    }

    await loadOrgSettings(req.org!.id);
    const cols = keyColumns(provider);
    const [updated] = await db
      .update(organizationSettingsTable)
      .set({
        [cols.ciphertext]: null,
        [cols.iv]: null,
        [cols.tag]: null,
        [cols.preview]: null,
        updatedAt: new Date(),
      })
      .where(eq(organizationSettingsTable.organizationId, req.org!.id))
      .returning();

    res.json(ClearAiProviderKeyResponse.parse(summarizeSettings(updated)));
  },
);

router.get("/admin/ai-analysis-events", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: aiAnalysisEventsTable.id,
      photoId: aiAnalysisEventsTable.photoId,
      provider: aiAnalysisEventsTable.provider,
      status: aiAnalysisEventsTable.status,
      errorMessage: aiAnalysisEventsTable.errorMessage,
      createdAt: aiAnalysisEventsTable.createdAt,
      url: photosTable.url,
      thumbnailKey: photosTable.thumbnailKey,
    })
    .from(aiAnalysisEventsTable)
    .innerJoin(photosTable, eq(photosTable.id, aiAnalysisEventsTable.photoId))
    .where(eq(photosTable.organizationId, req.org!.id))
    .orderBy(desc(aiAnalysisEventsTable.createdAt))
    .limit(20);

  res.json(
    ListAiAnalysisEventsResponse.parse(
      rows.map((r) => ({
        id: r.id,
        photoId: r.photoId,
        photoCaption: null,
        photoThumbnailUrl: resolvePhotoThumbnailUrl(r),
        provider: r.provider,
        status: r.status,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt.toISOString(),
      })),
    ),
  );
});

router.post(
  "/admin/ai-analysis-events/retry-all",
  ...requireOrgAdmin,
  async (req, res): Promise<void> => {
    const recentEvents = await db
      .select({
        id: aiAnalysisEventsTable.id,
        photoId: aiAnalysisEventsTable.photoId,
        status: aiAnalysisEventsTable.status,
      })
      .from(aiAnalysisEventsTable)
      .innerJoin(photosTable, eq(photosTable.id, aiAnalysisEventsTable.photoId))
      .where(eq(photosTable.organizationId, req.org!.id))
      .orderBy(desc(aiAnalysisEventsTable.createdAt))
      .limit(20);

    const failedPhotoIds = Array.from(
      new Set(
        recentEvents
          .filter((e) => e.status === "failed" && e.photoId != null)
          .map((e) => e.photoId as number),
      ),
    );

    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const photoId of failedPhotoIds) {
      const newEvent = await runAndRecordPhotoAnalysis(photoId);
      if (!newEvent || newEvent.status === "failed") {
        failed++;
      } else if (newEvent.status === "skipped") {
        skipped++;
      } else {
        succeeded++;
      }
    }

    res.json(BulkRetryAiAnalysisEventsResponse.parse({ succeeded, skipped, failed }));
  },
);

router.post(
  "/admin/ai-analysis-events/:id/retry",
  ...requireOrgAdmin,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const params = RetryAiAnalysisEventParams.safeParse({
      id: parseInt(raw, 10),
    });
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [event] = await db
      .select()
      .from(aiAnalysisEventsTable)
      .where(eq(aiAnalysisEventsTable.id, params.data.id));
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    if (event.status !== "failed") {
      res.status(400).json({ error: "Only failed events can be retried" });
      return;
    }
    if (event.photoId == null) {
      res.status(404).json({ error: "Photo no longer exists" });
      return;
    }

    // The event's photo must belong to the active org (#113) — otherwise a
    // foreign event id could trigger analysis on another tenant's photo.
    const [photoInOrg] = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(and(eq(photosTable.id, event.photoId), eq(photosTable.organizationId, req.org!.id)));
    if (!photoInOrg) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const newEvent = await runAndRecordPhotoAnalysis(event.photoId);
    if (!newEvent) {
      res.status(404).json({ error: "Photo no longer exists" });
      return;
    }

    const [row] = await db
      .select({
        id: aiAnalysisEventsTable.id,
        photoId: aiAnalysisEventsTable.photoId,
        provider: aiAnalysisEventsTable.provider,
        status: aiAnalysisEventsTable.status,
        errorMessage: aiAnalysisEventsTable.errorMessage,
        createdAt: aiAnalysisEventsTable.createdAt,
        url: photosTable.url,
        thumbnailKey: photosTable.thumbnailKey,
      })
      .from(aiAnalysisEventsTable)
      .leftJoin(photosTable, eq(photosTable.id, aiAnalysisEventsTable.photoId))
      .where(eq(aiAnalysisEventsTable.id, newEvent.id));

    res.json(
      RetryAiAnalysisEventResponse.parse({
        id: row.id,
        photoId: row.photoId,
        photoCaption: null,
        photoThumbnailUrl: resolvePhotoThumbnailUrl(row),
        provider: row.provider,
        status: row.status,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  },
);

// --- MCP gateway access tokens (bearer / URL auth for remote clients) ---

router.get("/admin/mcp-tokens", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(ListMcpTokensResponse.parse(await listMcpTokens(req.org!.id)));
});

router.post("/admin/mcp-tokens", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = CreateMcpTokenBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // The token is scoped to the active org — the gateway only exposes this org's
  // library to whoever holds it (#113 Phase 5).
  const created = await createMcpToken(body.data.label, req.org!.id, req.dbUser?.id ?? null);
  res.status(201).json(
    CreateMcpTokenResponse.parse({
      ...created,
      publicBaseUrl: process.env.MCP_PUBLIC_URL?.replace(/\/$/, "") ?? null,
    }),
  );
});

router.delete("/admin/mcp-tokens/:id", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid token id" });
    return;
  }
  res.json(DeleteMcpTokenResponse.parse({ deleted: await deleteMcpToken(id, req.org!.id) }));
});

// At-a-glance counts for the admin hub cards — one aggregated call of cheap
// count-only queries, so the hub itself stays fast (#76). Near-duplicate
// clustering is deliberately absent: its status is expensive to compute.
router.get("/admin/hub-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  const [aiAnalysisPending, embeddingsPending, thumbnailRows, capturedDatesMissing, duplicates] =
    await Promise.all([
      countPhotosNeedingAiAnalysis(orgId),
      countPhotosNeedingEmbedding(orgId),
      db
        .select({ n: sql<number>`cast(count(*) as integer)` })
        .from(photosTable)
        .where(and(isNull(photosTable.thumbnailKey), isNotNull(photosTable.storageKey), eq(photosTable.organizationId, orgId))),
      countPhotosWithoutCaptureDate(orgId),
      getDuplicatesSummary(orgId),
    ]);

  res.json(
    AdminHubStatusResponse.parse({
      aiAnalysisPending,
      embeddingsPending,
      thumbnailsMissing: thumbnailRows[0]?.n ?? 0,
      capturedDatesMissing,
      duplicateGroups: duplicates.groupCount,
    }),
  );
});

router.get("/admin/thumbnails/backfill-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const photos = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(and(isNull(photosTable.thumbnailKey), isNotNull(photosTable.storageKey), eq(photosTable.organizationId, req.org!.id)));

  res.json(BackfillThumbnailsStatusResponse.parse({ missingCount: photos.length }));
});

router.post("/admin/thumbnails/backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  // Reset any photos stuck with thumbnailGenerating=true from a previous interrupted process.
  await db
    .update(photosTable)
    .set({ thumbnailGenerating: false })
    .where(and(isNull(photosTable.thumbnailKey), eq(photosTable.thumbnailGenerating, true), eq(photosTable.organizationId, orgId)));

  const photos = await db
    .select({ id: photosTable.id, storageKey: photosTable.storageKey })
    .from(photosTable)
    .where(and(isNull(photosTable.thumbnailKey), isNotNull(photosTable.storageKey), eq(photosTable.organizationId, orgId)));

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
      logger.warn({ photoId: photo.id }, "Thumbnail backfill failed for photo");
    }
  }

  res.json(BackfillThumbnailsResponse.parse({ processed: photos.length, succeeded, skipped, failed }));
});

router.get("/admin/photos/exif-date-backfill-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const missingCount = await countPhotosWithoutCaptureDate(req.org!.id);
  res.json(BackfillExifDatesStatusResponse.parse({ missingCount }));
});

router.post("/admin/photos/exif-date-backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const result = await backfillExifDates(req.org!.id);
  res.json(BackfillExifDatesResponse.parse(result));
});

router.get("/admin/photos/dimension-backfill-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const missingCount = await countPhotosWithoutDimensions(req.org!.id);
  res.json(BackfillDimensionsStatusResponse.parse({ missingCount }));
});

router.post("/admin/photos/dimension-backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const result = await backfillDimensions(req.org!.id);
  res.json(BackfillDimensionsResponse.parse(result));
});

router.get("/admin/photos/content-hash-backfill-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const missingCount = await countPhotosWithoutContentHash(req.org!.id);
  res.json(BackfillContentHashesStatusResponse.parse({ missingCount }));
});

router.post("/admin/photos/content-hash-backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const result = await backfillContentHashes(req.org!.id);
  res.json(BackfillContentHashesResponse.parse(result));
});

async function buildEmbeddingStatus(orgId: number) {
  const cfg = await getEmbeddingConfigStatus(orgId);
  const missingCount = await countPhotosNeedingEmbedding(orgId);
  const embeddedCount = (
    await db
      .select({ id: photoEmbeddingsTable.photoId })
      .from(photoEmbeddingsTable)
      .where(eq(photoEmbeddingsTable.organizationId, orgId))
  ).length;
  return { ...cfg, embeddedCount, missingCount, job: getEmbeddingJob(orgId) };
}

router.get("/admin/embeddings/status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(EmbeddingStatusResponse.parse(await buildEmbeddingStatus(req.org!.id)));
});

router.patch("/admin/embeddings/settings", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = UpdateEmbeddingSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await loadOrgSettings(req.org!.id);
  await db
    .update(organizationSettingsTable)
    .set({ embeddingEnabled: body.data.enabled })
    .where(eq(organizationSettingsTable.organizationId, req.org!.id));
  res.json(EmbeddingStatusResponse.parse(await buildEmbeddingStatus(req.org!.id)));
});

// Kick off the backfill as a cancellable background job (#31) and return the
// status immediately (with the live job); the client polls the status endpoint.
router.post("/admin/embeddings/backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = BackfillEmbeddingsBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  startEmbeddingBackfill(req.org!.id, body.data.limit);
  res.json(EmbeddingStatusResponse.parse(await buildEmbeddingStatus(req.org!.id)));
});

// Request a clean halt of the running backfill; already-embedded photos are kept.
router.post("/admin/embeddings/backfill/stop", ...requireOrgAdmin, async (req, res): Promise<void> => {
  stopEmbeddingBackfill(req.org!.id);
  res.json(EmbeddingStatusResponse.parse(await buildEmbeddingStatus(req.org!.id)));
});

async function buildImageOptimizationStatus(orgId: number) {
  const [s] = await db
    .select({ enabled: organizationSettingsTable.imageOptimizationEnabled })
    .from(organizationSettingsTable)
    .where(eq(organizationSettingsTable.organizationId, orgId));
  return {
    enabled: s ? Boolean(s.enabled) : true,
    quality: IMAGE_OPTIMIZATION_SETTINGS.quality,
    maxEdge: IMAGE_OPTIMIZATION_SETTINGS.maxEdge,
  };
}

router.get("/admin/image-optimization/status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(ImageOptimizationStatusResponse.parse(await buildImageOptimizationStatus(req.org!.id)));
});

router.patch("/admin/image-optimization/settings", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = UpdateImageOptimizationSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await loadOrgSettings(req.org!.id);
  await db
    .update(organizationSettingsTable)
    .set({ imageOptimizationEnabled: body.data.enabled })
    .where(eq(organizationSettingsTable.organizationId, req.org!.id));
  res.json(ImageOptimizationStatusResponse.parse(await buildImageOptimizationStatus(req.org!.id)));
});

const DUPLICATES_DEFAULT_LIMIT = 20;
const DUPLICATES_MAX_LIMIT = 100;

router.get("/admin/photos/duplicates", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const rawLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : DUPLICATES_DEFAULT_LIMIT;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, DUPLICATES_MAX_LIMIT) : DUPLICATES_DEFAULT_LIMIT;
  const rawOffset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  // Fetch one extra group to know whether another page exists.
  const groups = await listDuplicatePhotoGroups({ limit: limit + 1, offset, organizationId: req.org!.id });
  const hasMore = groups.length > limit;
  const page = hasMore ? groups.slice(0, limit) : groups;

  res.json(
    ListDuplicatePhotoGroupsResponse.parse({
      hasMore,
      groups: page.map((g) => ({
        contentHash: g.contentHash,
        photos: g.photos.map((p) => ({
          id: p.id,
          albumId: p.albumId,
          albumTitle: p.albumTitle,
          filename: p.filename,
          thumbnailUrl: resolvePhotoThumbnailUrl({ url: p.url, thumbnailKey: p.thumbnailKey }),
          createdAt: p.createdAt.toISOString(),
          isAlbumCover: p.isAlbumCover,
          collectionCount: p.collectionCount,
        })),
      })),
    }),
  );
});

router.get("/admin/photos/duplicates/summary", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(GetDuplicatesSummaryResponse.parse(await getDuplicatesSummary(req.org!.id)));
});

// Server-side "delete all extras": computes the deletable copies (keeping album
// covers, else one per group) and removes them in one shot, so the admin
// summary never has to download every group to bulk-delete.
router.post("/admin/photos/duplicates/delete-extras", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  const extraIds = await computeDuplicateExtraIds(orgId);
  if (extraIds.length === 0) {
    res.json(DeleteDuplicateExtrasResponse.parse({ deleted: 0 }));
    return;
  }

  // extraIds are already org-scoped, but re-assert org on the delete as
  // defense-in-depth so no foreign id can ever be removed.
  const toDelete = await db
    .select({ id: photosTable.id, storageKey: photosTable.storageKey, thumbnailKey: photosTable.thumbnailKey })
    .from(photosTable)
    .where(and(inArray(photosTable.id, extraIds), eq(photosTable.organizationId, orgId)));

  const deleted = await db
    .delete(photosTable)
    .where(and(inArray(photosTable.id, extraIds), eq(photosTable.organizationId, orgId)))
    .returning({ id: photosTable.id });

  await Promise.all(toDelete.map((photo) => deletePhotoStorageObjects(photo)));

  res.json(DeleteDuplicateExtrasResponse.parse({ deleted: deleted.length }));
});

router.get("/admin/photos/perceptual-hash-backfill-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const missingCount = await countPhotosWithoutPerceptualHash(req.org!.id);
  res.json(PerceptualHashBackfillStatusResponse.parse({ missingCount }));
});

router.post("/admin/photos/perceptual-hash-backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const rawLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const limit = rawLimit && Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const result = await backfillPerceptualHashes(limit, req.org!.id);
  res.json(BackfillPerceptualHashesResponse.parse(result));
});

router.get("/admin/photos/near-duplicates", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = req.query.threshold ? parseInt(String(req.query.threshold), 10) : DEFAULT_NEAR_DUP_THRESHOLD;
  const threshold = Number.isInteger(raw) ? Math.min(Math.max(raw, 0), MAX_NEAR_DUP_THRESHOLD) : DEFAULT_NEAR_DUP_THRESHOLD;
  const rawLimit = req.query.limit ? parseInt(String(req.query.limit), 10) : DUPLICATES_DEFAULT_LIMIT;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, DUPLICATES_MAX_LIMIT) : DUPLICATES_DEFAULT_LIMIT;
  const rawOffset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  // Reads the stored pair index (no per-request rescan); the page slice keeps
  // the response payload small.
  const allGroups = await listNearDuplicatePhotoGroups(threshold, req.org!.id);
  const page = allGroups.slice(offset, offset + limit);
  res.json(
    NearDuplicatePhotoGroupsResponse.parse({
      threshold,
      totalGroups: allGroups.length,
      hasMore: offset + limit < allGroups.length,
      groups: page.map((g) => ({
        key: g.key,
        distance: g.distance,
        photos: g.photos.map((p) => ({
          id: p.id,
          albumId: p.albumId,
          albumTitle: p.albumTitle,
          filename: p.filename,
          thumbnailUrl: resolvePhotoThumbnailUrl({ url: p.url, thumbnailKey: p.thumbnailKey }),
          imageUrl: p.url,
          perceptualHash: p.perceptualHash,
          createdAt: p.createdAt.toISOString(),
          isAlbumCover: p.isAlbumCover,
          collectionCount: p.collectionCount,
        })),
      })),
    }),
  );
});

// Org-scoped service readiness (issue #122): same checks as the platform
// variant, but the AI row reflects whether THIS org can analyse photos.
router.get("/admin/org-service-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(ServiceStatusResponse.parse(await buildServiceStatus({ organizationId: req.org!.id })));
});

// Dismiss a near-duplicate comparison as not-duplicates (issue #124). The
// ignored pairs persist across index rebuilds, so the group never resurfaces.
router.post("/admin/photos/near-duplicates/ignore", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = IgnoreNearDuplicatesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const result = await ignoreNearDuplicatePhotos(req.org!.id, body.data.photoIds);
  res.json(IgnoreNearDuplicatesResponse.parse(result));
});

// One-click cleanup of "100% matches" (#177): every visually-identical
// (perceptual distance 0) group, keeping album covers or one photo per group and
// deleting the rest. The summary lets the UI show the count + confirm first.
// Mirrors the exact content-hash delete-extras above, reusing its response shapes.
router.get("/admin/photos/near-duplicates/exact-summary", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(GetDuplicatesSummaryResponse.parse(await getExactNearDuplicateSummary(req.org!.id)));
});

router.post("/admin/photos/near-duplicates/delete-exact-extras", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  const extraIds = await computeExactNearDuplicateExtraIds(orgId);
  if (extraIds.length === 0) {
    res.json(DeleteDuplicateExtrasResponse.parse({ deleted: 0 }));
    return;
  }

  // extraIds are already org-scoped; re-assert org on the reads/delete as
  // defense-in-depth so no foreign id can ever be removed.
  const toDelete = await db
    .select({ id: photosTable.id, storageKey: photosTable.storageKey, thumbnailKey: photosTable.thumbnailKey })
    .from(photosTable)
    .where(and(inArray(photosTable.id, extraIds), eq(photosTable.organizationId, orgId)));

  const deleted = await db
    .delete(photosTable)
    .where(and(inArray(photosTable.id, extraIds), eq(photosTable.organizationId, orgId)))
    .returning({ id: photosTable.id });

  await Promise.all(toDelete.map((photo) => deletePhotoStorageObjects(photo)));

  res.json(DeleteDuplicateExtrasResponse.parse({ deleted: deleted.length }));
});

router.get("/admin/photos/near-duplicate-index-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  res.json(NearDuplicateIndexStatusResponse.parse(await getNearDuplicateIndexStatus(req.org!.id)));
});

router.post("/admin/photos/near-duplicate-index/rebuild", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const result = await rebuildNearDuplicatePairs(req.org!.id);
  res.json(RebuildNearDuplicateIndexResponse.parse(result));
});

router.get("/admin/ai-analysis/backfill-status", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const missingCount = await countPhotosNeedingAiAnalysis(req.org!.id);
  res.json(BackfillAiAnalysisStatusResponse.parse({ missingCount }));
});

router.post("/admin/ai-analysis/backfill", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = BackfillAiAnalysisBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const result = await backfillAiAnalysis(body.data.limit, "manual", req.org!.id);
  res.json(BackfillAiAnalysisResponse.parse(result));
});

router.get("/admin/ai-analysis/backfill-runs", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const runs = await listAiBackfillRuns(undefined, req.org!.id);
  res.json(
    ListAiBackfillRunsResponse.parse(
      runs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    ),
  );
});

router.get("/admin/ai-analysis/auto-backfill-settings", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const settings = await getAiAutoBackfillSettings(req.org!.id);
  res.json(GetAiAutoBackfillSettingsResponse.parse(settings));
});

router.patch("/admin/ai-analysis/auto-backfill-settings", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = UpdateAiAutoBackfillSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const settings = await updateAiAutoBackfillSettings(req.org!.id, body.data);
  res.json(UpdateAiAutoBackfillSettingsResponse.parse(settings));
});

export default router;
