// Data access for the MCP tools. Reuses the api-server's own libs (deep
// workspace imports resolve because api-server declares no `exports` field):
// Vertex text embedding, the iterative HNSW vector scan, and GCS signing —
// so ranking behaviour is identical to the app's semantic search.
import { and, avg, count, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  db,
  photosTable,
  photoEmbeddingsTable,
  albumsTable,
  ratingsTable,
  attributionTagsTable,
  photoAttributionTagsTable,
  collectionsTable,
  photoCollectionsTable,
  photoAiEvaluationsTable,
} from "@workspace/db";
import { embedText } from "@workspace/api-server/src/lib/aiEmbedding";
import { withIterativeVectorScan } from "@workspace/api-server/src/lib/vectorSearch";
import {
  objectStorageClient,
  parseObjectPath,
  getPrivateObjectDir,
  signObjectURL,
} from "@workspace/api-server/src/lib/objectStorage";

// Matches the app's semantic search: how hard an excluded concept pushes the
// query vector away from it.
const NEGATIVE_LAMBDA = 0.75;

function normalizeVec(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

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

export async function searchPhotos({
  query,
  count: wanted,
  exclude,
  minRating,
  minQuality,
  rightsTag,
  person,
  organizationId,
}: SearchOptions): Promise<{ results: PhotoSummary[]; note?: string }> {
  const posVec = await embedText(query);
  if (!posVec) {
    return {
      results: [],
      note: "Semantic search is unavailable (embedding service not configured or unreachable).",
    };
  }

  let queryVec = posVec;
  if (exclude?.trim()) {
    const negVec = await embedText(exclude.trim());
    if (negVec) {
      const p = normalizeVec(posVec);
      const n = normalizeVec(negVec);
      queryVec = p.map((x, i) => x - NEGATIVE_LAMBDA * n[i]);
    }
  }

  // Rights filter: resolve the tag (case-insensitive) to a photo-id set first.
  let rightsPhotoIds: Set<number> | null = null;
  if (rightsTag?.trim()) {
    const [tag] = await db
      .select({ id: attributionTagsTable.id })
      .from(attributionTagsTable)
      .where(
        and(
          ilike(attributionTagsTable.name, rightsTag.trim()),
          organizationId != null ? eq(attributionTagsTable.organizationId, organizationId) : undefined,
        ),
      );
    if (!tag) {
      const tags = await listUsageRights(organizationId);
      return {
        results: [],
        note: `No usage-rights tag named "${rightsTag}". Available: ${tags.map((t) => t.name).join(", ") || "(none)"}.`,
      };
    }
    const rows = await db
      .select({ photoId: photoAttributionTagsTable.photoId })
      .from(photoAttributionTagsTable)
      .where(eq(photoAttributionTagsTable.tagId, tag.id));
    rightsPhotoIds = new Set(rows.map((r) => r.photoId));
    if (rightsPhotoIds.size === 0) {
      return { results: [], note: `No photos are cleared for "${rightsTag}" yet.` };
    }
  }

  // Person filter: restrict the ranking to that person's tagged photos.
  let personPhotoIds: Set<number> | null = null;
  if (person?.trim()) {
    const [match] = await db
      .select({ id: collectionsTable.id })
      .from(collectionsTable)
      .where(
        and(
          eq(collectionsTable.kind, "person"),
          ilike(collectionsTable.title, person.trim()),
          organizationId != null ? eq(collectionsTable.organizationId, organizationId) : undefined,
        ),
      );
    if (!match) {
      const people = await listPeople(organizationId);
      return {
        results: [],
        note: `No person named "${person}". Available: ${people.map((p) => p.name).join(", ") || "(none yet)"}.`,
      };
    }
    const rows = await db
      .select({ photoId: photoCollectionsTable.photoId })
      .from(photoCollectionsTable)
      .where(eq(photoCollectionsTable.collectionId, match.id));
    personPhotoIds = new Set(rows.map((r) => r.photoId));
    if (personPhotoIds.size === 0) {
      return { results: [], note: `"${person}" has no tagged photos yet.` };
    }
  }

  // Intersect the id-restricting filters before handing them to the ranking.
  let restrictIds: Set<number> | null = null;
  if (rightsPhotoIds && personPhotoIds) {
    restrictIds = new Set([...personPhotoIds].filter((id) => rightsPhotoIds.has(id)));
    if (restrictIds.size === 0) {
      return { results: [], note: `No photos of "${person}" are cleared for "${rightsTag}".` };
    }
  } else {
    restrictIds = rightsPhotoIds ?? personPhotoIds;
  }

  // Post-ranking filters thin the list, so over-fetch when any are active.
  const hasPostFilters = minRating != null || minQuality != null || rightsPhotoIds != null;
  const fetchLimit = hasPostFilters ? Math.min(500, wanted * 10) : wanted;

  const vecLiteral = `[${queryVec.join(",")}]`;
  const ranked = await withIterativeVectorScan((tx) =>
    tx
      .select({ id: photoEmbeddingsTable.photoId })
      .from(photoEmbeddingsTable)
      .innerJoin(photosTable, eq(photosTable.id, photoEmbeddingsTable.photoId))
      .where(
        and(
          eq(photosTable.isHidden, false),
          restrictIds ? inArray(photoEmbeddingsTable.photoId, [...restrictIds]) : undefined,
          organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
        ),
      )
      .orderBy(sql`${photoEmbeddingsTable.embedding} <=> ${vecLiteral}::vector`)
      .limit(fetchLimit),
  );

  let summaries = await buildSummaries(ranked.map((r) => r.id));
  if (minRating != null) {
    summaries = summaries.filter((p) => (p.averageRating ?? 0) >= minRating);
  }
  if (minQuality != null) {
    // Photos not yet evaluated are dropped when a quality floor is requested.
    summaries = summaries.filter((p) => p.aiScore != null && p.aiScore >= minQuality);
  }
  const results = summaries.slice(0, wanted);
  const note =
    hasPostFilters && results.length < wanted
      ? `Only ${results.length} of the top ${fetchLimit} ranked photos pass the filters.`
      : undefined;
  return { results, note };
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
