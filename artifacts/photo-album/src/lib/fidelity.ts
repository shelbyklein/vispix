import type { GenerationFidelity } from "@workspace/api-client-react";

// #215: plain-language lines describing how a generated image was made, shared
// by the Create result card (compact labels) and the Generations detail dialog
// (labels + detail).

export type FidelityLine = {
  /** Headline shown in the detail panel. */
  label: string;
  /** Short form for the compact label row on result cards. */
  compact: string;
  detail?: string;
  kind: "logo" | "other";
  photoLinks?: { photoId: number; name: string | null }[];
};

export function fidelityLines(g: {
  fidelity?: GenerationFidelity;
  heroPhotos?: { photoId: number; name: string | null }[];
}): FidelityLine[] {
  const f = g.fidelity;
  if (!f) return [];
  const lines: FidelityLine[] = [];
  if (f.composition) {
    const isDefault = f.composition.placement === "default_corner";
    lines.push({
      label: isDefault ? "Logo placed exactly, at default position" : "Logo placed exactly",
      compact: isDefault ? "Logo placed exactly · default position" : "Logo placed exactly",
      kind: "logo",
      detail:
        `${f.composition.assetName} (original file, revision ${f.composition.assetRevision.split("#").pop()}) at ` +
        `${f.composition.layout.width}x${f.composition.layout.height}px` +
        (isDefault ? ", bottom-right because the model left no placement box" : ""),
    });
  } else if (f.grounding.acknowledgedMissing.includes("exact_asset")) {
    lines.push({ label: "No logo used", compact: "No logo used", kind: "other", detail: "Generated without a logo, as chosen." });
  }
  if (f.photoTreatment === "reinterpreted") {
    lines.push({
      label: "Photo reinterpreted by AI",
      compact: "Photo reinterpreted by AI",
      kind: "other",
      detail: "Not pixel-exact; the model redrew the photo.",
      photoLinks: g.heroPhotos ?? [],
    });
  } else if (f.grounding.acknowledgedMissing.includes("hero_photo")) {
    lines.push({ label: "No photo used", compact: "No photo used", kind: "other", detail: "Generated without a photo, as chosen." });
  }
  if (f.formatResolution && !f.formatResolution.supported) {
    const text = `Asked for ${f.formatResolution.requested}; made ${f.formatResolution.rendered}`;
    lines.push({ label: text, compact: text, kind: "other", detail: "The closest supported canvas was used." });
  }
  return lines;
}
