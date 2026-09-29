import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// The shared photo retrieval service (#213, docs/PHOTO_RETRIEVAL.md) against a
// real Postgres + pgvector library. The query embedding is stubbed: every
// query points along axis 0, so a photo's similarity is exactly the value the
// fixture gives it, and "crowd" exclusions point along axis 2.
const DIM = 1408;
function unit(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}
const embedQuery = vi.fn(async (q: string) => {
  if (q.includes("__timeout__")) return { ok: false as const, reason: "timeout" as const };
  return { ok: true as const, vec: /crowd/.test(q) ? unit({ 2: 1 }) : unit({ 0: 1 }) };
});
vi.mock("../aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiEmbedding")>()),
  embedQuery: (q: string) => embedQuery(q),
}));

import { db, pool, photosTable, photoEmbeddingsTable, photoAiEvaluationsTable, attributionTagsTable, photoAttributionTagsTable, collectionsTable, photoCollectionsTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, createAlbum, createPhoto } from "./testDb";
import {
  retrievePhotos,
  clearQueryEmbeddingCache,
  RetrievalError,
  MAX_CONCEPT_DEPTH,
  CONCEPT_QUALITY_WEIGHT,
  NEUTRAL_QUALITY_SCORE,
  type RetrievalRequest,
} from "../photoRetrieval";

interface Spec {
  s: number;
  desc?: string | null;
  hidden?: boolean;
  quality?: number;
  createdAt?: Date;
}
interface Fixture extends Spec {
  id: number;
}

async function addLibrary(orgId: number, albumId: number, uploaderId: number, specs: Spec[]): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (let i = 0; i < specs.length; i += 200) {
    const chunk = specs.slice(i, i + 200);
    const rows = await db
      .insert(photosTable)
      .values(
        chunk.map((p, j) => ({
          albumId,
          uploaderId,
          organizationId: orgId,
          url: `/api/storage/objects/fixture/${orgId}/${i + j}`,
          aiDescription: p.desc ?? null,
          isHidden: p.hidden ?? false,
          ...(p.createdAt ? { createdAt: p.createdAt } : {}),
        })),
      )
      .returning({ id: photosTable.id });
    await db.insert(photoEmbeddingsTable).values(
      rows.map((r, j) => ({ photoId: r.id, organizationId: orgId, embedding: unit({ 0: chunk[j].s, 1: Math.sqrt(1 - chunk[j].s ** 2) }), model: "test" })),
    );
    const evals = rows.flatMap((r, j) => {
      const q = chunk[j].quality;
      if (q == null) return [];
      const r5 = Math.round(q);
      return [{ photoId: r.id, organizationId: orgId, technicalQuality: r5, composition: r5, subjectClarity: r5, emotionalImpact: r5, marketingUsability: r5, overallScore: q }];
    });
    if (evals.length) await db.insert(photoAiEvaluationsTable).values(evals);
    rows.forEach((r, j) => out.push({ ...chunk[j], id: r.id }));
  }
  return out;
}

/** The contract's ranking, computed independently in JS. */
function expectedConceptOrder(photos: Fixture[]): number[] {
  const W = CONCEPT_QUALITY_WEIGHT;
  return [...photos]
    .map((p) => ({ id: p.id, score: p.s * (1 - W) + ((p.quality ?? NEUTRAL_QUALITY_SCORE) / 10) * W }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map((p) => p.id);
}

let orgA: number;
let orgB: number;
let library: Fixture[] = [];
let deepQualified: Fixture[] = [];
let hiddenTop: Fixture;
let foreignTop: number;
let unembedded: number;
let rightsTagId: number;
let foreignRightsTagId: number;
let personId: number;
let keywordPhotos: Fixture[] = [];

const base = (over: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  organizationId: orgA,
  canSeeHidden: false,
  mode: "concept",
  text: "archer at full draw",
  limit: 20,
  ...over,
});

/** Org A's embedded, non-hidden photos: what concept search ranks for a member. */
const allVisibleEmbedded = () => [...library, ...keywordPhotos];

async function pageThrough(req: RetrievalRequest): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const r = await retrievePhotos({ ...req, cursor });
    ids.push(...r.items.map((i) => i.photoId));
    if (!r.page.nextCursor) break;
    cursor = r.page.nextCursor;
  }
  return ids;
}

beforeAll(async () => {
  await resetDb();
  const user = await createUser({ name: "Robin Fletcher" });
  orgA = (await createOrganization({ name: "Org A" })).id;
  orgB = (await createOrganization({ name: "Org B" })).id;
  const album = await createAlbum(user.id, "Nationals 2026", orgA);

  // 1,010 embedded photos, similarities 0.99 down in 0.0009 steps. Three deep
  // ones (well past the MCP's old 30-photo over-fetch and 500 cap) have a
  // 9.5 AI score; everything else is unevaluated.
  const specs: Spec[] = Array.from({ length: 1010 }, (_, i) => ({ s: 0.99 - i * 0.0009 }));
  for (const i of [540, 780, 1005]) specs[i].quality = 9.5;
  library = await addLibrary(orgA, album.id, user.id, specs);
  deepQualified = [540, 780, 1005].map((i) => library[i]);

  // A hidden photo that would rank first, and another org's perfect match.
  [hiddenTop] = await addLibrary(orgA, album.id, user.id, [{ s: 0.999, hidden: true }]);
  const userB = await createUser();
  const albumB = await createAlbum(userB.id, "B album", orgB);
  foreignTop = (await addLibrary(orgB, albumB.id, userB.id, [{ s: 1 }]))[0].id;
  // A qualifying photo with no embedding.
  unembedded = (await createPhoto(album.id, user.id, { organizationId: orgA })).id;

  // Usage rights and a person, each on two deep photos; plus org B's own tag.
  const [tag] = await db.insert(attributionTagsTable).values({ organizationId: orgA, name: "Sponsor OK" }).returning();
  rightsTagId = tag.id;
  await db.insert(photoAttributionTagsTable).values([library[700], library[900]].map((p) => ({ photoId: p.id, tagId: tag.id })));
  const [tagB] = await db.insert(attributionTagsTable).values({ organizationId: orgB, name: "Sponsor OK (org B)" }).returning();
  foreignRightsTagId = tagB.id;
  const [person] = await db.insert(collectionsTable).values({ organizationId: orgA, createdById: user.id, title: "Jane Archer", kind: "person" }).returning();
  personId = person.id;
  await db.insert(photoCollectionsTable).values([library[650], library[950]].map((p) => ({ photoId: p.id, collectionId: person.id })));

  // Keyword fixtures in a second album: descriptions, equal timestamps (the
  // id tiebreak), and quality tiers.
  const album2 = await createAlbum(user.id, "Practice range", orgA);
  const t = new Date("2026-05-01T12:00:00.123456Z");
  keywordPhotos = await addLibrary(orgA, album2.id, user.id, [
    { s: 0.2, desc: "An archer releases an arrow", createdAt: t },
    { s: 0.2, desc: "Archer at full draw", createdAt: t, quality: 8.6 },
    { s: 0.2, desc: "Coach with an archer", createdAt: t },
    { s: 0.2, desc: "Archer in a crowd", createdAt: t },
    { s: 0.2, desc: "Archery target close-up", createdAt: new Date("2026-05-02T00:00:00Z") },
    { s: 0.2, desc: "Empty range", createdAt: t },
  ]);
}, 120_000);

beforeEach(() => {
  clearQueryEmbeddingCache();
  embedQuery.mockClear();
});

afterAll(async () => {
  await pool.end();
});

describe("scope (TT-VPX-RETRIEVAL-02)", () => {
  it.each([0, -1, Number.NaN, 1.5, undefined as unknown as number])("rejects organizationId %s", async (organizationId) => {
    await expect(retrievePhotos(base({ organizationId }))).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("never returns another org's photos or hidden photos to a non-admin", async () => {
    const ids = await pageThrough(base({ limit: 200 }));
    expect(ids).not.toContain(foreignTop);
    expect(ids).not.toContain(hiddenTop.id);
    expect(ids).toHaveLength(MAX_CONCEPT_DEPTH);
  });

  it("includes hidden photos only when allowed", async () => {
    const r = await retrievePhotos(base({ canSeeHidden: true, limit: 1 }));
    expect(r.items[0].photoId).toBe(hiddenTop.id);
  });

  it("ignores another org's rights tag id", async () => {
    const r = await retrievePhotos(base({ filters: { rightsTagId: foreignRightsTagId } }));
    expect(r.items).toEqual([]);
    expect(r.page.exhausted).toBe(true);
  });
});

describe("filters apply before limits (TT-VPX-RETRIEVAL-02)", () => {
  it("reaches qualifying photos far beyond the old over-fetch window", async () => {
    // The MCP used to fetch count*10 (here 30) nearest photos and filter
    // afterwards: none of these three were ever reachable.
    const r = await retrievePhotos(base({ limit: 3, filters: { minQuality: 9 } }));
    expect(r.items.map((i) => i.photoId)).toEqual(expectedConceptOrder(deepQualified));
    expect(r.page).toEqual({ nextCursor: null, exhausted: true, limited: false });
    expect(r.total).toBe(3);
  });

  it("enforces rights and person filters in the query", async () => {
    const rights = await retrievePhotos(base({ filters: { rightsTagId } }));
    expect(rights.items.map((i) => i.photoId)).toEqual([library[700].id, library[900].id]);
    const person = await retrievePhotos(base({ filters: { personId } }));
    expect(person.items.map((i) => i.photoId)).toEqual([library[650].id, library[950].id]);
    const both = await retrievePhotos(base({ filters: { rightsTagId, personId } }));
    expect(both.items).toEqual([]);
  });

  it("combines a rating floor with deep results", async () => {
    // Nothing is rated, so a rating floor above 0 leaves nothing — exhausted, not "limited".
    const r = await retrievePhotos(base({ filters: { ratingMin: 1 } }));
    expect(r.items).toEqual([]);
    expect(r.page.exhausted).toBe(true);
  });
});

describe("concept ranking and continuation", () => {
  it("ranks by the documented blend, exactly", async () => {
    const r = await retrievePhotos(base({ limit: 200 }));
    expect(r.items.map((i) => i.photoId)).toEqual(expectedConceptOrder(allVisibleEmbedded()).slice(0, 200));
    const first = r.items[0].match;
    expect(first).toMatchObject({ type: "concept" });
    if (first.type === "concept") expect(first.similarity).toBeCloseTo(0.99, 5);
    expect(r.retrieval).toMatchObject({ version: "photo-retrieval/1", mode: "concept", embeddingModel: "vertex/multimodalembedding@001" });
    expect(r.coverage).toEqual({ notEmbedded: 1 });
    expect(r.total).toBe(allVisibleEmbedded().length);
  });

  it("pages without gaps or duplicates, and page size doesn't change the order", async () => {
    const small = await pageThrough(base({ limit: 1, filters: { minQuality: 0 } }));
    // minQuality 0 keeps only evaluated photos: the three deep ones and one keyword fixture.
    expect(small).toEqual(expectedConceptOrder([...deepQualified, keywordPhotos[1]]));
    const byFifty = await pageThrough(base({ limit: 50 }));
    const byTwoHundred = await pageThrough(base({ limit: 200 }));
    expect(byFifty).toEqual(byTwoHundred);
    expect(new Set(byFifty).size).toBe(byFifty.length);
    expect(byFifty).toEqual(expectedConceptOrder(allVisibleEmbedded()).slice(0, MAX_CONCEPT_DEPTH));
  });

  it("reuses the query vector across pages instead of calling the provider again", async () => {
    const p1 = await retrievePhotos(base({ limit: 5 }));
    await retrievePhotos(base({ limit: 5, cursor: p1.page.nextCursor }));
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });

  it("stops at the depth limit and says so", async () => {
    const r = await retrievePhotos(base({ limit: 20, offset: MAX_CONCEPT_DEPTH - 5 }));
    expect(r.items).toHaveLength(5);
    expect(r.page).toEqual({ nextCursor: null, exhausted: false, limited: true });
    const beyond = await retrievePhotos(base({ limit: 20, offset: MAX_CONCEPT_DEPTH }));
    expect(beyond.items).toEqual([]);
    expect(beyond.page.limited).toBe(true);
  });
});

describe("cursor binding", () => {
  it("rejects a cursor from a different request", async () => {
    const p1 = await retrievePhotos(base({ limit: 5 }));
    await expect(retrievePhotos(base({ limit: 5, cursor: p1.page.nextCursor, filters: { minQuality: 1 } }))).rejects.toMatchObject({
      code: "cursor_mismatch",
    });
    await expect(retrievePhotos(base({ limit: 5, cursor: p1.page.nextCursor, text: "something else" }))).rejects.toMatchObject({
      code: "cursor_mismatch",
    });
    await expect(retrievePhotos(base({ limit: 5, cursor: p1.page.nextCursor, canSeeHidden: true }))).rejects.toMatchObject({
      code: "cursor_mismatch",
    });
  });

  it("rejects malformed cursors and cursors from the other mode", async () => {
    await expect(retrievePhotos(base({ cursor: "not-a-cursor" }))).rejects.toBeInstanceOf(RetrievalError);
    const kw = await retrievePhotos(base({ mode: "keyword", text: "archer", limit: 1 }));
    await expect(retrievePhotos(base({ cursor: kw.page.nextCursor }))).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

describe("provider failures are explicit", () => {
  it("reports an unavailable provider instead of an empty result", async () => {
    const r = await retrievePhotos(base({ text: "__timeout__ archer" }));
    expect(r).toMatchObject({ status: "unavailable", items: [], total: null, degraded: { reason: "timeout", affects: "query" } });
    expect(r.page.exhausted).toBe(false);
  });

  it("still ranks when only the exclusion can't be embedded, and says so", async () => {
    const r = await retrievePhotos(base({ exclude: ["__timeout__ crowd"], limit: 3 }));
    expect(r.status).toBe("ok");
    expect(r.items).toHaveLength(3);
    expect(r.degraded).toEqual({ reason: "timeout", affects: "exclusions" });
  });
});

describe("keyword mode", () => {
  const kw = (over: Partial<RetrievalRequest> = {}) => base({ mode: "keyword", text: "archer", ...over });

  it("matches album title, uploader or description, ordered by quality tier, newest, then id", async () => {
    const r = await retrievePhotos(kw({ limit: 50 }));
    const [release, fullDraw, coach, crowd, target] = keywordPhotos;
    // Tier 9 first; then tier 5 newest-first; equal timestamps fall back to id desc.
    expect(r.items.map((i) => i.photoId)).toEqual([fullDraw.id, target.id, crowd.id, coach.id, release.id]);
    expect(r.items[0].match).toEqual({ type: "keyword", fields: ["description"] });
    expect(r.total).toBe(5);
    expect(r.page.exhausted).toBe(true);
  });

  it("matches the uploader's name and album titles", async () => {
    const byUploader = await retrievePhotos(kw({ text: "robin fletcher", limit: 1 }));
    expect(byUploader.items[0].match).toEqual({ type: "keyword", fields: ["uploader"] });
    const byAlbum = await retrievePhotos(kw({ text: "practice range", limit: 200 }));
    expect(byAlbum.total).toBe(keywordPhotos.length);
  });

  it("drops photos whose description mentions an exclusion", async () => {
    const r = await retrievePhotos(kw({ exclude: ["crowd"], limit: 50 }));
    expect(r.items.map((i) => i.photoId)).not.toContain(keywordPhotos[3].id);
    expect(r.total).toBe(4);
  });

  it("pages through equal timestamps without gaps or duplicates", async () => {
    const one = await pageThrough(kw({ limit: 1 }));
    const all = (await retrievePhotos(kw({ limit: 50 }))).items.map((i) => i.photoId);
    expect(one).toEqual(all);
  });
});
