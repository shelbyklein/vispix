import type { GenerationInput, ImageGeneration } from "@workspace/db";
import { redactInputs, type GenerationView } from "./redact";

// Fidelity block of a serialized generation (#215): the API contract's
// GenerationFidelity (lib/api-client-react/src/create.ts). Built from the
// stored row; the route serializer adds it as `fidelity`.

type Role = "hero_photo" | "exact_asset";
type FormatId = "1:1" | "2:3" | "3:2";

export interface GenerationFidelityOut {
  composition: {
    mode: "exact_logo";
    assetId: number;
    assetName: string;
    assetRevision: string;
    layout: { x: number; y: number; width: number; height: number };
    placement: "model_placeholder" | "default_corner";
  } | null;
  photoTreatment: "reinterpreted" | null;
  grounding: { acknowledgedMissing: Role[] };
  formatResolution: { requested: string; rendered: FormatId; supported: boolean } | null;
  provenance: { model: string | null; settings: Record<string, unknown> } | null;
}

type FidelityRow = Pick<
  ImageGeneration,
  "composition" | "photoTreatment" | "acknowledgedMissing" | "formatResolution" | "provenance" | "settings" | "inputs"
>;

const ROLES: Role[] = ["hero_photo", "exact_asset"];
const FORMATS: FormatId[] = ["1:1", "2:3", "3:2"];

/** Settings keys that could carry storage locations; never shown to non-managers. */
const KEY_LIKE = /storage|objectpath|key$/i;

function scrub(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !KEY_LIKE.test(k)));
}

/**
 * The fidelity record for one generation.
 *
 * Managers (`canSeeHidden`) see the file revision with its storage key.
 * Everyone else gets the revision reduced to the content hash and settings with
 * location-like keys removed, matching the redaction of generation records
 * (redact.ts): no raw storage keys, and nothing that names or links a hidden
 * photo. The hero-photo link in the UI comes from the (already redacted)
 * `inputs`; use {@link visibleHeroPhotos} for the same thing server-side.
 */
export function generationProvenance(row: FidelityRow, opts: { canSeeHidden: boolean }): GenerationFidelityOut {
  const comp = row.composition ?? null;
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const hasHero = ((row.inputs ?? []) as GenerationInput[]).some((i) => i.role === "hero_photo");
  const rendered = row.formatResolution?.rendered;
  const prov = row.provenance;
  const model = prov?.model ?? (typeof settings.imageModel === "string" && settings.imageModel ? settings.imageModel : null);
  const provSettings = prov?.settings ?? settings;

  return {
    composition: comp
      ? {
          mode: "exact_logo",
          assetId: comp.assetId,
          assetName: comp.assetName,
          assetRevision: opts.canSeeHidden ? comp.assetRevision : comp.assetRevision.split("#").pop()!,
          layout: comp.layout,
          placement: comp.placement,
        }
      : null,
    // Rows from before #215 had no column, but a hero photo input was always
    // reinterpreted by the model, so say so.
    photoTreatment: row.photoTreatment === "reinterpreted" || (row.photoTreatment == null && hasHero) ? "reinterpreted" : null,
    grounding: { acknowledgedMissing: (row.acknowledgedMissing ?? []).filter((r): r is Role => ROLES.includes(r as Role)) },
    formatResolution:
      row.formatResolution && FORMATS.includes(rendered as FormatId)
        ? { requested: row.formatResolution.requested, rendered: rendered as FormatId, supported: row.formatResolution.supported }
        : null,
    provenance: model || prov ? { model, settings: opts.canSeeHidden ? provSettings : scrub(provSettings) } : null,
  };
}

/**
 * Hero-photo inputs a caller may link to: the redacted inputs, filtered to
 * photos with a visible id (a hidden photo's refId is nulled by redact.ts).
 */
export function visibleHeroPhotos(
  inputs: GenerationInput[],
  view: GenerationView,
): Array<{ photoId: number; name: string | null }> {
  return redactInputs(inputs, view)
    .filter((i) => i.role === "hero_photo" && i.kind === "photo" && i.refId != null)
    .map((i) => ({ photoId: i.refId as number, name: i.name }));
}
