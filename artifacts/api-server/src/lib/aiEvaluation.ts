import type { RawPhotoEvaluation } from "./aiProviders/types";

// AI criteria evaluation (#181): normalization + scoring for the criteria block
// providers return alongside the photo description. The weights live here (not
// in the DB) so they can be tuned without re-analysing photos — overallScore is
// recomputed and re-stored whenever a photo is (re-)analysed.

export const EVALUATION_CRITERIA = [
  "technicalQuality",
  "composition",
  "subjectClarity",
  "emotionalImpact",
  "marketingUsability",
] as const;

export type EvaluationCriterion = (typeof EVALUATION_CRITERIA)[number];

// Weighted mean over the 0–10 criteria. Technical quality weighs most — a
// blurry shot is unusable no matter how well composed.
export const EVALUATION_WEIGHTS: Record<EvaluationCriterion, number> = {
  technicalQuality: 0.25,
  composition: 0.2,
  subjectClarity: 0.2,
  emotionalImpact: 0.15,
  marketingUsability: 0.2,
};

export interface PhotoEvaluationScores {
  technicalQuality: number;
  composition: number;
  subjectClarity: number;
  emotionalImpact: number;
  marketingUsability: number;
  flaws: string[];
  orientationSuitability: string | null;
  overallScore: number;
}

function clampScore(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, Math.round(n)));
}

export function computeOverallScore(scores: Record<EvaluationCriterion, number>): number {
  const total = EVALUATION_CRITERIA.reduce(
    (sum, c) => sum + scores[c] * EVALUATION_WEIGHTS[c],
    0,
  );
  // Weights sum to 1, so this is already on the 0–10 scale.
  return Math.round(total * 10) / 10;
}

/**
 * Validate + clamp a provider's raw evaluation block. Returns null when the
 * block is missing or any criterion is absent/non-numeric — a photo simply has
 * no evaluation then (analysis still succeeds; description/suggestions persist).
 */
export function normalizeEvaluation(raw: RawPhotoEvaluation | null | undefined): PhotoEvaluationScores | null {
  if (!raw || typeof raw !== "object") return null;
  const clamped: Partial<Record<EvaluationCriterion, number>> = {};
  for (const c of EVALUATION_CRITERIA) {
    const v = clampScore((raw as unknown as Record<string, unknown>)[c]);
    if (v == null) return null;
    clamped[c] = v;
  }
  const scores = clamped as Record<EvaluationCriterion, number>;
  const flaws = Array.isArray(raw.flaws)
    ? raw.flaws.map((f) => String(f).trim()).filter((f) => f.length > 0 && f.length <= 80).slice(0, 6)
    : [];
  const orientation = typeof raw.orientationSuitability === "string" ? raw.orientationSuitability.trim() : "";
  return {
    ...scores,
    flaws,
    orientationSuitability: orientation.length > 0 ? orientation.slice(0, 200) : null,
    overallScore: computeOverallScore(scores),
  };
}
