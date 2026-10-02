// One photo query/result service for the web app, MCP and Create (#213).
// Contract: docs/PHOTO_RETRIEVAL.md. Callers adapt their inputs to
// retrievePhotos(); none of them runs its own ranking query.
//
// Every request is scoped to one organization, and tenant, visibility and all
// filters are SQL predicates in the statement that ranks and limits, so a page
// is never thinned after the fact. Concept (semantic) ranking is exact over the
// org's qualifying embedded photos, not an approximate top-N window, so the
// order doesn't depend on page size and deep results stay reachable.
import { createHash } from "node:crypto";
import { and, notInArray, sql, type SQL } from "drizzle-orm";
import { db, photosTable, photoEmbeddingsTable, photoAiEvaluationsTable, albumsTable, usersTable } from "@workspace/db";
import { embedQuery, EMBEDDING_MODEL_TAG, type EmbedFailure } from "./aiEmbedding";
import { photoFilterConditions, type SearchFilters } from "./searchFilters";

export const RETRIEVAL_VERSION = "photo-retrieval/1";
/** Weight of the AI overall score (#181) in concept ranking; relevance keeps the rest. */
export const CONCEPT_QUALITY_WEIGHT = 0.15;
/** Score assumed for photos without an AI evaluation, so the backfill doesn't bury them. */
export const NEUTRAL_QUALITY_SCORE = 5;
/** How hard an excluded concept pushes the concept query vector away from it. */
export const NEGATIVE_LAMBDA = 0.75;
/** Concept search orders the whole library; paging stops here ("limited"). */
export const MAX_CONCEPT_DEPTH = 1000;
export const MAX_PAGE_SIZE = 200;
const STATEMENT_TIMEOUT_MS = 5000;

const W = CONCEPT_QUALITY_WEIGHT;
const CONCEPT_RANKING = `exact: similarity*${1 - W} + (quality ?? ${NEUTRAL_QUALITY_SCORE})/10*${W} desc, id asc`;
const KEYWORD_RANKING = `round(quality ?? ${NEUTRAL_QUALITY_SCORE}) desc, created_at desc, id desc`;

export type RetrievalMode = "combined" | "keyword" | "concept";
/** The ranking behind a page: combined mode continues one of these. */
type RankedMode = "keyword" | "concept";
/** Exact matches are capped; they're lookups, not a ranking. */
export const MAX_EXACT_MATCHES = 50;
export type RetrievalFilters = Omit<SearchFilters, "includeHidden" | "exclude">;

export interface RetrievalRequest {
  /** Required: the authenticated session's organization. */
  organizationId: number;
  /** True only for org admins who asked to include hidden photos. */
  canSeeHidden: boolean;
  mode: RetrievalMode;
  text: string;
  /** keyword: hard removal by AI description; concept: steers the query vector away. */
  exclude?: string[];
  filters?: RetrievalFilters;
  limit: number;
  /** Opaque continuation from a previous page. */
  cursor?: string | null;
  /** Legacy offset/topK adapters only; ignored when a cursor is given. */
  offset?: number;
  /** Aborts the embedding provider call (e.g. the client went away). */
  signal?: AbortSignal;
}

export type KeywordField = "album_title" | "uploader" | "description" | "filename";
export type ExactField = "photo_id" | "filename";
export type RetrievalMatch =
  | { type: "exact"; fields: ExactField[] }
  | { type: "keyword"; fields: KeywordField[] }
  | { type: "concept"; similarity: number; qualityScore: number | null; score: number };

export interface RetrievalResult {
  status: "ok" | "unavailable";
  items: { photoId: number; match: RetrievalMatch }[];
  page: { nextCursor: string | null; exhausted: boolean; limited: boolean };
  /** Qualifying results: keyword matches, or ranked (embedded) photos for concept. */
  total: number | null;
  /** Concept only: qualifying photos without an embedding, which concept search can't find. */
  coverage: { notEmbedded: number } | null;
  /**
   * Provider trouble: nothing ranked ("query"), exclusions not applied
   * ("exclusions"), or combined search fell back to literal matches ("concept").
   */
  degraded: { reason: EmbedFailure; affects: "query" | "exclusions" | "concept" } | null;
  retrieval: { version: string; mode: RetrievalMode; embeddingModel: string | null; ranking: string };
}

export type RetrievalErrorCode = "invalid_scope" | "invalid_cursor" | "cursor_mismatch" | "search_timeout";

export class RetrievalError extends Error {
  constructor(
    readonly code: RetrievalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RetrievalError";
  }
}

// ---------------------------------------------------------------------------
// Query embeddings: cached per model and text so later pages reuse the same
// vector (a stable ordering) without another provider call.

const EMBED_CACHE_TTL_MS = 30 * 60 * 1000;
const EMBED_CACHE_MAX = 500;
const embedCache = new Map<string, { vec: number[]; at: number }>();

export function clearQueryEmbeddingCache(): void {
  embedCache.clear();
}

async function embedCached(
  text: string,
  signal?: AbortSignal,
  organizationId?: number,
): Promise<{ ok: true; vec: number[] } | { ok: false; reason: EmbedFailure }> {
  const key = `${EMBEDDING_MODEL_TAG}\u0000${text}`;
  const now = Date.now();
  const hit = embedCache.get(key);
  if (hit && now - hit.at < EMBED_CACHE_TTL_MS) {
    embedCache.delete(key);
    embedCache.set(key, hit);
    return { ok: true, vec: hit.vec };
  }
  const r = await embedQuery(text, { signal, organizationId });
  if (r.ok) {
    embedCache.set(key, { vec: r.vec, at: now });
    while (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value as string);
  }
  return r;
}

function normalizeVec(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

// ---------------------------------------------------------------------------
// Cursors: keyset positions bound to the request that produced them.

interface CursorBody {
  v: 1;
  /** Hash of the normalized request (plus model/vector for concept). */
  h: string;
  /** Results already returned before this position (depth cap accounting). */
  n: number;
  /** concept: [score, id]; keyword: [tier, created_at text, id]. */
  k: (number | string)[];
  /** Which ranking produced the page (combined mode continues it). */
  s?: RankedMode;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function encodeCursor(c: CursorBody): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

/** Decode and validate a cursor; `expected` is the ranking it must continue, if known. */
function decodeCursor(raw: string, expected?: RankedMode): CursorBody & { s: RankedMode } {
  const bad = () => new RetrievalError("invalid_cursor", "The continuation cursor is malformed; restart the search.");
  let c: CursorBody;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorBody;
  } catch {
    throw bad();
  }
  if (!c || c.v !== 1 || typeof c.h !== "string" || !Number.isSafeInteger(c.n) || c.n < 0 || !Array.isArray(c.k)) throw bad();
  const ranked = c.s ?? expected;
  if ((c.s != null && c.s !== "concept" && c.s !== "keyword") || !ranked || (expected && ranked !== expected)) throw bad();
  const isId = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;
  const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const ok =
    ranked === "concept"
      ? c.k.length === 2 && isNum(c.k[0]) && isId(c.k[1])
      : c.k.length === 3 && isNum(c.k[0]) && typeof c.k[1] === "string" && TIMESTAMP_TEXT.test(c.k[1]) && isId(c.k[2]);
  if (!ok) throw bad();
  return { ...c, s: ranked };
}

// ---------------------------------------------------------------------------
// Exact lookup (#208): the whole query as a photo ID or a filename.

const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|avif|bmp)$/i;
const IMAGE_EXTENSION_SQL = "\\.(jpe?g|png|gif|webp|heic|heif|tiff?|avif|bmp)$";
const PHOTO_ID_QUERY = /^(?:#|id:\s*|photo\s+#?)?(\d{1,10})$/i;
const PHOTO_LINK_QUERY = /\/photos\/(\d{1,10})(?:[/?#].*)?$/;

/** How a query reads as an exact lookup: a photo ID and/or a filename stem. */
export function parseExactQuery(text: string): { photoId: number | null; filenameStem: string | null } {
  const t = text.normalize("NFC").trim();
  const idMatch = PHOTO_ID_QUERY.exec(t) ?? PHOTO_LINK_QUERY.exec(t);
  const id = idMatch ? Number(idMatch[1]) : null;
  const stem = t.replace(IMAGE_EXTENSION, "").trim().toLowerCase();
  return { photoId: id != null && Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null, filenameStem: stem || null };
}

/** LIKE pattern for a literal substring: `%`, `_` and `\` in the query match themselves. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isQueryCanceled(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "57014") return true;
  }
  return false;
}

/** Run retrieval queries in one transaction under a statement timeout. */
async function withStatementTimeout<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return run(tx);
    });
  } catch (err) {
    if (isQueryCanceled(err)) throw new RetrievalError("search_timeout", "The search took too long; try narrowing it.");
    throw err;
  }
}

function emptyPage(exhausted: boolean) {
  return { nextCursor: null, exhausted, limited: false };
}

/** Find photos for one request. See docs/PHOTO_RETRIEVAL.md. */
export async function retrievePhotos(req: RetrievalRequest): Promise<RetrievalResult> {
  if (!Number.isSafeInteger(req.organizationId) || req.organizationId <= 0) {
    throw new RetrievalError("invalid_scope", "Photo retrieval requires an organization scope.");
  }
  const text = req.text.trim();
  const exclude = (req.exclude ?? []).map((t) => t.trim()).filter(Boolean);
  const filters = req.filters ?? {};
  const limit = Math.min(Math.max(Math.trunc(req.limit) || 1, 1), MAX_PAGE_SIZE);
  const conditions = photoFilterConditions(
    { ...filters, includeHidden: req.canSeeHidden, exclude: [] },
    { organizationId: req.organizationId, canSeeHidden: req.canSeeHidden },
  );
  const normalized = {
    v: RETRIEVAL_VERSION,
    mode: req.mode,
    text,
    exclude,
    filters: Object.fromEntries(
      Object.entries(filters)
        .filter(([, v]) => v != null)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    hidden: req.canSeeHidden,
  };
  // Validate the cursor's shape before any query or provider call.
  const cursor = req.cursor ? decodeCursor(req.cursor, req.mode === "combined" ? undefined : req.mode) : null;

  if (!text) {
    return {
      status: "ok",
      items: [],
      page: emptyPage(true),
      total: 0,
      coverage: null,
      degraded: null,
      retrieval: {
        version: RETRIEVAL_VERSION,
        mode: req.mode,
        embeddingModel: req.mode === "keyword" ? null : EMBEDDING_MODEL_TAG,
        ranking: req.mode === "keyword" ? KEYWORD_RANKING : CONCEPT_RANKING,
      },
    };
  }

  const base = { req, text, exclude, conditions, normalized, limit, cursor };
  if (req.mode === "concept") return concept({ ...base, excludeIds: [] });

  // keyword and combined: exact matches first (first page only), and never
  // again in the ranked part on any page.
  const exact = await exactMatches(text, conditions);
  const excludeIds = exact.map((e) => e.photoId);
  let ranked: RetrievalResult;
  if (req.mode === "keyword") {
    ranked = await keyword({ ...base, excludeIds });
  } else if ((cursor?.s ?? "concept") === "concept") {
    ranked = await concept({ ...base, excludeIds });
    if (ranked.status === "unavailable" && !cursor && ranked.degraded) {
      // Keep literal results visible when concept ranking is unavailable.
      const { reason } = ranked.degraded;
      ranked = { ...(await keyword({ ...base, excludeIds })), degraded: { reason, affects: "concept" } };
    }
  } else {
    ranked = await keyword({ ...base, excludeIds });
  }

  const firstPage = !cursor && Math.trunc(req.offset ?? 0) <= 0;
  const exactItems = firstPage ? exact.map((e) => ({ photoId: e.photoId, match: { type: "exact" as const, fields: e.fields } })) : [];
  return {
    ...ranked,
    items: [...exactItems, ...ranked.items],
    total: ranked.total == null ? null : ranked.total + exact.length,
    retrieval: { ...ranked.retrieval, mode: req.mode, ranking: `exact photo ID/filename matches first; then ${ranked.retrieval.ranking}` },
  };
}

interface ModeArgs {
  req: RetrievalRequest;
  text: string;
  exclude: string[];
  conditions: SQL[];
  normalized: Record<string, unknown>;
  limit: number;
  cursor: (CursorBody & { s: RankedMode }) | null;
  /** Photos already returned as exact matches; the ranked part never repeats them. */
  excludeIds: number[];
}

function startPosition(req: RetrievalRequest, cursor: CursorBody | null): number {
  return cursor ? cursor.n : Math.max(0, Math.trunc(req.offset ?? 0));
}

/** Photos whose ID or filename is exactly the query, inside scope and filters. */
async function exactMatches(text: string, conditions: SQL[]): Promise<{ photoId: number; fields: ExactField[] }[]> {
  const { photoId, filenameStem } = parseExactQuery(text);
  if (photoId == null && filenameStem == null) return [];
  const stem = sql`lower(btrim(regexp_replace(normalize(coalesce(${photosTable.filename}, ''), NFC), ${IMAGE_EXTENSION_SQL}, '', 'i')))`;
  const byId = photoId != null ? sql`${photosTable.id} = ${photoId}` : sql`false`;
  const byName = filenameStem != null ? sql`${stem} = ${filenameStem}` : sql`false`;
  const rows = await withStatementTimeout(async (tx) =>
    (
      await tx.execute<{ id: number; by_id: boolean; by_name: boolean }>(sql`
        select ${photosTable.id} as id, ${byId} as by_id, ${byName} as by_name
        from ${photosTable}
        where ${and(...conditions)} and (${byId} or ${byName})
        order by ${photosTable.filename} asc nulls last, ${photosTable.id} asc
        limit ${MAX_EXACT_MATCHES}
      `)
    ).rows,
  );
  return rows.map((r) => ({
    photoId: Number(r.id),
    fields: [...(r.by_id ? (["photo_id"] as const) : []), ...(r.by_name ? (["filename"] as const) : [])],
  }));
}

// ---------------------------------------------------------------------------
// Shared ranking SQL: the results pages and the neighbors lookup run exactly
// these, so a photo's Previous/Next always matches the order on screen.

const CONCEPT_ORDER = "score desc, id asc";
const KEYWORD_ORDER = "tier desc, created_at desc, id desc";

/** The concept query vector, steered away from exclusions — or why it couldn't be built. */
async function conceptVector(
  text: string,
  exclude: string[],
  signal?: AbortSignal,
  organizationId?: number,
): Promise<{ ok: true; vec: number[]; degraded: RetrievalResult["degraded"] } | { ok: false; reason: EmbedFailure }> {
  const pos = await embedCached(text, signal, organizationId);
  if (!pos.ok) return pos;
  if (exclude.length === 0) return { ok: true, vec: pos.vec, degraded: null };
  const neg = await embedCached(exclude.join(", "), signal, organizationId);
  if (!neg.ok) return { ok: true, vec: pos.vec, degraded: { reason: neg.reason, affects: "exclusions" } };
  const p = normalizeVec(pos.vec);
  const n = normalizeVec(neg.vec);
  return { ok: true, vec: p.map((x, i) => x - NEGATIVE_LAMBDA * n[i]), degraded: null };
}

/**
 * One row per ranked photo (id, dist, q, score). The inner query computes each
 * photo's distance once (OFFSET 0 keeps it from being inlined into outer
 * expressions); order by CONCEPT_ORDER.
 */
function conceptRankedSql(vec: number[], where: SQL | undefined): SQL {
  const vecLiteral = `[${vec.join(",")}]`;
  const score = sql`((1 - r.dist) * ${sql.raw(String(1 - W))} + coalesce(r.q, ${sql.raw(String(NEUTRAL_QUALITY_SCORE))}) / 10 * ${sql.raw(String(W))})`;
  return sql`select r.id, r.dist, r.q, ${score} as score from (
    select ${photosTable.id} as id,
           ${photoEmbeddingsTable.embedding} <=> ${vecLiteral}::vector as dist,
           ${photoAiEvaluationsTable.overallScore}::float8 as q
    from ${photoEmbeddingsTable}
    join ${photosTable} on ${photosTable.id} = ${photoEmbeddingsTable.photoId}
    left join ${photoAiEvaluationsTable} on ${photoAiEvaluationsTable.photoId} = ${photoEmbeddingsTable.photoId}
    where ${where}
    offset 0
  ) r`;
}

/** One row per keyword match (id, tier, created_at, created, m_*); order by KEYWORD_ORDER. */
function keywordRankedSql(text: string, exclude: string[], conditions: SQL[], excludeIds: number[]): SQL {
  // A literal substring: `%` and `_` in the query are not wildcards.
  const pattern = containsPattern(text);
  const inAlbum = sql`${albumsTable.title} ilike ${pattern}`;
  const byUploader = sql`${usersTable.name} ilike ${pattern}`;
  const inDescription = sql`coalesce(${photosTable.aiDescription} ilike ${pattern}, false)`;
  const inFilename = sql`coalesce(${photosTable.filename} ilike ${pattern}, false)`;
  // Keyword exclusions are hard: drop photos whose AI description mentions any term.
  const where = and(
    ...conditions,
    sql`(${inAlbum} or ${byUploader} or ${inDescription} or ${inFilename})`,
    ...exclude.map((t) => sql`coalesce(${photosTable.aiDescription}, '') not ilike ${containsPattern(t)}`),
    ...(excludeIds.length ? [notInArray(photosTable.id, excludeIds)] : []),
  );
  return sql`select ${photosTable.id} as id,
         round(coalesce(${photoAiEvaluationsTable.overallScore}::float8, ${sql.raw(String(NEUTRAL_QUALITY_SCORE))})) as tier,
         ${photosTable.createdAt} as created_at,
         ${photosTable.createdAt}::text as created,
         ${inAlbum} as m_album, ${byUploader} as m_uploader, ${inDescription} as m_desc, ${inFilename} as m_file
    from ${photosTable}
    join ${albumsTable} on ${albumsTable.id} = ${photosTable.albumId}
    join ${usersTable} on ${usersTable.id} = ${photosTable.uploaderId}
    left join ${photoAiEvaluationsTable} on ${photoAiEvaluationsTable.photoId} = ${photosTable.id}
    where ${where}`;
}

export interface RetrievalNeighbors {
  /** "unavailable": concept ranking couldn't run (concept mode only). */
  status: "ok" | "unavailable";
  /** Whether the photo is in this search's results at all. */
  inContext: boolean;
  previousId: number | null;
  nextId: number | null;
  /** 1-based position in the results, or null when not in context. */
  position: number | null;
  total: number | null;
}

/**
 * Previous/Next of one photo within a search's results (#210 NAV-03): the
 * same scope, filters, exact matches and ranking as retrievePhotos, so the
 * details page steps through results in the order the search page shows.
 */
export async function retrievalNeighbors(req: Omit<RetrievalRequest, "limit" | "cursor" | "offset">, photoId: number): Promise<RetrievalNeighbors> {
  if (!Number.isSafeInteger(req.organizationId) || req.organizationId <= 0) {
    throw new RetrievalError("invalid_scope", "Photo retrieval requires an organization scope.");
  }
  const outside = (total: number | null, status: RetrievalNeighbors["status"] = "ok"): RetrievalNeighbors => ({
    status,
    inContext: false,
    previousId: null,
    nextId: null,
    position: null,
    total,
  });
  const text = req.text.trim();
  if (!text) return outside(0);
  const exclude = (req.exclude ?? []).map((t) => t.trim()).filter(Boolean);
  const conditions = photoFilterConditions(
    { ...(req.filters ?? {}), includeHidden: req.canSeeHidden, exclude: [] },
    { organizationId: req.organizationId, canSeeHidden: req.canSeeHidden },
  );

  const exact = req.mode === "concept" ? [] : (await exactMatches(text, conditions)).map((e) => e.photoId);
  let ranked: SQL;
  let order: string;
  const concept = req.mode === "keyword" ? null : await conceptVector(text, exclude, req.signal, req.organizationId);
  if (concept?.ok) {
    ranked = conceptRankedSql(concept.vec, and(...conditions, ...(exact.length ? [notInArray(photosTable.id, exact)] : [])));
    order = CONCEPT_ORDER;
  } else if (req.mode === "concept") {
    return outside(null, "unavailable");
  } else {
    // keyword mode, or combined falling back to literal matches like retrievePhotos.
    ranked = keywordRankedSql(text, exclude, conditions, exact);
    order = KEYWORD_ORDER;
  }

  const rows = await withStatementTimeout(async (tx) =>
    (
      await tx.execute<{ id: number; rn: number; prev_id: number | null; next_id: number | null; total: number }>(sql`
        select id, rn, prev_id, next_id, total from (
          select id,
                 row_number() over w as rn,
                 lag(id) over w as prev_id,
                 lead(id) over w as next_id,
                 count(*) over () as total
          from (${ranked}) x
          window w as (order by ${sql.raw(order)})
        ) y
        where id = ${photoId} or rn = 1
      `)
    ).rows,
  );
  const current = rows.find((r) => Number(r.id) === photoId);
  const first = rows.find((r) => Number(r.rn) === 1);
  const rankedTotal = first ? Number(first.total) : 0;
  const total = exact.length + rankedTotal;
  const i = exact.indexOf(photoId);
  if (i >= 0) {
    return {
      status: "ok",
      inContext: true,
      previousId: i > 0 ? exact[i - 1] : null,
      nextId: i < exact.length - 1 ? exact[i + 1] : first ? Number(first.id) : null,
      position: i + 1,
      total,
    };
  }
  if (!current) return outside(total);
  return {
    status: "ok",
    inContext: true,
    previousId: current.prev_id != null ? Number(current.prev_id) : exact.length ? exact[exact.length - 1] : null,
    nextId: current.next_id != null ? Number(current.next_id) : null,
    position: exact.length + Number(current.rn),
    total,
  };
}

async function concept({ req, text, exclude, conditions, normalized, limit, cursor, excludeIds }: ModeArgs): Promise<RetrievalResult> {
  const retrieval = { version: RETRIEVAL_VERSION, mode: "concept" as RetrievalMode, embeddingModel: EMBEDDING_MODEL_TAG, ranking: CONCEPT_RANKING };

  const qv = await conceptVector(text, exclude, req.signal, req.organizationId);
  if (!qv.ok) {
    return { status: "unavailable", items: [], page: emptyPage(false), total: null, coverage: null, degraded: { reason: qv.reason, affects: "query" }, retrieval };
  }
  const { vec, degraded } = qv;

  const h = hashOf({ ...normalized, s: "concept", model: EMBEDDING_MODEL_TAG, vec: hashOf(vec) });
  if (cursor && cursor.h !== h) {
    throw new RetrievalError("cursor_mismatch", "The search changed since this page; restart from the first page.");
  }
  const n = startPosition(req, cursor);
  const take = Math.min(limit, MAX_CONCEPT_DEPTH - n);
  const where = and(...conditions, ...(excludeIds.length ? [notInArray(photosTable.id, excludeIds)] : []));

  const { rows, total, notEmbedded } = await withStatementTimeout(async (tx) => {
    const counts = await tx.execute<{ ranked: number; not_embedded: number }>(sql`
      select
        (select count(*)::int from ${photoEmbeddingsTable} join ${photosTable} on ${photosTable.id} = ${photoEmbeddingsTable.photoId} where ${where}) as ranked,
        (select count(*)::int from ${photosTable} where ${where} and not exists (select 1 from ${photoEmbeddingsTable} where ${photoEmbeddingsTable.photoId} = ${photosTable.id})) as not_embedded
    `);
    if (take <= 0) return { rows: [], total: counts.rows[0].ranked, notEmbedded: counts.rows[0].not_embedded };
    const result = await tx.execute<{ id: number; dist: number; q: number | null; score: number }>(sql`
      select s.id, s.dist, s.q, s.score from (${conceptRankedSql(vec, where)}) s
      ${cursor ? sql`where s.score < ${cursor.k[0]}::float8 or (s.score = ${cursor.k[0]}::float8 and s.id > ${cursor.k[1]})` : sql``}
      order by ${sql.raw(CONCEPT_ORDER.replace(/(\w+) (asc|desc)/g, "s.$1 $2"))}
      limit ${take + 1}
      ${cursor ? sql`` : sql`offset ${n}`}
    `);
    return { rows: result.rows, total: counts.rows[0].ranked, notEmbedded: counts.rows[0].not_embedded };
  });

  const items = rows.slice(0, Math.max(take, 0));
  const hasMore = rows.length > items.length || (take <= 0 && total > n);
  const limited = hasMore && n + items.length >= MAX_CONCEPT_DEPTH;
  const last = items[items.length - 1];
  return {
    status: "ok",
    items: items.map((r) => ({
      photoId: Number(r.id),
      match: { type: "concept", similarity: 1 - Number(r.dist), qualityScore: r.q == null ? null : Number(r.q), score: Number(r.score) },
    })),
    page: {
      nextCursor: hasMore && !limited && last ? encodeCursor({ v: 1, h, n: n + items.length, k: [Number(last.score), Number(last.id)], s: "concept" }) : null,
      exhausted: !hasMore,
      limited,
    },
    total,
    coverage: { notEmbedded },
    degraded,
    retrieval,
  };
}

async function keyword({ req, text, exclude, conditions, normalized, limit, cursor, excludeIds }: ModeArgs): Promise<RetrievalResult> {
  const retrieval = { version: RETRIEVAL_VERSION, mode: "keyword" as RetrievalMode, embeddingModel: null, ranking: KEYWORD_RANKING };
  const h = hashOf({ ...normalized, s: "keyword" });
  if (cursor && cursor.h !== h) {
    throw new RetrievalError("cursor_mismatch", "The search changed since this page; restart from the first page.");
  }
  const n = startPosition(req, cursor);
  const ranked = keywordRankedSql(text, exclude, conditions, excludeIds);

  const { rows, total } = await withStatementTimeout(async (tx) => {
    const counts = await tx.execute<{ total: number }>(sql`select count(*)::int as total from (${ranked}) c`);
    const result = await tx.execute<{ id: number; tier: number; created_at: string; created: string; m_album: boolean; m_uploader: boolean; m_desc: boolean; m_file: boolean }>(sql`
      select s.* from (${ranked}) s
      ${
        cursor
          ? sql`where s.tier < ${cursor.k[0]}::float8
              or (s.tier = ${cursor.k[0]}::float8 and s.created_at < ${cursor.k[1]}::timestamptz)
              or (s.tier = ${cursor.k[0]}::float8 and s.created_at = ${cursor.k[1]}::timestamptz and s.id < ${cursor.k[2]})`
          : sql``
      }
      order by ${sql.raw(KEYWORD_ORDER.replace(/(\w+) (asc|desc)/g, "s.$1 $2"))}
      limit ${limit + 1}
      ${cursor ? sql`` : sql`offset ${n}`}
    `);
    return { rows: result.rows, total: counts.rows[0].total };
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items[items.length - 1];
  return {
    status: "ok",
    items: items.map((r) => ({
      photoId: Number(r.id),
      match: {
        type: "keyword",
        fields: [
          ...(r.m_album ? (["album_title"] as const) : []),
          ...(r.m_uploader ? (["uploader"] as const) : []),
          ...(r.m_desc ? (["description"] as const) : []),
          ...(r.m_file ? (["filename"] as const) : []),
        ],
      },
    })),
    page: {
      nextCursor: hasMore && last ? encodeCursor({ v: 1, h, n: n + items.length, k: [Number(last.tier), last.created, Number(last.id)], s: "keyword" }) : null,
      exhausted: !hasMore,
      limited: false,
    },
    total,
    coverage: null,
    degraded: null,
    retrieval,
  };
}
