// In-memory record of the last success / failure of REAL embedding calls
// (#217) — a search-time query embedding, or an image embedding made on upload
// or by the backfill. Nothing here ever calls the provider: it only remembers
// outcomes the app already observed, keyed per organization. State is lost on
// restart (the dashboard then reads "configured" until the next real use),
// which is deliberate: no billable probe is made to fill the gap.
//
// Only a failure *code* is kept — never the provider's response text — so the
// dashboard can't leak secrets or raw provider output.

export type EmbeddingHealthKind = "query" | "image";
export type EmbeddingFailureCode = "timeout" | "provider_error";

export interface EmbeddingHealthRecord {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: EmbeddingFailureCode | null;
}

const records = new Map<string, EmbeddingHealthRecord>();
const key = (kind: EmbeddingHealthKind, organizationId: number) => `${kind}:${organizationId}`;

function entry(kind: EmbeddingHealthKind, organizationId: number): EmbeddingHealthRecord {
  const k = key(kind, organizationId);
  let r = records.get(k);
  if (!r) {
    r = { lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null };
    records.set(k, r);
  }
  return r;
}

export function recordEmbeddingSuccess(kind: EmbeddingHealthKind, organizationId: number, at = new Date()): void {
  entry(kind, organizationId).lastSuccessAt = at;
}

export function recordEmbeddingFailure(
  kind: EmbeddingHealthKind,
  organizationId: number,
  code: EmbeddingFailureCode,
  at = new Date(),
): void {
  const r = entry(kind, organizationId);
  r.lastFailureAt = at;
  r.lastFailureCode = code;
}

export function getEmbeddingHealth(kind: EmbeddingHealthKind, organizationId: number): EmbeddingHealthRecord {
  const r = records.get(key(kind, organizationId));
  return r ? { ...r } : { lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null };
}

/** Test helper. */
export function resetEmbeddingHealth(): void {
  records.clear();
}
