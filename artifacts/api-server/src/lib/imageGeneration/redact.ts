import { and, eq, inArray } from "drizzle-orm";
import { db, photosTable, type GenerationInput, type ImageGeneration } from "@workspace/db";

// Generation records are shared with the whole org, but a manager may generate
// from a hidden photo (#218). Callers who can't see hidden photos get redacted
// records: no raw storage keys at all, and no name/tags/id for photo inputs
// whose photo is currently hidden.

export const HIDDEN_PHOTO_LABEL = "Hidden photo";

export interface GenerationView {
  canSeeHidden: boolean;
  /** Ids of photos that are hidden right now (only populated for non-managers). */
  hiddenPhotoIds: Set<number>;
}

type RightsEntry = ImageGeneration["rightsSnapshot"][number];

/** Build the view for one request. Managers skip the lookup entirely. */
export async function loadGenerationView(
  organizationId: number,
  canSeeHidden: boolean,
  generations: Pick<ImageGeneration, "inputs" | "rightsSnapshot">[],
): Promise<GenerationView> {
  const hiddenPhotoIds = new Set<number>();
  if (canSeeHidden) return { canSeeHidden, hiddenPhotoIds };
  const ids = new Set<number>();
  for (const g of generations) {
    for (const i of (g.inputs ?? []) as GenerationInput[]) if (i.kind === "photo" && i.refId != null) ids.add(i.refId);
    for (const r of g.rightsSnapshot ?? []) ids.add(r.photoId);
  }
  if (ids.size > 0) {
    const rows = await db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(and(inArray(photosTable.id, [...ids]), eq(photosTable.organizationId, organizationId), eq(photosTable.isHidden, true)));
    for (const r of rows) hiddenPhotoIds.add(r.id);
  }
  return { canSeeHidden, hiddenPhotoIds };
}

export function redactInputs(inputs: GenerationInput[], view: GenerationView): Array<Omit<GenerationInput, "storageKey"> & { storageKey?: string }> {
  if (view.canSeeHidden) return inputs;
  return inputs.map(({ storageKey: _key, ...rest }) =>
    rest.kind === "photo" && rest.refId != null && view.hiddenPhotoIds.has(rest.refId)
      ? { ...rest, refId: null, name: HIDDEN_PHOTO_LABEL }
      : rest,
  );
}

export function redactRights(entries: RightsEntry[], view: GenerationView): RightsEntry[] {
  if (view.canSeeHidden) return entries;
  return entries.filter((r) => !view.hiddenPhotoIds.has(r.photoId));
}

/**
 * Usage notes quote photo names and rights tags, so a note that names a hidden
 * photo is withheld and replaced by one generic line.
 */
export function redactUsageNotes(notes: string[], g: Pick<ImageGeneration, "inputs" | "rightsSnapshot">, view: GenerationView): string[] {
  if (view.canSeeHidden || view.hiddenPhotoIds.size === 0) return notes;
  const hiddenNames = new Set<string>();
  for (const i of (g.inputs ?? []) as GenerationInput[]) {
    if (i.kind === "photo" && i.refId != null && view.hiddenPhotoIds.has(i.refId) && i.name) hiddenNames.add(i.name);
  }
  for (const r of g.rightsSnapshot ?? []) if (view.hiddenPhotoIds.has(r.photoId) && r.name) hiddenNames.add(r.name);
  if (hiddenNames.size === 0) return notes;
  const kept = notes.filter((n) => ![...hiddenNames].some((name) => n.includes(`"${name}"`)));
  return kept.length === notes.length ? notes : [...kept, "Details for a hidden photo are only visible to organization managers."];
}
