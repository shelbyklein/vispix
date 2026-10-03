import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  collectionsTable,
  photoCollectionsTable,
  collectionNegativePhotosTable,
  photoCollectionSuggestionsTable,
  photoNewCollectionSuggestionsTable,
} from "@workspace/db";

/**
 * Collection recommendations: the canonical lifecycle (docs/COLLECTION_SUGGESTIONS.md).
 *
 * A (photo, collection) pair has at most one suggestion row, and the row is the
 * single authority for its state: pending -> accepted | dismissed. Rows are never
 * deleted by re-analysis once decided, so a dismissal stays dismissed. Bump
 * ANALYSIS_VERSION when the suggestion prompt/logic changes materially; it is
 * recorded on each row so a future policy can allow re-offering on new evidence.
 */
export const ANALYSIS_VERSION = "collections-v1";

export interface SuggestionProvenance {
  source: "model" | "heuristic";
  provider: string | null;
  model: string | null;
  analysisVersion: string | null;
  reason: string | null;
}

export interface PendingCollectionSuggestion extends SuggestionProvenance {
  photoId: number;
  id: number;
  title: string;
}

export interface PendingNewCollectionSuggestion extends SuggestionProvenance {
  photoId: number;
  id: number;
  suggestedName: string;
}

/** Normalised form used to match a re-suggested new-collection name against earlier decisions. */
export function normalizeSuggestedName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pending collection suggestions for the given photos. Only org collections of
 * kind "collection" are served (people stay manual), and a suggestion for a
 * collection the photo is already in is never shown: membership wins.
 */
export async function listPendingCollectionSuggestions(
  photoIds: number[],
  organizationId: number,
): Promise<PendingCollectionSuggestion[]> {
  if (photoIds.length === 0) return [];
  const s = photoCollectionSuggestionsTable;
  return db
    .select({
      photoId: s.photoId,
      id: collectionsTable.id,
      title: collectionsTable.title,
      source: s.source,
      provider: s.provider,
      model: s.model,
      analysisVersion: s.analysisVersion,
      reason: s.reason,
    })
    .from(s)
    .innerJoin(collectionsTable, eq(s.collectionId, collectionsTable.id))
    .where(
      and(
        inArray(s.photoId, photoIds),
        eq(s.status, "pending"),
        eq(collectionsTable.organizationId, organizationId),
        eq(collectionsTable.kind, "collection"),
        sql`NOT EXISTS (SELECT 1 FROM ${photoCollectionsTable} pc WHERE pc.collection_id = ${s.collectionId} AND pc.photo_id = ${s.photoId})`,
      ),
    )
    .orderBy(s.createdAt, collectionsTable.title);
}

export async function listPendingNewCollectionSuggestions(
  photoIds: number[],
): Promise<PendingNewCollectionSuggestion[]> {
  if (photoIds.length === 0) return [];
  const s = photoNewCollectionSuggestionsTable;
  return db
    .select({
      photoId: s.photoId,
      id: s.id,
      suggestedName: s.suggestedName,
      source: s.source,
      provider: s.provider,
      model: s.model,
      analysisVersion: s.analysisVersion,
      reason: s.reason,
    })
    .from(s)
    .where(and(inArray(s.photoId, photoIds), eq(s.status, "pending")))
    .orderBy(s.id);
}

/**
 * A human added the photo to the collection directly: resolve any pending
 * suggestion for the pair as accepted/manual. A dismissed row is left as the
 * record of the earlier dismissal (the membership itself is the human decision).
 */
export async function resolveSuggestionAsManual(
  collectionId: number,
  photoId: number,
  userId: number | null,
): Promise<void> {
  const s = photoCollectionSuggestionsTable;
  await db
    .update(s)
    .set({ status: "accepted", resolution: "manual", decidedAt: new Date(), decidedById: userId })
    .where(and(eq(s.photoId, photoId), eq(s.collectionId, collectionId), eq(s.status, "pending")));
}

export type DecisionOutcome = "applied" | "unchanged" | "conflict" | "missing";

/**
 * Accept or dismiss a collection suggestion. Idempotent: repeating the same
 * decision is "unchanged" (no second membership, no state churn), the opposite
 * decision on a resolved row is a "conflict", and no row at all is "missing".
 * Accepting adds the (single) membership and clears any negative example for
 * the pair, since a photo is a positive, a negative, or neither.
 */
export async function decideCollectionSuggestion(
  photoId: number,
  collectionId: number,
  decision: "accepted" | "dismissed",
  userId: number | null,
): Promise<DecisionOutcome> {
  const s = photoCollectionSuggestionsTable;
  return db.transaction(async (tx) => {
    const [changed] = await tx
      .update(s)
      .set({ status: decision, resolution: "review", decidedAt: new Date(), decidedById: userId })
      .where(and(eq(s.photoId, photoId), eq(s.collectionId, collectionId), eq(s.status, "pending")))
      .returning({ photoId: s.photoId });
    if (!changed) {
      const [row] = await tx
        .select({ status: s.status })
        .from(s)
        .where(and(eq(s.photoId, photoId), eq(s.collectionId, collectionId)));
      if (!row) return "missing";
      return row.status === decision ? "unchanged" : "conflict";
    }
    if (decision === "accepted") {
      await tx.insert(photoCollectionsTable).values({ collectionId, photoId }).onConflictDoNothing();
      await tx
        .delete(collectionNegativePhotosTable)
        .where(and(eq(collectionNegativePhotosTable.collectionId, collectionId), eq(collectionNegativePhotosTable.photoId, photoId)));
    }
    return "applied";
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Decide a new-collection-name suggestion with the same idempotent semantics.
 * `onClaimed` runs in the same transaction as the status change (create the
 * collection and add the photo on accept), so a repeat accept can never create
 * a second collection.
 */
export async function decideNewCollectionSuggestion(
  photoId: number,
  suggestionId: number,
  decision: "accepted" | "dismissed",
  userId: number | null,
  onClaimed?: (tx: Tx, suggestedName: string) => Promise<void>,
): Promise<DecisionOutcome> {
  const s = photoNewCollectionSuggestionsTable;
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(s)
      .set({ status: decision, resolution: "review", decidedAt: new Date(), decidedById: userId })
      .where(and(eq(s.id, suggestionId), eq(s.photoId, photoId), eq(s.status, "pending")))
      .returning({ suggestedName: s.suggestedName });
    if (!claimed) {
      const [row] = await tx.select({ status: s.status }).from(s).where(and(eq(s.id, suggestionId), eq(s.photoId, photoId)));
      if (!row) return "missing";
      return row.status === decision ? "unchanged" : "conflict";
    }
    await onClaimed?.(tx, claimed.suggestedName);
    return "applied";
  });
}
