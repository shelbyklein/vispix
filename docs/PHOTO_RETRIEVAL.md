# Photo retrieval contract (#213)

One service answers "which photos match this request, in what order" for the
web app, the MCP connector and Create. It lives in
`artifacts/api-server/src/lib/photoRetrieval.ts`. Callers adapt their inputs to
it; none of them runs its own ranking query.

Version: **`photo-retrieval/1`**. Every response records it along with the
embedding model and ranking policy, so results can be traced to how they were
produced.

## Inputs

```ts
retrievePhotos({
  organizationId,          // required; a positive integer from the authenticated session
  canSeeHidden,            // true only for org admins who asked for hidden photos
  mode: "keyword" | "concept",
  text,                    // the user's query, trimmed; empty → empty result
  exclude,                 // terms; see "Exclusions"
  filters,                 // normalized, see below
  limit,                   // 1–200
  cursor,                  // opaque, from a previous page (or offset, legacy adapters only)
  signal,                  // optional AbortSignal; aborts the provider call
})
```

**Scope is mandatory.** The service throws when `organizationId` is missing or
not a positive integer. It never runs an unscoped query. Tenant, visibility and
every filter are SQL predicates in the same statement that ranks and limits, so
a page can never be thinned after the fact.

### Filters

| Filter | Meaning | Web | MCP | Create |
|---|---|---|---|---|
| `dateFrom` / `dateTo` | Capture date, whole UTC days, `dateTo` inclusive; undated photos excluded when set (#205) | ✓ | – | – |
| `ratingMin` / `ratingMax` | Average user rating 0–5, unrated = 0 | ✓ | `minRating` | – |
| `minQuality` | AI overall score 0–10; unevaluated photos excluded | ✓ | ✓ | – |
| `uploaderId` | Exact uploader | ✓ | – | – |
| `rightsTagId` | Photo carries this usage-rights tag (resolved by name inside the org) | – | `rightsTag` | – |
| `personId` | Photo is in this person collection (resolved by name inside the org) | – | `person` | – |
| visibility | Hidden photos excluded unless `canSeeHidden` | admins | never | never |

Name lookups for `rightsTag` and `person` are org-scoped. An unknown name is an
explicit "no such tag/person" result that lists the org's own names; it's never
treated as "no filter".

## Modes and ranking

### `concept` (semantic)

The query text, steered by any exclusions, is embedded with the same Vertex
model as the photos (`vertex/multimodalembedding@001`). Photos embedded with
their description blended in (`…+desc`) live in the same space. Then **every**
qualifying photo in the org that has an embedding is ranked exactly:

```
score = similarity × 0.85 + (aiOverallScore ?? 5) / 10 × 0.15
order: score DESC, photo id ASC
```

- `similarity` is cosine similarity (`1 − cosine distance`). The 0.15 quality
  weight (#181) breaks ties between similar matches; relevance still dominates.
  Photos without an AI evaluation get a neutral 5 so the backfill doesn't bury
  them.
- The ranking is **exact, not approximate**. The HNSW index is not used for text
  queries, so no candidate window exists: a qualifying photo is reachable no
  matter how deep it ranks or how selective the filters are. On dev
  (7,476 embedded photos, 1408 dimensions) the exact query costs about 52 ms
  against 37 ms for the old approximate top-200. See "Performance and bounds".
- Concept search has no relevance cutoff. It orders the library and reports no
  calibrated confidence. Paging stops at `MAX_CONCEPT_DEPTH` (1,000); beyond
  that the result is `limited`.
- A photo with no embedding can't be found in concept mode.
  `coverage.notEmbedded` counts the qualifying photos in that state.

### `keyword`

The query matches, case-insensitively and as a substring, the album title, the
uploader's name or the AI description:

```
order: round(aiOverallScore ?? 5) DESC, created_at DESC, photo id DESC
```

Keyword results are genuine matches, so paging runs until they're exhausted
(no depth cap). Each item reports which fields matched.

### Exact lookup and combined mode (#208)

These modes are reserved for #208 (FIND-02) and must follow this precedence:
exact authorized matches (photo ID, exact filename) come first, then concept
results with those photos removed. Exact matches obey scope and visibility like
everything else. When the provider is unavailable, exact matches are still
returned with a degraded state.

### Exclusions

- **keyword:** hard removal of photos whose AI description contains any term.
- **concept:** the query vector is steered away:
  `normalize(q) − 0.75 × normalize(embed(terms))`. This is a ranking
  preference, not guaranteed absence.

## Output

```ts
{
  status: "ok" | "unavailable",
  items: [{ photoId, match }],   // match: { type: "keyword", fields: [...] }
                                 //      | { type: "concept", similarity, qualityScore, score }
  page: { nextCursor, exhausted, limited },
  total,                         // qualifying results: keyword matches, or ranked (embedded) photos for concept
  coverage: { notEmbedded },     // concept only
  degraded: { reason, affects } | null,  // reason: "not_configured" | "timeout" | "cancelled" | "provider_error"
                                         // affects: "query" (nothing ranked) | "exclusions" (ranked, exclusions not applied)
  retrieval: { version, mode, embeddingModel, ranking },
}
```

| State | Meaning |
|---|---|
| `ok`, items, `nextCursor` set | More results follow |
| `ok`, `exhausted: true` | No further qualifying photos exist |
| `ok`, `limited: true` | More exist, but paging stopped at the depth cap |
| `ok`, no items, `exhausted: true` | Zero genuine matches |
| `unavailable` + `degraded.reason` | The embedding provider isn't configured, timed out or failed; nothing was ranked. This is not an empty result |
| `ok` + `degraded.affects: "exclusions"` | Results are ranked, but the exclusion terms couldn't be embedded, so they weren't applied |
| error `search_timeout` | The database query exceeded its statement timeout |
| error `cursor_mismatch` | The cursor belongs to a different query, filter set, model or ranking version; restart from page one |

## Continuation

Cursors are keyset positions, not offsets: `(score, id)` for concept and
`(tier, created_at, id)` for keyword. They're bound to a hash of the normalized
request (mode, text, exclusions, filters, visibility), the embedding model, the
ranking version and, for concept, the query vector. Any change invalidates the
cursor with `cursor_mismatch` instead of silently mixing two orderings. Photos
added while a user pages don't shift later pages, and they appear on a fresh
search.

Query embeddings are cached in memory (per model and text, 30 minutes) so later
pages reuse the same vector and don't spend another provider call.

The legacy offset/topK endpoints use the same ordering through an offset
adapter.

## Performance and bounds

- Provider call: 8 s timeout, cancellable through `signal`. The result is
  reported as `degraded`, never as an empty result.
- Database: each retrieval runs with a 5 s statement timeout.
- Concept cost is linear in the org's qualifying embedded photos. It sorts
  top-N inside Postgres and never materializes the library in Node. If a
  library grows past about 50k embedded photos, the execution strategy can move
  to candidate generation from the ANN index with a quality margin, without
  changing this contract.

### Measured (2026-09-29)

Synthetic library in a local Postgres 15 + pgvector 0.8: 29,250 embedded
photos in the queried org and 9,800 in another, 1408-dim vectors, a third of
the photos AI-evaluated. Figures are the median of 7 runs of `retrievePhotos`,
including the count queries.

| Request | Median | Result |
|---|---|---|
| concept, page 1 (30) | 132 ms | 30 of 29,250 |
| concept, page 5 via cursor (200) | 138 ms | 200 |
| concept + `minQuality` 7 | 36 ms | 30 of 3,000 |
| concept + rights tag (1% of the library) | 5 ms | 30 of 301 |
| concept + `ratingMin` 1 (nothing rated) | 56 ms | 0, exhausted |
| keyword, broad (40% match) | 63 ms | 30 of 12,000 |
| keyword, narrow | 51 ms | 30 of 750 |

The concept plan (auto_explain) is one pass over the org's photos with a hash
join to embeddings and evaluations. The distance is computed once per photo
(subquery fenced with `OFFSET 0`), followed by a top-N heapsort using 29 kB,
for 99 ms in the database. On dev's real library (7,476 photos) the same
exact ranking took 52 ms.

## Callers

| Caller | Before | Now |
|---|---|---|
| Web keyword (`GET /search`) | ILIKE unions materialized in Node, then SQL filter and order, offset | `keyword` mode through the offset adapter; same response shape |
| Web semantic (`GET /search/semantic`) | HNSW top-2×topK, then blend | `concept` mode, first `topK`; same array response |
| Web contract (`GET /search/photos`) | – | The full contract: items, cursor, states, ranking metadata |
| Create page photo picker | `/search/semantic` | Unchanged endpoint, now the service |
| Create planner / campaign hero photo (`findPhotoCandidates`) | HNSW top-6, no blend; any-word ILIKE fallback | `concept`, limit 6; when unavailable, `keyword` with the degraded state recorded |
| MCP `search_photos` | HNSW, post-filtered over-fetch (≤500), no blend | `concept` with every filter in SQL; notes report exhausted/limited/degraded |
| MCP local stdio server | Unscoped (all orgs) | Scoped: `VISPIX_MCP_ORGANIZATION_ID`, or the only org when exactly one exists; otherwise search refuses with a note |

Identical normalized inputs therefore produce identical ordered IDs in every
caller. Page size doesn't change the order, because the ranking has no window.

## Deliberate exceptions

- **Smart collections** (`smartCollectionPhotos.ts`) rank by the centroid of the
  collection's members minus its negative examples. That's a different intent
  ("more like these"), so they keep their own ranking and share only
  scope/visibility.
- **Similar photos** (`GET /photos/:id/similar`) is nearest neighbours of one
  photo, not a query. It keeps the HNSW path.
- **Photos page listing** (`GET /photos`) is a browse filter, not a search. Its
  shared predicates (date, rating, uploader) move to the SQL filter module under
  #205 FILTER-04.
