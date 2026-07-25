import sharp from "sharp";
import { and, eq, isNull, isNotNull, inArray, lte, sql } from "drizzle-orm";
import { db, photosTable, albumsTable, photoCollectionsTable, nearDuplicatePairsTable, nearDuplicateIgnoresTable } from "@workspace/db";
import { objectStorageClient, parseObjectPath, getPrivateObjectDir } from "./objectStorage";
import { logger } from "./logger";
import { createLimiter } from "./concurrencyLimit";

// Bound concurrent hashings: each downloads + downscales the full-size source
// image. Fired off per-upload without awaiting (mirrors content-hash /
// thumbnail generation), so cap peak memory regardless of upload rate.
const perceptualHashLimiter = createLimiter(2);

function resolveSourceFile(storageKey: string) {
  const privateObjectDir = getPrivateObjectDir();
  const entityDirBase = privateObjectDir.endsWith("/") ? privateObjectDir : `${privateObjectDir}/`;
  const entityId = storageKey.slice("/objects/".length);
  const objectEntityPath = `${entityDirBase}${entityId}`;
  const { bucketName, objectName } = parseObjectPath(objectEntityPath);
  return objectStorageClient.bucket(bucketName).file(objectName);
}

export type PerceptualHashResult = "success" | "skipped" | "failed";

/**
 * Compute a 64-bit dHash (difference hash) for the image and return it as 16 hex
 * chars. The image is reduced to 9x8 grayscale; each of the 8 rows contributes 8
 * bits from comparing horizontally-adjacent pixels (9 pixels -> 8 comparisons).
 * dHash is robust to re-encoding, resizing and mild compression, which is what
 * makes it catch near-duplicates that a byte-hash misses.
 */
export async function computeDHash(buffer: Buffer): Promise<string> {
  const { data, info } = await sharp(buffer)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // After grayscale all channels are equal, so read channel 0 regardless of how
  // many channels sharp emitted for this format.
  const ch = info.channels;
  const lum = (row: number, col: number) => data[(row * 9 + col) * ch];

  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits += lum(row, col) < lum(row, col + 1) ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance (number of differing bits) between two 16-char hex dHashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/**
 * Download a photo's original bytes, compute its dHash and store it on the row.
 * Used both on upload (fire-and-forget) and by the backfill.
 */
export function computeAndStorePerceptualHash(photoId: number, storageKey: string): Promise<PerceptualHashResult> {
  return perceptualHashLimiter(() => computeAndStorePerceptualHashUnbounded(photoId, storageKey));
}

async function computeAndStorePerceptualHashUnbounded(photoId: number, storageKey: string): Promise<PerceptualHashResult> {
  if (!storageKey.startsWith("/objects/")) {
    logger.warn({ photoId, storageKey }, "Cannot compute perceptual hash: unexpected storageKey format");
    return "skipped";
  }

  try {
    const sourceFile = resolveSourceFile(storageKey);
    const [exists] = await sourceFile.exists();
    if (!exists) {
      logger.warn({ photoId, storageKey }, "Source file not found, skipping perceptual hash");
      return "skipped";
    }

    const [sourceBuffer] = await sourceFile.download();
    const hash = await computeDHash(sourceBuffer as Buffer);

    await db.update(photosTable).set({ perceptualHash: hash }).where(eq(photosTable.id, photoId));
    // Keep the stored near-duplicate index up to date: compare this photo
    // against every other hashed photo once (O(n)) and record close pairs.
    await insertNearDuplicatePairsForPhoto(photoId, hash);
    logger.info({ photoId }, "Perceptual hash computed and stored");
    return "success";
  } catch (err) {
    logger.error({ err, photoId, storageKey }, "Perceptual hash computation failed");
    return "failed";
  }
}

export async function countPhotosWithoutPerceptualHash(organizationId?: number): Promise<number> {
  const rows = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(
      and(
        isNull(photosTable.perceptualHash),
        isNotNull(photosTable.storageKey),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    );
  return rows.length;
}

export async function backfillPerceptualHashes(limit?: number, organizationId?: number): Promise<{
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
}> {
  const base = db
    .select({ id: photosTable.id, storageKey: photosTable.storageKey })
    .from(photosTable)
    .where(
      and(
        isNull(photosTable.perceptualHash),
        isNotNull(photosTable.storageKey),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    )
    .orderBy(photosTable.createdAt);
  const photos = limit && limit > 0 ? await base.limit(limit) : await base;

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const photo of photos) {
    if (!photo.storageKey) {
      skipped++;
      continue;
    }
    const result = await computeAndStorePerceptualHash(photo.id, photo.storageKey);
    if (result === "success") {
      updated++;
    } else if (result === "skipped") {
      skipped++;
    } else {
      failed++;
    }
  }

  return { processed: photos.length, updated, skipped, failed };
}

export interface NearDuplicatePhoto {
  id: number;
  albumId: number;
  albumTitle: string | null;
  filename: string | null;
  url: string;
  thumbnailKey: string | null;
  perceptualHash: string | null;
  createdAt: Date;
  isAlbumCover: boolean;
  collectionCount: number;
}

export interface NearDuplicateGroup {
  key: string;
  distance: number;
  photos: NearDuplicatePhoto[];
}

export const DEFAULT_NEAR_DUP_THRESHOLD = 6;
// Cap the threshold: past ~10 bits (of 64) the transitive union-find chains
// merely-similar photos into a useless mega-cluster, so "near-duplicate"
// detection stays conservative on purpose.
export const MAX_NEAR_DUP_THRESHOLD = 10;

/**
 * Record near-duplicate pairs for one photo: compare its dHash against every
 * other hashed photo and store pairs within MAX_NEAR_DUP_THRESHOLD. O(n) per
 * call; runs whenever a photo's perceptual hash is (re)computed so the stored
 * index stays current without a full rescan. (A photo's own existing pairs are
 * refreshed by first clearing them.)
 */
export async function insertNearDuplicatePairsForPhoto(photoId: number, hash: string): Promise<void> {
  // Drop any stale pairs for this photo (hash may have changed on recompute).
  await db
    .delete(nearDuplicatePairsTable)
    .where(sql`${nearDuplicatePairsTable.photoA} = ${photoId} OR ${nearDuplicatePairsTable.photoB} = ${photoId}`);

  // Near-duplicate matching stays within a tenant (#113): compare only against
  // this photo's own org, and stamp the org on the resulting pairs.
  const [self] = await db
    .select({ organizationId: photosTable.organizationId })
    .from(photosTable)
    .where(eq(photosTable.id, photoId));
  if (!self) return;
  const organizationId = self.organizationId;

  const others = await db
    .select({ id: photosTable.id, perceptualHash: photosTable.perceptualHash })
    .from(photosTable)
    .where(
      and(
        isNotNull(photosTable.perceptualHash),
        sql`${photosTable.id} <> ${photoId}`,
        eq(photosTable.organizationId, organizationId),
      ),
    );

  const values: { photoA: number; photoB: number; distance: number; organizationId: number }[] = [];
  for (const o of others) {
    const d = hammingDistance(hash, o.perceptualHash as string);
    if (d <= MAX_NEAR_DUP_THRESHOLD) {
      const a = Math.min(photoId, o.id);
      const b = Math.max(photoId, o.id);
      values.push({ photoA: a, photoB: b, distance: d, organizationId });
    }
  }
  if (values.length > 0) {
    await db.insert(nearDuplicatePairsTable).values(values).onConflictDoNothing();
  }
}

/**
 * (Re)build the whole near-duplicate pair index from scratch — the one-time
 * O(n²) scan, run via an admin action for a library that was hashed before the
 * index existed. After this, page loads just read the table.
 */
export async function rebuildNearDuplicatePairs(organizationId?: number): Promise<{ photos: number; pairs: number }> {
  const rows = await db
    .select({ id: photosTable.id, hash: photosTable.perceptualHash, organizationId: photosTable.organizationId })
    .from(photosTable)
    .where(
      and(
        isNotNull(photosTable.perceptualHash),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    )
    .orderBy(photosTable.id);

  // When scoped to an org, only clear that org's pairs; otherwise a full rebuild.
  if (organizationId != null) {
    await db.delete(nearDuplicatePairsTable).where(eq(nearDuplicatePairsTable.organizationId, organizationId));
  } else {
    await db.delete(nearDuplicatePairsTable);
  }

  const n = rows.length;
  const values: { photoA: number; photoB: number; distance: number; organizationId: number }[] = [];
  for (let i = 0; i < n; i++) {
    const hi = rows[i].hash as string;
    for (let j = i + 1; j < n; j++) {
      // Pairs stay within a tenant (#113): never match across orgs.
      if (rows[i].organizationId !== rows[j].organizationId) continue;
      const d = hammingDistance(hi, rows[j].hash as string);
      if (d <= MAX_NEAR_DUP_THRESHOLD) {
        // rows are id-ascending, so rows[i].id < rows[j].id.
        values.push({ photoA: rows[i].id, photoB: rows[j].id, distance: d, organizationId: rows[i].organizationId });
      }
    }
  }
  // Insert in chunks to stay well under Postgres' parameter limit.
  const CHUNK = 5000;
  for (let k = 0; k < values.length; k += CHUNK) {
    await db.insert(nearDuplicatePairsTable).values(values.slice(k, k + CHUNK)).onConflictDoNothing();
  }
  return { photos: n, pairs: values.length };
}

export async function getNearDuplicateIndexStatus(organizationId?: number): Promise<{ pairCount: number; hashedPhotos: number }> {
  const [pairRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(nearDuplicatePairsTable)
    .where(organizationId != null ? eq(nearDuplicatePairsTable.organizationId, organizationId) : undefined);
  const [hashRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(photosTable)
    .where(
      and(
        isNotNull(photosTable.perceptualHash),
        organizationId != null ? eq(photosTable.organizationId, organizationId) : undefined,
      ),
    );
  return { pairCount: pairRow?.c ?? 0, hashedPhotos: hashRow?.c ?? 0 };
}

/**
 * Find groups of near-duplicate photos by reading the stored pair index (no
 * per-request rescan). Pairs within `threshold` bits are unioned transitively;
 * only components with 2+ members are returned, annotated with album-cover /
 * collection membership so the UI can warn before deleting a referenced photo.
 */
export async function listNearDuplicatePhotoGroups(
  threshold: number = DEFAULT_NEAR_DUP_THRESHOLD,
  organizationId?: number,
): Promise<NearDuplicateGroup[]> {
  const rawPairs = await db
    .select({
      a: nearDuplicatePairsTable.photoA,
      b: nearDuplicatePairsTable.photoB,
      distance: nearDuplicatePairsTable.distance,
    })
    .from(nearDuplicatePairsTable)
    .where(
      and(
        lte(nearDuplicatePairsTable.distance, threshold),
        organizationId != null ? eq(nearDuplicatePairsTable.organizationId, organizationId) : undefined,
      ),
    );

  if (rawPairs.length === 0) return [];

  // Drop pairs the user has dismissed as not-duplicates (issue #124) — they
  // live in a separate table so index rebuilds can't resurrect them.
  const ignoreRows = await db
    .select({ a: nearDuplicateIgnoresTable.photoA, b: nearDuplicateIgnoresTable.photoB })
    .from(nearDuplicateIgnoresTable)
    .where(organizationId != null ? eq(nearDuplicateIgnoresTable.organizationId, organizationId) : undefined);
  const ignored = new Set(ignoreRows.map((r) => `${r.a}:${r.b}`));
  const pairs = ignored.size === 0 ? rawPairs : rawPairs.filter((p) => !ignored.has(`${p.a}:${p.b}`));

  if (pairs.length === 0) return [];

  // Union-find over photo ids connected by a stored pair.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root && parent.get(root) !== undefined) root = parent.get(root)!;
    return root;
  };
  const ensure = (x: number) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: number, b: number) => {
    ensure(a); ensure(b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const p of pairs) union(p.a, p.b);

  // Bucket ids by component, tracking the largest joining distance per group.
  const components = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    (components.get(root) ?? components.set(root, []).get(root)!).push(id);
  }
  const groupMaxDistance = new Map<number, number>();
  for (const p of pairs) {
    const root = find(p.a);
    groupMaxDistance.set(root, Math.max(groupMaxDistance.get(root) ?? 0, p.distance));
  }

  const groupRoots = [...components.entries()].filter(([, ids]) => ids.length > 1);
  if (groupRoots.length === 0) return [];

  const groupedIds = groupRoots.flatMap(([, ids]) => ids);

  // Load display details + collection counts for the grouped photos.
  const detailRows = await db
    .select({
      id: photosTable.id,
      albumId: photosTable.albumId,
      albumTitle: albumsTable.title,
      coverPhotoId: albumsTable.coverPhotoId,
      filename: photosTable.filename,
      url: photosTable.url,
      thumbnailKey: photosTable.thumbnailKey,
      perceptualHash: photosTable.perceptualHash,
      createdAt: photosTable.createdAt,
    })
    .from(photosTable)
    .leftJoin(albumsTable, eq(photosTable.albumId, albumsTable.id))
    .where(inArray(photosTable.id, groupedIds));
  const detailById = new Map(detailRows.map((r) => [r.id, r]));

  const collectionCounts = new Map<number, number>();
  const countRows = await db
    .select({ photoId: photoCollectionsTable.photoId, cnt: sql<number>`count(*)::int` })
    .from(photoCollectionsTable)
    .where(inArray(photoCollectionsTable.photoId, groupedIds))
    .groupBy(photoCollectionsTable.photoId);
  for (const c of countRows) collectionCounts.set(c.photoId, c.cnt);

  const groups: NearDuplicateGroup[] = groupRoots.map(([root, ids]) => {
    // Newest first within a group.
    const sorted = ids
      .map((id) => detailById.get(id))
      .filter((r): r is (typeof detailRows)[number] => r !== undefined)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      key: `ndp-${root}`,
      distance: groupMaxDistance.get(root) ?? 0,
      photos: sorted.map((r) => ({
        id: r.id,
        albumId: r.albumId,
        albumTitle: r.albumTitle ?? null,
        filename: r.filename ?? null,
        url: r.url,
        thumbnailKey: r.thumbnailKey ?? null,
        perceptualHash: r.perceptualHash ?? null,
        createdAt: r.createdAt,
        isAlbumCover: r.coverPhotoId === r.id,
        collectionCount: collectionCounts.get(r.id) ?? 0,
      })),
    };
  }).filter((g) => g.photos.length > 1);

  // Largest / most-similar groups first.
  groups.sort((a, b) => b.photos.length - a.photos.length || a.distance - b.distance);
  return groups;
}

// Bulk-cleanup helpers for near-duplicate groups at a given sensitivity
// threshold (#177/#179): they power the one-click "delete a match of every group
// over X% similar" action. threshold 0 = only visually-identical (100%) groups;
// higher thresholds also sweep looser matches. These mirror the exact
// content-hash helpers in contentHash.ts, but for perceptual duplicates. The
// keep rule matches the exact-duplicate one: keep album covers when a group has
// any (covers can't be deleted), else keep the newest photo, delete the rest.

function deletableExtras(group: NearDuplicateGroup): number[] {
  const hasCover = group.photos.some((p) => p.isAlbumCover);
  // photos come newest-first, so slice(1) keeps the newest as the surviving copy.
  const deletable = hasCover ? group.photos.filter((p) => !p.isAlbumCover) : group.photos.slice(1);
  return deletable.map((p) => p.id);
}

export async function getNearDuplicateExtrasSummary(
  threshold: number,
  organizationId?: number,
): Promise<{ groupCount: number; extraCount: number }> {
  const groups = await listNearDuplicatePhotoGroups(threshold, organizationId);
  const extraCount = groups.reduce((sum, g) => sum + deletableExtras(g).length, 0);
  return { groupCount: groups.length, extraCount };
}

export async function computeNearDuplicateExtraIds(
  threshold: number,
  organizationId?: number,
): Promise<number[]> {
  const groups = await listNearDuplicatePhotoGroups(threshold, organizationId);
  return groups.flatMap(deletableExtras);
}

// Dismiss a near-duplicate comparison (issue #124): record every pair among the
// given photos as ignored so the group never resurfaces — including after an
// index rebuild, and even if a future rescan connects only a subset of them.
// Only photos belonging to the org are recorded (a stray id from another tenant
// is silently dropped rather than leaking a cross-org row).
export async function ignoreNearDuplicatePhotos(
  organizationId: number,
  photoIds: number[],
): Promise<{ ignoredPairs: number }> {
  const owned = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(and(inArray(photosTable.id, photoIds), eq(photosTable.organizationId, organizationId)));
  const ids = [...new Set(owned.map((r) => r.id))].sort((x, y) => x - y);
  if (ids.length < 2) return { ignoredPairs: 0 };

  const values: { organizationId: number; photoA: number; photoB: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      values.push({ organizationId, photoA: ids[i], photoB: ids[j] });
    }
  }
  await db.insert(nearDuplicateIgnoresTable).values(values).onConflictDoNothing();
  return { ignoredPairs: values.length };
}
