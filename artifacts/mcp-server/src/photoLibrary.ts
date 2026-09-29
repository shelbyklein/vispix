// Data access for the MCP tools. Reuses the api-server's own libs (deep
// workspace imports resolve because api-server declares no `exports` field):
// the shared photo retrieval service (#213) — so ranking is identical to the
// app's semantic search — and GCS signing.
import { and, avg, count, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  db,
  photosTable,
  albumsTable,
  organizationsTable,
  ratingsTable,
  attributionTagsTable,
  photoAttributionTagsTable,
  collectionsTable,
  photoCollectionsTable,
  photoAiEvaluationsTable,
} from "@workspace/db";
import type { EmbedFailure } from "@workspace/api-server/src/lib/aiEmbedding";
import { retrievePhotos } from "@workspace/api-server/src/lib/photoRetrieval";
import { keyBelongsToOrg } from "@workspace/api-server/src/lib/storageKeys";
import {
  objectStorageClient,
  parseObjectPath,
  getPrivateObjectDir,
  signObjectURL,
} from "@workspace/api-server/src/lib/objectStorage";

export function resolveObjectFile(key: string) {
  const privateObjectDir = getPrivateObjectDir();
  const entityDirBase = privateObjectDir.endsWith("/") ? privateObjectDir : `${privateObjectDir}/`;
  const entityId = key.slice("/objects/".length);
  const { bucketName, objectName } = parseObjectPath(`${entityDirBase}${entityId}`);
  return { bucketName, objectName, file: objectStorageClient.bucket(bucketName).file(objectName) };
}

export interface PhotoSummary {
  id: number;
  filename: string | null;
  albumTitle: string | null;
  aiDescription: string | null;
  width: number | null;
  height: number | null;
  averageRating: number | null;
  ratingCount: number;
  rights: string[];
  thumbnailKey: string | null;
  takenAt: string | null;
  /** AI overall evaluation score 0–10 (#181), or null if not yet evaluated. */
  aiScore: number | null;
  /** AI-detected flaws (short phrases); empty when clean or unevaluated. */
  aiFlaws: string[];
}

async function buildSummaries(ids: number[]): Promise<PhotoSummary[]> {
  if (ids.length === 0) return [];
  const [rows, ratingRows, rightsRows, evalRows] = await Promise.all([
    db
      .select({ photo: photosTable, albumTitle: albumsTable.title })
      .from(photosTable)
      .leftJoin(albumsTable, eq(photosTable.albumId, albumsTable.id))
      .where(inArray(photosTable.id, ids)),
    db
      .select({
        photoId: ratingsTable.photoId,
        averageRating: avg(ratingsTable.score),
        ratingCount: count(ratingsTable.id),
      })
      .from(ratingsTable)
      .where(inArray(ratingsTable.photoId, ids))
      .groupBy(ratingsTable.photoId),
    db
      .select({ photoId: photoAttributionTagsTable.photoId, name: attributionTagsTable.name })
      .from(photoAttributionTagsTable)
      .innerJoin(attributionTagsTable, eq(photoAttributionTagsTable.tagId, attributionTagsTable.id))
      .where(inArray(photoAttributionTagsTable.photoId, ids)),
    db
      .select({
        photoId: photoAiEvaluationsTable.photoId,
        overallScore: photoAiEvaluationsTable.overallScore,
        flaws: photoAiEvaluationsTable.flaws,
      })
      .from(photoAiEvaluationsTable)
      .where(inArray(photoAiEvaluationsTable.photoId, ids)),
  ]);

  const ratingByPhoto = new Map(
    ratingRows.map((r) => [
      r.photoId,
      { avg: r.averageRating ? parseFloat(String(r.averageRating)) : null, count: Number(r.ratingCount) },
    ]),
  );
  const rightsByPhoto = new Map<number, string[]>();
  for (const r of rightsRows) {
    const list = rightsByPhoto.get(r.photoId) ?? [];
    list.push(r.name);
    rightsByPhoto.set(r.photoId, list);
  }
  const evalByPhoto = new Map(evalRows.map((r) => [r.photoId, r]));
  const byId = new Map(
    rows.map(({ photo, albumTitle }) => [
      photo.id,
      {
        id: photo.id,
        filename: photo.filename,
        albumTitle,
        aiDescription: photo.aiDescription,
        width: photo.width,
        height: photo.height,
        averageRating: ratingByPhoto.get(photo.id)?.avg ?? null,
        ratingCount: ratingByPhoto.get(photo.id)?.count ?? 0,
        rights: rightsByPhoto.get(photo.id) ?? [],
        thumbnailKey: photo.thumbnailKey,
        takenAt: photo.takenAt instanceof Date ? photo.takenAt.toISOString() : null,
        aiScore: evalByPhoto.get(photo.id)?.overallScore ?? null,
        aiFlaws: (evalByPhoto.get(photo.id)?.flaws as string[] | undefined) ?? [],
      } satisfies PhotoSummary,
    ]),
  );
  // Preserve ranking order.
  return ids.map((id) => byId.get(id)).filter((p): p is PhotoSummary => !!p);
}

export interface SearchOptions {
  query: string;
  count: number;
  exclude?: string;
  minRating?: number;
  /** Only photos with an AI overall evaluation score (0–10) at least this (#181). */
  minQuality?: number;
  rightsTag?: string;
  /** Restrict to photos tagged to this person (People page groups). */
  person?: string;
  /** When set, restrict the search to a single organization's library. */
  organizationId?: number;
}

/**
 * The local stdio server has no connector token, so it needs an explicit
 * organization: VISPIX_MCP_ORGANIZATION_ID, or the only organization when
 * exactly one exists. Null when it can't tell.
 */
async function resolveLocalOrganizationId(): Promise<number | null> {
  const configured = Number(process.env.VISPIX_MCP_ORGANIZATION_ID);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  const orgs = await db.select({ id: organizationsTable.id }).from(organizationsTable).limit(2);
  return orgs.length === 1 ? orgs[0].id : null;
}

const UNAVAILABLE_NOTES: Record<EmbedFailure, string> = {
  not_configured: "Semantic search is unavailable (embedding service not configured).",
  timeout: "Semantic search is unavailable right now (the embedding service timed out). Try again.",
  cancelled: "The search was cancelled.",
  provider_error: "Semantic search is unavailable right now (the embedding service failed). Try again.",
};

export async function searchPhotos({
  query,
  count: wanted,
  exclude,
  minRating,
  minQuality,
  rightsTag,
  person,
  organizationId: scopedOrgId,
  signal,
}: SearchOptions & { signal?: AbortSignal }): Promise<{ results: PhotoSummary[]; note?: string }> {
  // Every search is org-scoped (#213): the gateway passes the token's org.
  const organizationId = scopedOrgId ?? (await resolveLocalOrganizationId());
  if (organizationId == null) {
    return {
      results: [],
      note: "Search needs an organization: set VISPIX_MCP_ORGANIZATION_ID for the local server.",
    };
  }

  // Name filters resolve inside the org; an unknown name is an explicit
  // answer listing the org's own names, never "no filter".
  let rightsTagId: number | undefined;
  if (rightsTag?.trim()) {
    const [tag] = await db
      .select({ id: attributionTagsTable.id })
      .from(attributionTagsTable)
      .where(and(ilike(attributionTagsTable.name, rightsTag.trim()), eq(attributionTagsTable.organizationId, organizationId)));
    if (!tag) {
      const tags = await listUsageRights(organizationId);
      return {
        results: [],
        note: `No usage-rights tag named "${rightsTag}". Available: ${tags.map((t) => t.name).join(", ") || "(none)"}.`,
      };
    }
    rightsTagId = tag.id;
  }
  let personId: number | undefined;
  if (person?.trim()) {
    const [match] = await db
      .select({ id: collectionsTable.id })
      .from(collectionsTable)
      .where(
        and(
          eq(collectionsTable.kind, "person"),
          ilike(collectionsTable.title, person.trim()),
          eq(collectionsTable.organizationId, organizationId),
        ),
      );
    if (!match) {
      const people = await listPeople(organizationId);
      return {
        results: [],
        note: `No person named "${person}". Available: ${people.map((p) => p.name).join(", ") || "(none yet)"}.`,
      };
    }
    personId = match.id;
  }

  // Same ranking as the app's semantic search; every filter applies inside
  // the ranking query, before the count limit.
  const result = await retrievePhotos({
    organizationId,
    canSeeHidden: false,
    mode: "concept",
    text: query,
    exclude: exclude?.trim() ? [exclude.trim()] : [],
    filters: { ratingMin: minRating, minQuality, rightsTagId, personId },
    limit: wanted,
    signal,
  });
  if (result.status === "unavailable") {
    return { results: [], note: UNAVAILABLE_NOTES[result.degraded?.reason ?? "provider_error"] };
  }

  const results = await buildSummaries(result.items.map((i) => i.photoId));
  const notes: string[] = [];
  const filtered = minRating != null || minQuality != null || rightsTagId != null || personId != null;
  if (result.page.exhausted && results.length < wanted) {
    notes.push(
      results.length === 0
        ? filtered ? "No photos match these filters." : "No photos are indexed for semantic search yet."
        : `Only ${results.length} photo${results.length === 1 ? "" : "s"} match${results.length === 1 ? "es" : ""} ${filtered ? "these filters" : "at all"}.`,
    );
  }
  if (result.coverage && result.coverage.notEmbedded > 0) {
    notes.push(
      `${result.coverage.notEmbedded} matching photo${result.coverage.notEmbedded === 1 ? " isn't" : "s aren't"} indexed for semantic search yet, so ${result.coverage.notEmbedded === 1 ? "it" : "they"} can't appear here.`,
    );
  }
  if (result.degraded?.affects === "exclusions") notes.push("The exclusion couldn't be applied (embedding service unavailable).");
  return { results, note: notes.length ? notes.join(" ") : undefined };
}

export async function getPhotoDetail(
  id: number,
  organizationId?: number,
): Promise<{ photo: PhotoSummary; fullResUrl: string | null } | null> {
  const [row] = await db
    .select({ storageKey: photosTable.storageKey })
    .from(photosTable)
    .where(
      and(
        eq(photosTable.id, id),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    );
  if (organizationId != null && !row) return null;

  const [photo] = await buildSummaries([id]);
  if (!photo) return null;

  let fullResUrl: string | null = null;
  if (row?.storageKey?.startsWith("/objects/")) {
    try {
      const { bucketName, objectName } = resolveObjectFile(row.storageKey);
      fullResUrl = await signObjectURL({ bucketName, objectName, method: "GET", ttlSec: 3600 });
    } catch {
      fullResUrl = null; // photo still useful without a download link
    }
  }
  return { photo, fullResUrl };
}

export async function listAlbums(
  organizationId?: number,
): Promise<{ id: number; title: string; photoCount: number }[]> {
  const rows = await db
    .select({ id: albumsTable.id, title: albumsTable.title, photoCount: count(photosTable.id) })
    .from(albumsTable)
    .leftJoin(photosTable, eq(albumsTable.id, photosTable.albumId))
    .where(organizationId != null ? eq(albumsTable.organizationId, organizationId) : undefined)
    .groupBy(albumsTable.id)
    .orderBy(sql`${albumsTable.sortOrder} asc, ${albumsTable.createdAt} desc`);
  return rows.map((r) => ({ ...r, photoCount: Number(r.photoCount) }));
}

export async function listPeople(
  organizationId?: number,
): Promise<{ name: string; description: string | null; photoCount: number }[]> {
  const rows = await db
    .select({
      name: collectionsTable.title,
      description: collectionsTable.description,
      photoCount: count(photoCollectionsTable.photoId),
    })
    .from(collectionsTable)
    .leftJoin(photoCollectionsTable, eq(collectionsTable.id, photoCollectionsTable.collectionId))
    .where(
      and(
        eq(collectionsTable.kind, "person"),
        organizationId != null ? eq(collectionsTable.organizationId, organizationId) : undefined,
      ),
    )
    .groupBy(collectionsTable.id)
    .orderBy(collectionsTable.title);
  return rows.map((r) => ({ ...r, photoCount: Number(r.photoCount) }));
}

export async function listUsageRights(
  organizationId?: number,
): Promise<{ name: string; photoCount: number }[]> {
  const rows = await db
    .select({ name: attributionTagsTable.name, photoCount: count(photoAttributionTagsTable.photoId) })
    .from(attributionTagsTable)
    .leftJoin(photoAttributionTagsTable, eq(attributionTagsTable.id, photoAttributionTagsTable.tagId))
    .where(organizationId != null ? eq(attributionTagsTable.organizationId, organizationId) : undefined)
    .groupBy(attributionTagsTable.id)
    .orderBy(attributionTagsTable.name);
  return rows.map((r) => ({ ...r, photoCount: Number(r.photoCount) }));
}

/**
 * Load a photo's original bytes for the HTTP gateway's download route —
 * remote clients can't reach signed URLs on the local storage endpoint.
 */
export async function getOriginalFile(
  id: number,
  organizationId?: number,
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  const [row] = await db
    .select({ storageKey: photosTable.storageKey, filename: photosTable.filename })
    .from(photosTable)
    .where(
      and(
        eq(photosTable.id, id),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    );
  if (!row?.storageKey?.startsWith("/objects/")) return null;
  // Never serve another org's object through this org's row (defense in depth).
  if (organizationId != null && !keyBelongsToOrg(row.storageKey, organizationId)) return null;
  try {
    const { file } = resolveObjectFile(row.storageKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata().catch(() => [{ contentType: undefined }]);
    return {
      buffer: buffer as Buffer,
      contentType: (metadata?.contentType as string) || "application/octet-stream",
      filename: row.filename || `photo-${id}`,
    };
  } catch {
    return null;
  }
}

/**
 * Load a photo's stored thumbnail bytes for the HTTP gateway's thumbnail
 * route — lets remote clients embed a preview without pulling the original.
 */
export async function getThumbnailFile(
  id: number,
  organizationId?: number,
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  const [row] = await db
    .select({ thumbnailKey: photosTable.thumbnailKey, filename: photosTable.filename })
    .from(photosTable)
    .where(
      and(
        eq(photosTable.id, id),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    );
  if (!row?.thumbnailKey?.startsWith("/objects/")) return null;
  if (organizationId != null && !keyBelongsToOrg(row.thumbnailKey, organizationId)) return null;
  try {
    const { file } = resolveObjectFile(row.thumbnailKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata().catch(() => [{ contentType: undefined }]);
    return {
      buffer: buffer as Buffer,
      contentType: (metadata?.contentType as string) || "image/jpeg",
      filename: row.filename ? `thumb-${row.filename}` : `photo-${id}-thumb`,
    };
  } catch {
    return null;
  }
}

export async function loadThumbnailImage(
  thumbnailKey: string | null,
): Promise<{ base64: string; mimeType: string } | null> {
  if (!thumbnailKey?.startsWith("/objects/")) return null;
  try {
    const { file } = resolveObjectFile(thumbnailKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata().catch(() => [{ contentType: undefined }]);
    return {
      base64: (buffer as Buffer).toString("base64"),
      mimeType: (metadata?.contentType as string) || "image/jpeg",
    };
  } catch {
    return null;
  }
}
