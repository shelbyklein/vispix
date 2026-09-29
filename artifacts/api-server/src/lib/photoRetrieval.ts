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
import { and, sql, type SQL } from "drizzle-orm";
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

export type RetrievalMode = "keyword" | "concept";
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

export type KeywordField = "album_title" | "uploader" | "description";
export type RetrievalMatch =
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
  /** Provider trouble: nothing ranked ("query"), or exclusions not applied ("exclusions"). */
  degraded: { reason: EmbedFailure; affects: "query" | "exclusions" } | null;
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
): Promise<{ ok: true; vec: number[] } | { ok: false; reason: EmbedFailure }> {
  const key = `${EMBEDDING_MODEL_TAG}\u0000${text}`;
  const now = Date.now();
  const hit = embedCache.get(key);
  if (hit && now - hit.at < EMBED_CACHE_TTL_MS) {
    embedCache.delete(key);
    embedCache.set(key, hit);
    return { ok: true, vec: hit.vec };
  }
  const r = await embedQuery(text, { signal });
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
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function encodeCursor(c: CursorBody): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

function decodeCursor(raw: string, mode: RetrievalMode): CursorBody {
  const bad = () => new RetrievalError("invalid_cursor", "The continuation cursor is malformed; restart the search.");
  let c: CursorBody;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorBody;
  } catch {
    throw bad();
  }
  if (!c || c.v !== 1 || typeof c.h !== "string" || !Number.isSafeInteger(c.n) || c.n < 0 || !Array.isArray(c.k)) throw bad();
  const isId = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;
  const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const ok =
    mode === "concept"
      ? c.k.length === 2 && isNum(c.k[0]) && isId(c.k[1])
      : c.k.length === 3 && isNum(c.k[0]) && typeof c.k[1] === "string" && TIMESTAMP_TEXT.test(c.k[1]) && isId(c.k[2]);
  if (!ok) throw bad();
  return c;
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
  const args = { req, text, exclude, conditions, normalized, limit };

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
        embeddingModel: req.mode === "concept" ? EMBEDDING_MODEL_TAG : null,
        ranking: req.mode === "concept" ? CONCEPT_RANKING : KEYWORD_RANKING,
      },
    };
  }
  return req.mode === "concept" ? concept(args) : keyword(args);
}

interface ModeArgs {
  req: RetrievalRequest;
  text: string;
  exclude: string[];
  conditions: SQL[];
  normalized: Record<string, unknown>;
  limit: number;
}

function startPosition(req: RetrievalRequest, cursor: CursorBody | null): number {
  return cursor ? cursor.n : Math.max(0, Math.trunc(req.offset ?? 0));
}

async function concept({ req, text, exclude, conditions, normalized, limit }: ModeArgs): Promise<RetrievalResult> {
  const retrieval = { version: RETRIEVAL_VERSION, mode: "concept" as const, embeddingModel: EMBEDDING_MODEL_TAG, ranking: CONCEPT_RANKING };
  // Validate the cursor's shape before spending a provider call.
  const cursor = req.cursor ? decodeCursor(req.cursor, "concept") : null;

  const pos = await embedCached(text, req.signal);
  if (!pos.ok) {
    return { status: "unavailable", items: [], page: emptyPage(false), total: null, coverage: null, degraded: { reason: pos.reason, affects: "query" }, retrieval };
  }
  let vec = pos.vec;
  let degraded: RetrievalResult["degraded"] = null;
  if (exclude.length > 0) {
    const neg = await embedCached(exclude.join(", "), req.signal);
    if (neg.ok) {
      const p = normalizeVec(pos.vec);
      const n = normalizeVec(neg.vec);
      vec = p.map((x, i) => x - NEGATIVE_LAMBDA * n[i]);
    } else {
      degraded = { reason: neg.reason, affects: "exclusions" };
    }
  }

  const h = hashOf({ ...normalized, model: EMBEDDING_MODEL_TAG, vec: hashOf(vec) });
  if (cursor && cursor.h !== h) {
    throw new RetrievalError("cursor_mismatch", "The search changed since this page; restart from the first page.");
  }
  const n = startPosition(req, cursor);
  const take = Math.min(limit, MAX_CONCEPT_DEPTH - n);
  const where = and(...conditions);
  const vecLiteral = `[${vec.join(",")}]`;
  const score = sql`((1 - r.dist) * ${sql.raw(String(1 - W))} + coalesce(r.q, ${sql.raw(String(NEUTRAL_QUALITY_SCORE))}) / 10 * ${sql.raw(String(W))})`;

  const { rows, total, notEmbedded } = await withStatementTimeout(async (tx) => {
    const counts = await tx.execute<{ ranked: number; not_embedded: number }>(sql`
      select
        (select count(*)::int from ${photoEmbeddingsTable} join ${photosTable} on ${photosTable.id} = ${photoEmbeddingsTable.photoId} where ${where}) as ranked,
        (select count(*)::int from ${photosTable} where ${where} and not exists (select 1 from ${photoEmbeddingsTable} where ${photoEmbeddingsTable.photoId} = ${photosTable.id})) as not_embedded
    `);
    if (take <= 0) return { rows: [], total: counts.rows[0].ranked, notEmbedded: counts.rows[0].not_embedded };
    // The inner query computes each photo's distance once (OFFSET 0 keeps it
    // from being inlined into the outer expressions); the outer query ranks.
    const result = await tx.execute<{ id: number; dist: number; q: number | null; score: number }>(sql`
      select s.id, s.dist, s.q, s.score from (
        select r.id, r.dist, r.q, ${score} as score from (
          select ${photosTable.id} as id,
                 ${photoEmbeddingsTable.embedding} <=> ${vecLiteral}::vector as dist,
                 ${photoAiEvaluationsTable.overallScore}::float8 as q
          from ${photoEmbeddingsTable}
          join ${photosTable} on ${photosTable.id} = ${photoEmbeddingsTable.photoId}
          left join ${photoAiEvaluationsTable} on ${photoAiEvaluationsTable.photoId} = ${photoEmbeddingsTable.photoId}
          where ${where}
          offset 0
        ) r
      ) s
      ${cursor ? sql`where s.score < ${cursor.k[0]}::float8 or (s.score = ${cursor.k[0]}::float8 and s.id > ${cursor.k[1]})` : sql``}
      order by s.score desc, s.id asc
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
      nextCursor: hasMore && !limited && last ? encodeCursor({ v: 1, h, n: n + items.length, k: [Number(last.score), Number(last.id)] }) : null,
      exhausted: !hasMore,
      limited,
    },
    total,
    coverage: { notEmbedded },
    degraded,
    retrieval,
  };
}

async function keyword({ req, text, exclude, conditions, normalized, limit }: ModeArgs): Promise<RetrievalResult> {
  const retrieval = { version: RETRIEVAL_VERSION, mode: "keyword" as const, embeddingModel: null, ranking: KEYWORD_RANKING };
  const cursor = req.cursor ? decodeCursor(req.cursor, "keyword") : null;
  const h = hashOf(normalized);
  if (cursor && cursor.h !== h) {
    throw new RetrievalError("cursor_mismatch", "The search changed since this page; restart from the first page.");
  }
  const n = startPosition(req, cursor);
  const pattern = `%${text}%`;
  const inAlbum = sql`${albumsTable.title} ilike ${pattern}`;
  const byUploader = sql`${usersTable.name} ilike ${pattern}`;
  const inDescription = sql`coalesce(${photosTable.aiDescription} ilike ${pattern}, false)`;
  // Keyword exclusions are hard: drop photos whose AI description mentions any term.
  const where = and(
    ...conditions,
    sql`(${inAlbum} or ${byUploader} or ${inDescription})`,
    ...exclude.map((t) => sql`coalesce(${photosTable.aiDescription}, '') not ilike ${`%${t}%`}`),
  );
  const from = sql`${photosTable}
    join ${albumsTable} on ${albumsTable.id} = ${photosTable.albumId}
    join ${usersTable} on ${usersTable.id} = ${photosTable.uploaderId}
    left join ${photoAiEvaluationsTable} on ${photoAiEvaluationsTable.photoId} = ${photosTable.id}`;

  const { rows, total } = await withStatementTimeout(async (tx) => {
    const counts = await tx.execute<{ total: number }>(sql`select count(*)::int as total from ${from} where ${where}`);
    const result = await tx.execute<{ id: number; tier: number; created_at: string; created: string; m_album: boolean; m_uploader: boolean; m_desc: boolean }>(sql`
      select s.* from (
        select ${photosTable.id} as id,
               round(coalesce(${photoAiEvaluationsTable.overallScore}::float8, ${sql.raw(String(NEUTRAL_QUALITY_SCORE))})) as tier,
               ${photosTable.createdAt} as created_at,
               ${photosTable.createdAt}::text as created,
               ${inAlbum} as m_album, ${byUploader} as m_uploader, ${inDescription} as m_desc
        from ${from}
        where ${where}
      ) s
      ${
        cursor
          ? sql`where s.tier < ${cursor.k[0]}::float8
              or (s.tier = ${cursor.k[0]}::float8 and s.created_at < ${cursor.k[1]}::timestamptz)
              or (s.tier = ${cursor.k[0]}::float8 and s.created_at = ${cursor.k[1]}::timestamptz and s.id < ${cursor.k[2]})`
          : sql``
      }
      order by s.tier desc, s.created_at desc, s.id desc
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
        ],
      },
    })),
    page: {
      nextCursor: hasMore && last ? encodeCursor({ v: 1, h, n: n + items.length, k: [Number(last.tier), last.created, Number(last.id)] }) : null,
      exhausted: !hasMore,
      limited: false,
    },
    total,
    coverage: null,
    degraded: null,
    retrieval,
  };
}
