import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";

// The Photo Graph (#202): the threads around one photo, for discovery. Every
// thread comes from data we already store (embeddings, near-duplicate pairs,
// person collections, albums, rights tags) — no provider calls. Every photo in
// the result, thread targets included, is in the caller's organization and
// passes the caller's hidden-photo visibility.

export const GRAPH_THREAD_KINDS = ["similar", "duplicate", "person", "event", "rights"] as const;
export type GraphThreadKind = (typeof GRAPH_THREAD_KINDS)[number];
export const DEFAULT_GRAPH_THREADS: GraphThreadKind[] = ["similar", "duplicate", "person", "event"];

/** Depth 2 expands this many of the strongest first-ring photos, with fewer neighbours each. */
const SECOND_RING_EXPANSIONS = 8;
const SECOND_RING_PER_THREAD = 3;

export interface PhotoGraphOptions {
  organizationId: number;
  canSeeHidden: boolean;
  threads: GraphThreadKind[];
  perThread: number;
  depth: 1 | 2;
  limit: number;
}

export interface PhotoGraphNode {
  id: number;
  ring: number;
  filename: string | null;
  thumbnailUrl: string | null;
  albumId: number;
  albumTitle: string | null;
  takenAt: string | null;
  embedded: boolean;
}

export interface PhotoGraphEdge {
  source: number;
  target: number;
  kind: GraphThreadKind;
  weight: number;
  label: string;
}

export interface PhotoGraph {
  seedId: number;
  depth: 1 | 2;
  threads: GraphThreadKind[];
  nodes: PhotoGraphNode[];
  edges: PhotoGraphEdge[];
  truncated: boolean;
  unavailable: { photoId: number; kind: GraphThreadKind; reason: "not_embedded" }[];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Neighbour = { id: number; weight: number; label: string };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The visibility predicate for a photo row aliased `p`. */
function visible(opts: PhotoGraphOptions): SQL {
  return opts.canSeeHidden
    ? sql`p.organization_id = ${opts.organizationId}`
    : sql`p.organization_id = ${opts.organizationId} and p.is_hidden = false`;
}

/** Seconds between a photo's capture (or upload) time and the centre photo's. */
const timeGap = (seed: number) =>
  sql`abs(extract(epoch from coalesce(p.taken_at, p.created_at) - (select coalesce(s.taken_at, s.created_at) from photos s where s.id = ${seed})))`;

async function similar(tx: Tx, seed: number, k: number, opts: PhotoGraphOptions): Promise<Neighbour[] | null> {
  const self = await tx.execute<{ embedding: string }>(
    sql`select pe.embedding::text as embedding from photo_embeddings pe join photos p on p.id = pe.photo_id where pe.photo_id = ${seed} and p.organization_id = ${opts.organizationId}`,
  );
  const vec = self.rows[0]?.embedding;
  if (!vec) return null;
  const rows = await tx.execute<{ id: number; distance: number }>(sql`
    select pe.photo_id as id, (pe.embedding <=> ${vec}::vector) as distance
    from photo_embeddings pe join photos p on p.id = pe.photo_id
    where pe.photo_id <> ${seed} and ${visible(opts)}
    order by pe.embedding <=> ${vec}::vector
    limit ${k}`);
  return rows.rows.map((r) => ({ id: Number(r.id), weight: clamp01(1 - Number(r.distance)), label: "Looks similar" }));
}

async function duplicate(tx: Tx, seed: number, k: number, opts: PhotoGraphOptions): Promise<Neighbour[]> {
  const rows = await tx.execute<{ id: number; distance: number }>(sql`
    select p.id, d.distance
    from near_duplicate_pairs d
    join photos p on p.id = case when d.photo_a = ${seed} then d.photo_b else d.photo_a end
    where (d.photo_a = ${seed} or d.photo_b = ${seed}) and d.organization_id = ${opts.organizationId} and ${visible(opts)}
    order by d.distance, p.id
    limit ${k}`);
  return rows.rows.map((r) => ({ id: Number(r.id), weight: clamp01(1 - Number(r.distance) / 11), label: "Near duplicate" }));
}

async function person(tx: Tx, seed: number, k: number, opts: PhotoGraphOptions): Promise<Neighbour[]> {
  const rows = await tx.execute<{ id: number; label: string }>(sql`
    select x.id, c.title as label
    from photo_collections pc
    join collections c on c.id = pc.collection_id and c.kind = 'person' and c.organization_id = ${opts.organizationId}
    cross join lateral (
      select p.id, ${timeGap(seed)} as gap
      from photo_collections pc2 join photos p on p.id = pc2.photo_id
      where pc2.collection_id = c.id and p.id <> ${seed} and ${visible(opts)}
      order by gap nulls last, p.id
      limit ${k}
    ) x
    where pc.photo_id = ${seed}
    order by x.gap nulls last, x.id
    limit ${k}`);
  return rows.rows.map((r) => ({ id: Number(r.id), weight: 0.8, label: r.label }));
}

async function event(tx: Tx, seed: number, k: number, opts: PhotoGraphOptions): Promise<Neighbour[]> {
  const rows = await tx.execute<{ id: number; label: string }>(sql`
    select p.id, a.title as label
    from photos p join albums a on a.id = p.album_id
    where p.album_id = (select s.album_id from photos s where s.id = ${seed}) and p.id <> ${seed} and ${visible(opts)}
    order by ${timeGap(seed)} nulls last, p.id
    limit ${k}`);
  return rows.rows.map((r) => ({ id: Number(r.id), weight: 0.6, label: r.label }));
}

async function rights(tx: Tx, seed: number, k: number, opts: PhotoGraphOptions): Promise<Neighbour[]> {
  const rows = await tx.execute<{ id: number; label: string }>(sql`
    select x.id, t.name as label
    from photo_attribution_tags pat
    join attribution_tags t on t.id = pat.tag_id and t.organization_id = ${opts.organizationId}
    cross join lateral (
      select p.id, ${timeGap(seed)} as gap
      from photo_attribution_tags pat2 join photos p on p.id = pat2.photo_id
      where pat2.tag_id = t.id and p.id <> ${seed} and ${visible(opts)}
      order by gap nulls last, p.id
      limit ${k}
    ) x
    where pat.photo_id = ${seed}
    order by x.gap nulls last, x.id
    limit ${k}`);
  return rows.rows.map((r) => ({ id: Number(r.id), weight: 0.4, label: r.label }));
}

/**
 * The graph around `seedId`, or null when that photo isn't visible to the
 * caller (another org's, or hidden from a member) — callers answer 404.
 */
export async function buildPhotoGraph(seedId: number, opts: PhotoGraphOptions): Promise<PhotoGraph | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);

    const seed = await tx.execute<{ id: number }>(sql`select p.id from photos p where p.id = ${seedId} and ${visible(opts)}`);
    if (seed.rows.length === 0) return null;

    const ring = new Map<number, number>([[seedId, 0]]);
    const edges = new Map<string, PhotoGraphEdge>();
    const unavailable: PhotoGraph["unavailable"] = [];
    let truncated = false;

    const expand = async (from: number, k: number, nextRing: number) => {
      for (const kind of opts.threads) {
        const found =
          kind === "similar" ? await similar(tx, from, k, opts)
          : kind === "duplicate" ? await duplicate(tx, from, k, opts)
          : kind === "person" ? await person(tx, from, k, opts)
          : kind === "event" ? await event(tx, from, k, opts)
          : await rights(tx, from, k, opts);
        if (found === null) {
          unavailable.push({ photoId: from, kind, reason: "not_embedded" });
          continue;
        }
        for (const n of found) {
          if (!ring.has(n.id)) {
            if (ring.size >= opts.limit) {
              truncated = true;
              continue;
            }
            ring.set(n.id, nextRing);
          }
          const [a, b] = from < n.id ? [from, n.id] : [n.id, from];
          const key = `${a}:${b}:${kind}`;
          const prev = edges.get(key);
          if (!prev || prev.weight < n.weight) edges.set(key, { source: from, target: n.id, kind, weight: round(n.weight), label: n.label });
        }
      }
    };

    await expand(seedId, opts.perThread, 1);
    if (opts.depth === 2) {
      // Expand the strongest first-ring photos (by their best thread to the centre).
      const best = new Map<number, number>();
      for (const e of edges.values()) {
        const other = e.source === seedId ? e.target : e.source;
        best.set(other, Math.max(best.get(other) ?? 0, e.weight));
      }
      const firstRing = [...best.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, SECOND_RING_EXPANSIONS).map(([id]) => id);
      for (const id of firstRing) await expand(id, Math.min(opts.perThread, SECOND_RING_PER_THREAD), 2);
    }

    const ids = [...ring.keys()];
    const meta = await tx.execute<{
      id: number; filename: string | null; url: string | null; thumbnail_key: string | null;
      album_id: number; album_title: string | null; taken_at: Date | string | null; embedded: boolean;
    }>(sql`
      select p.id, p.filename, p.url, p.thumbnail_key, p.album_id, a.title as album_title, p.taken_at,
             exists (select 1 from photo_embeddings pe where pe.photo_id = p.id) as embedded
      from photos p left join albums a on a.id = p.album_id
      where p.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and ${visible(opts)}`);
    const byId = new Map(meta.rows.map((r) => [Number(r.id), r]));

    const nodes: PhotoGraphNode[] = ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const r = byId.get(id)!;
        return {
          id,
          ring: ring.get(id)!,
          filename: r.filename,
          thumbnailUrl: r.thumbnail_key ? `/api/storage${r.thumbnail_key}` : r.url,
          albumId: Number(r.album_id),
          albumTitle: r.album_title,
          takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
          embedded: !!r.embedded,
        };
      });
    const present = new Set(nodes.map((n) => n.id));

    return {
      seedId,
      depth: opts.depth,
      threads: opts.threads,
      nodes,
      edges: [...edges.values()].filter((e) => present.has(e.source) && present.has(e.target)),
      truncated,
      unavailable,
    };
  });
}
