// Brand-asset ranking for Create and Campaigns (#206). Replaces "any brand
// asset, alphabetically": a request is matched on the designated primary mark,
// requested variant, identity words in name/notes, and project scope — and
// every candidate carries the reasons it was ranked where it is.

export interface RankableAsset {
  id: number;
  name: string;
  kind: "brand" | "reference";
  variant: string | null;
  notes: string | null;
  projectId: number | null;
  projectName: string | null;
  isPrimary: boolean;
}

export type MatchConfidence = "high" | "medium" | "low";

export interface RankedAsset<T extends RankableAsset = RankableAsset> {
  asset: T;
  score: number;
  reasons: string[];
  confidence: MatchConfidence;
  /** The effective primary mark for this request's scope. */
  isEffectivePrimary: boolean;
}

// Variant vocabulary: a requested variant matches an asset whose variant,
// name or notes use any of its words.
const VARIANTS: Record<string, string[]> = {
  white: ["white", "reverse", "reversed", "knockout"],
  black: ["black"],
  dark: ["dark"],
  light: ["light"],
  horizontal: ["horizontal", "wide", "landscape", "lockup"],
  vertical: ["vertical", "stacked"],
  icon: ["icon", "symbol", "emblem", "monogram", "favicon"],
  mono: ["mono", "monochrome", "one-color", "single-color"],
  color: ["color", "colour", "full-color"],
};
const PRIMARY_WORDS = ["primary", "main", "official", "standard", "default"];
// Words that say "a logo" without identifying which one.
const GENERIC = new Set([
  "logo", "logos", "mark", "marks", "brand", "brandmark", "logotype", "wordmark", "the", "a", "an", "our", "of", "for",
  "and", "with", "in", "on", "to", "version", "variant", "file", "image", "graphic", "asset", "use", "using", "please",
]);

function words(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
}

function hasAny(haystack: string[], needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export interface ParsedAssetQuery {
  /** Requested variants, e.g. ["white"]. */
  variants: string[];
  /** Asks for the primary/official mark. */
  wantsPrimary: boolean;
  /** Identity words, e.g. ["usa", "archery"]. */
  identity: string[];
}

export function parseAssetQuery(query: string): ParsedAssetQuery {
  const w = words(query);
  const variants = Object.entries(VARIANTS)
    .filter(([, syn]) => hasAny(w, syn))
    .map(([key]) => key);
  const variantWords = new Set(variants.flatMap((v) => VARIANTS[v]));
  const identity = w.filter((x) => !GENERIC.has(x) && !variantWords.has(x) && !PRIMARY_WORDS.includes(x) && x.length > 1);
  return { variants, wantsPrimary: hasAny(w, PRIMARY_WORDS), identity: [...new Set(identity)] };
}

/**
 * Rank assets for one request. `projectId` scopes the request: that project's
 * assets are preferred, other projects' assets are excluded, and that
 * project's designated primary overrides the organization's.
 */
export function rankBrandAssets<T extends RankableAsset>(
  assets: T[],
  query: string,
  opts: { projectId?: number | null } = {},
): RankedAsset<T>[] {
  const q = parseAssetQuery(query);
  const projectId = opts.projectId ?? null;
  const inScope = assets.filter((a) => a.projectId == null || projectId == null || a.projectId === projectId);
  const projectPrimary = projectId != null ? inScope.find((a) => a.isPrimary && a.projectId === projectId) : undefined;
  const orgPrimary = inScope.find((a) => a.isPrimary && a.projectId == null);
  const effectivePrimary = projectPrimary ?? orgPrimary;

  const ranked = inScope.map((asset) => {
    const reasons: string[] = [];
    let score = 0;
    const nameW = words(asset.name);
    const notesW = words(asset.notes);
    const variantW = words(asset.variant);
    const assetVariantWords = [...variantW, ...nameW, ...notesW];
    const isEffectivePrimary = effectivePrimary?.id === asset.id;
    const inName = q.identity.filter((x) => nameW.includes(x));
    const inNotes = q.identity.filter((x) => !inName.includes(x) && notesW.includes(x));
    const inProject = q.identity.filter((x) => !inName.includes(x) && !inNotes.includes(x) && words(asset.projectName).includes(x));
    const namesSomethingElse = q.identity.length > 0 && inName.length + inNotes.length + inProject.length === 0 && !q.wantsPrimary;

    // Designated primary: decisive for a generic, "primary" or same-identity
    // logo request; only a tie-breaker when a specific variant (white, icon…)
    // or a different mark (e.g. an event logo) was asked for.
    if (isEffectivePrimary) {
      if (q.variants.length === 0 && !namesSomethingElse) {
        score += 40;
        reasons.push(projectPrimary ? "Designated primary logo for this project" : "Designated primary logo");
      } else {
        score += 5;
        reasons.push(
          q.variants.length > 0
            ? "Designated primary logo (a different variant was requested)"
            : "Designated primary logo (a different mark was requested)",
        );
      }
    } else if (q.wantsPrimary && hasAny(variantW, PRIMARY_WORDS)) {
      score += 15;
      reasons.push(`Variant “${asset.variant}”`);
    }

    // Requested variants.
    for (const v of q.variants) {
      if (hasAny(assetVariantWords, VARIANTS[v])) {
        score += 30;
        reasons.push(`Matches requested ${v} variant${asset.variant ? ` (“${asset.variant}”)` : ""}`);
      } else if (variantW.length > 0) {
        score -= 10;
      }
    }

    // Identity words (the org, event, product…).
    if (inName.length) {
      score += 12 * inName.length;
      reasons.push(`Name matches “${inName.join(" ")}”`);
    }
    if (inNotes.length) {
      score += 4 * inNotes.length;
      reasons.push(`Notes mention “${inNotes.join(" ")}”`);
    }
    if (inProject.length) {
      score += 6 * inProject.length;
      reasons.push(`Project “${asset.projectName}”`);
    }
    // A logo-shaped request should prefer assets that call themselves logos.
    if (hasAny(nameW, ["logo", "logos", "mark", "wordmark", "logotype"]) || hasAny(variantW, PRIMARY_WORDS)) score += 3;

    if (projectId != null && asset.projectId === projectId) {
      score += 8;
      reasons.push("Asset for this project");
    }
    if (asset.kind === "brand") score += 1;

    const confidence: MatchConfidence =
      (isEffectivePrimary && q.variants.length === 0 && !namesSomethingElse) || score >= 40 ? "high" : score >= 15 ? "medium" : "low";
    if (reasons.length === 0) reasons.push(asset.kind === "brand" ? "Brand asset — no specific match" : "No specific match");
    return { asset, score, reasons, confidence, isEffectivePrimary };
  });

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.isEffectivePrimary) - Number(a.isEffectivePrimary) ||
      a.asset.name.localeCompare(b.asset.name) ||
      a.asset.id - b.asset.id,
  );
}
