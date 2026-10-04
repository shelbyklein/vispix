import { and, eq, inArray } from "drizzle-orm";
import { db, attributionTagsTable, photoAttributionTagsTable, type UsageRightsSnapshot } from "@workspace/db";

// Usage rights (#207, docs/USAGE_RIGHTS.md). A photo's rights are the org's
// rights tags recorded on it. No tag = `not_recorded` (unknown), never "no
// rights"; a tag is the team's own record, never a legal clearance. Policy is
// warning-only: nothing here blocks an action.

export type UsageRightsStatus = UsageRightsSnapshot["status"];
export interface UsageRights {
  status: UsageRightsStatus;
  tags: { id: number; name: string }[];
}

/** The explicit status for a photo's recorded tags. */
export function usageRightsFrom(tags: { id: number; name: string }[]): UsageRights {
  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  return { status: sorted.length > 0 ? "recorded" : "not_recorded", tags: sorted.map((t) => ({ id: t.id, name: t.name })) };
}

/**
 * Current rights for each photo, read at the moment of the action (export,
 * generation, shortlisting). Org-scoped: only the org's own tags count. Every
 * requested id gets an entry — absent data is `not_recorded`, not omitted.
 */
export async function loadUsageRights(photoIds: number[], organizationId: number): Promise<Map<number, UsageRights>> {
  const out = new Map<number, UsageRights>();
  if (photoIds.length === 0) return out;
  const rows = await db
    .select({ photoId: photoAttributionTagsTable.photoId, id: attributionTagsTable.id, name: attributionTagsTable.name })
    .from(photoAttributionTagsTable)
    .innerJoin(attributionTagsTable, eq(attributionTagsTable.id, photoAttributionTagsTable.tagId))
    .where(and(inArray(photoAttributionTagsTable.photoId, photoIds), eq(attributionTagsTable.organizationId, organizationId)));
  const byPhoto = new Map<number, { id: number; name: string }[]>();
  for (const r of rows) (byPhoto.get(r.photoId) ?? byPhoto.set(r.photoId, []).get(r.photoId)!).push({ id: r.id, name: r.name });
  for (const id of photoIds) out.set(id, usageRightsFrom(byPhoto.get(id) ?? []));
  return out;
}

/** A frozen, timestamped copy of a photo's rights. */
export function snapshotOf(rights: UsageRights, checkedAt: Date): UsageRightsSnapshot {
  return { status: rights.status, tags: rights.tags, checkedAt: checkedAt.toISOString() };
}

export interface RightsChange {
  added: { id: number; name: string }[];
  removed: { id: number; name: string }[];
}

/**
 * What changed between a shortlist-time snapshot and the current rights, or
 * null when nothing changed. A missing snapshot (shortlisted before #207)
 * can't be compared and also yields null.
 */
export function rightsChange(before: UsageRightsSnapshot | null | undefined, now: UsageRights): RightsChange | null {
  if (!before) return null;
  const was = new Set(before.tags.map((t) => t.id));
  const is = new Set(now.tags.map((t) => t.id));
  const added = now.tags.filter((t) => !was.has(t.id));
  const removed = before.tags.filter((t) => !is.has(t.id));
  return added.length || removed.length ? { added, removed } : null;
}

/** Plain-language note for generation records; never says "cleared". */
export function usageNote(name: string, rights: UsageRights): string {
  return rights.status === "recorded"
    ? `Photo "${name}" has recorded usage rights: ${rights.tags.map((t) => t.name).join(", ")} (recorded by your team; not a legal clearance).`
    : `Photo "${name}" has no usage rights recorded — check rights before publishing.`;
}
