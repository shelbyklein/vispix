import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Exact photo-ID / filename lookup and combined search (#208) on the shared
// retrieval service. Real Postgres + pgvector; the query embedding is stubbed
// (every query points along axis 0; while `provider.down` is set it fails like a timed-out provider).
const DIM = 1408;
function unit(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}
const provider = vi.hoisted(() => ({ down: false }));
vi.mock("../aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiEmbedding")>()),
  embedQuery: async () => (provider.down ? { ok: false as const, reason: "timeout" as const } : { ok: true as const, vec: unit({ 0: 1 }) }),
}));

import { db, pool, photosTable, photoEmbeddingsTable, photoAiEvaluationsTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, createAlbum } from "./testDb";
import { retrievePhotos, retrievalNeighbors, parseExactQuery, clearQueryEmbeddingCache, type RetrievalRequest } from "../photoRetrieval";

let orgA: number;
let orgB: number;
const P: Record<string, number> = {};

async function photo(key: string, o: { org: number; album: number; uploader: number; filename?: string | null; desc?: string | null; s?: number; hidden?: boolean; quality?: number }) {
  const [row] = await db
    .insert(photosTable)
    .values({ albumId: o.album, uploaderId: o.uploader, organizationId: o.org, url: `/find/${key}`, filename: o.filename ?? null, aiDescription: o.desc ?? null, isHidden: o.hidden ?? false })
    .returning({ id: photosTable.id });
  if (o.s != null) {
    await db.insert(photoEmbeddingsTable).values({ photoId: row.id, organizationId: o.org, embedding: unit({ 0: o.s, 1: Math.sqrt(1 - o.s * o.s) }), model: "test" });
  }
  if (o.quality != null) {
    const r = Math.round(o.quality);
    await db.insert(photoAiEvaluationsTable).values({ photoId: row.id, organizationId: o.org, technicalQuality: r, composition: r, subjectClarity: r, emotionalImpact: r, marketingUsability: r, overallScore: o.quality });
  }
  P[key] = row.id;
}

beforeAll(async () => {
  await resetDb();
  const user = await createUser({ name: "Casey Uploader" });
  orgA = (await createOrganization({ name: "Find A" })).id;
  orgB = (await createOrganization({ name: "Find B" })).id;
  const friday = await createAlbum(user.id, "Friday session", orgA);
  const saturday = await createAlbum(user.id, "Saturday session", orgA);
  const b = await createAlbum(user.id, "Other org", orgB);
  const A = { org: orgA, album: friday.id, uploader: user.id };
  await photo("friPm146", { ...A, filename: "Fri-pm (146).webp", desc: "Archer releasing an arrow", s: 0.2 });
  await photo("friPm147", { ...A, filename: "Fri-pm (147).webp", desc: "Archer at full draw", s: 0.3 });
  await photo("img1Fri", { ...A, filename: "IMG_0001.jpg", s: 0.4 });
  await photo("img1Sat", { ...A, album: saturday.id, filename: "IMG_0001.jpg", s: 0.5 });
  await photo("cafeNfd", { ...A, filename: "Café terrace.jpg", s: 0.1 });
  await photo("secret", { ...A, filename: "secret.jpg", hidden: true, s: 0.95 });
  await photo("percent", { ...A, filename: "a.jpg", desc: "Scored 100% on the day", s: 0.05 });
  await photo("underscore", { ...A, filename: "b.jpg", desc: "Scored 1000 on the day", s: 0.06 });
  await photo("smiling", { ...A, filename: "kids.jpg", desc: "Smiling children at the range", s: 0.9, quality: 8 });
  for (let i = 0; i < 25; i++) await photo(`filler${i}`, { ...A, filename: `filler-${i}.jpg`, s: 0.6 + i * 0.01 });
  await photo("foreignSameName", { org: orgB, album: b.id, uploader: user.id, filename: "Fri-pm (146).webp", s: 0.99 });
});

beforeEach(() => {
  clearQueryEmbeddingCache();
  provider.down = false;
});

afterAll(async () => {
  await pool.end();
});

const req = (over: Partial<RetrievalRequest>): RetrievalRequest => ({ organizationId: orgA, canSeeHidden: false, mode: "combined", text: "", limit: 20, ...over });
const exactOf = async (text: string, over: Partial<RetrievalRequest> = {}) =>
  (await retrievePhotos(req({ text, ...over }))).items.filter((i) => i.match.type === "exact");

describe("query interpretation (TT-VPX-FIND-01)", () => {
  it.each([
    ["123", 123],
    ["#123", 123],
    ["id:123", 123],
    ["photo 123", 123],
    ["https://vispix.dev/photos/123", 123],
    ["/photos/123?from=search", 123],
    ["photo of 123 archers", null],
    ["99999999999", null],
  ])("reads %s as photo ID %s", (text, id) => {
    expect(parseExactQuery(text).photoId).toBe(id);
  });

  it.each([
    ["Fri-pm (146).webp", "fri-pm (146)"],
    ["  FRI-PM (146).JPG ", "fri-pm (146)"],
    ["Fri-pm (146)", "fri-pm (146)"],
    ["archive.tar.gz", "archive.tar.gz"],
  ])("reads %s as filename stem %s", (text, stem) => {
    expect(parseExactQuery(text).filenameStem).toBe(stem);
  });
});

describe("exact filename lookup (TT-VPX-FIND-02)", () => {
  it("finds Fri-pm (146).webp exactly, first, and only in this org", async () => {
    const r = await retrievePhotos(req({ text: "Fri-pm (146).webp" }));
    expect(r.items[0]).toEqual({ photoId: P.friPm146, match: { type: "exact", fields: ["filename"] } });
    expect(r.items.filter((i) => i.match.type === "exact")).toHaveLength(1);
    expect(r.items.map((i) => i.photoId)).not.toContain(P.foreignSameName);
  });

  it.each(["fri-pm (146).webp", "FRI-PM (146).JPG", "Fri-pm (146)", "  Fri-pm (146).webp  "])("matches case, extension and spacing variants: %s", async (text) => {
    expect((await exactOf(text)).map((i) => i.photoId)).toEqual([P.friPm146]);
  });

  it("treats punctuation literally (no near-miss matches)", async () => {
    expect(await exactOf("Fri-pm (14).webp")).toEqual([]);
    expect(await exactOf("Fri-pm 146.webp")).toEqual([]);
  });

  it("returns every photo sharing a filename across albums, in a stable order", async () => {
    expect((await exactOf("IMG_0001.jpg")).map((i) => i.photoId)).toEqual([P.img1Fri, P.img1Sat]);
  });

  it("matches Unicode names regardless of normalization form", async () => {
    expect((await exactOf("Café terrace.jpg")).map((i) => i.photoId)).toEqual([P.cafeNfd]);
  });
});

describe("exact photo-ID lookup is scoped (TT-VPX-FIND-02)", () => {
  it("finds this org's photo by ID in every accepted form", async () => {
    for (const text of [String(P.friPm147), `#${P.friPm147}`, `id:${P.friPm147}`, `https://vispix.dev/photos/${P.friPm147}`]) {
      expect((await exactOf(text)).map((i) => [i.photoId, i.match])).toEqual([[P.friPm147, { type: "exact", fields: ["photo_id"] }]]);
    }
  });

  it("never exposes another org's photo or a hidden photo through exact lookup", async () => {
    expect(await exactOf(`#${P.foreignSameName}`)).toEqual([]);
    expect(await exactOf(`#${P.secret}`)).toEqual([]);
    expect(await exactOf("secret.jpg")).toEqual([]);
    expect((await exactOf(`#${P.secret}`, { canSeeHidden: true })).map((i) => i.photoId)).toEqual([P.secret]);
  });

  it("applies filters to exact matches too", async () => {
    expect(await exactOf("Fri-pm (146).webp", { filters: { minQuality: 5 } })).toEqual([]);
    expect((await exactOf("kids.jpg", { filters: { minQuality: 5 } })).map((i) => i.photoId)).toEqual([P.smiling]);
  });
});

describe("combined search (TT-VPX-FIND-02)", () => {
  it("returns conceptual candidates from the default mode", async () => {
    const r = await retrievePhotos(req({ text: "smiling children" }));
    expect(r.items[0]).toMatchObject({ photoId: P.smiling, match: { type: "concept" } });
    expect(r.retrieval.mode).toBe("combined");
  });

  it("puts the exact match first and never repeats it on any page", async () => {
    const ids: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await retrievePhotos(req({ text: "IMG_0001.jpg", limit: 7, cursor }));
      ids.push(...r.items.map((x) => x.photoId));
      cursor = r.page.nextCursor;
      if (!cursor) break;
    }
    expect(ids.slice(0, 2)).toEqual([P.img1Fri, P.img1Sat]);
    expect(new Set(ids).size).toBe(ids.length);
    // Every other visible embedded photo follows once (33 in all; the hidden one never).
    expect(ids.length).toBe(33);
    expect(ids).not.toContain(P.secret);
  });

  it("keeps literal matches visible when the provider is unavailable", async () => {
    provider.down = true;
    const exact = await retrievePhotos(req({ text: "Fri-pm (146).webp" }));
    expect(exact).toMatchObject({ status: "ok", degraded: { reason: "timeout", affects: "concept" } });
    expect(exact.items).toEqual([{ photoId: P.friPm146, match: { type: "exact", fields: ["filename"] } }]);
    const partial = await retrievePhotos(req({ text: "Fri-pm" }));
    expect(partial.status).toBe("ok");
    expect(partial.items.map((i) => [i.photoId, i.match])).toEqual(
      expect.arrayContaining([
        [P.friPm146, { type: "keyword", fields: ["filename"] }],
        [P.friPm147, { type: "keyword", fields: ["filename"] }],
      ]),
    );
    const words = await retrievePhotos(req({ text: "archer" }));
    expect(words.items.map((i) => i.photoId).sort()).toEqual([P.friPm146, P.friPm147].sort());
    expect(words.retrieval.embeddingModel).toBeNull();
  });

  it("reports the failure on a later page instead of switching rankings mid-scroll", async () => {
    const p1 = await retrievePhotos(req({ text: "smiling children", limit: 5 }));
    provider.down = true;
    clearQueryEmbeddingCache();
    const p2 = await retrievePhotos(req({ text: "smiling children", limit: 5, cursor: p1.page.nextCursor }));
    expect(p2).toMatchObject({ status: "unavailable", items: [], degraded: { reason: "timeout", affects: "query" } });
  });

  it("concept mode (MCP, Create) has no exact matches", async () => {
    const r = await retrievePhotos(req({ mode: "concept", text: "Fri-pm (146).webp" }));
    expect(r.items.some((i) => i.match.type === "exact")).toBe(false);
  });
});

describe("keyword is literal (TT-VPX-FIND-02)", () => {
  it("doesn't treat % or _ as wildcards", async () => {
    expect((await retrievePhotos(req({ mode: "keyword", text: "100%" }))).items.map((i) => i.photoId)).toEqual([P.percent]);
    expect((await retrievePhotos(req({ mode: "keyword", text: "IMG_000" }))).items.map((i) => i.photoId).sort()).toEqual([P.img1Fri, P.img1Sat].sort());
    expect((await retrievePhotos(req({ mode: "keyword", text: "1_00" }))).items).toEqual([]);
  });

  it("puts exact matches first in keyword mode too", async () => {
    const r = await retrievePhotos(req({ mode: "keyword", text: "Fri-pm (146).webp" }));
    expect(r.items[0]).toEqual({ photoId: P.friPm146, match: { type: "exact", fields: ["filename"] } });
    expect(r.items.filter((i) => i.photoId === P.friPm146)).toHaveLength(1);
  });
});

describe("neighbors across exact matches and ranked results (#210 NAV-03)", () => {
  it("steps from the exact matches into the ranked results and back", async () => {
    const r = req({ text: "IMG_0001.jpg" });
    const list = (await retrievePhotos({ ...r, limit: 50 })).items.map((i) => i.photoId);
    expect(list.slice(0, 2)).toEqual([P.img1Fri, P.img1Sat]);
    expect(await retrievalNeighbors(r, P.img1Fri)).toMatchObject({ previousId: null, nextId: P.img1Sat, position: 1, total: 33 });
    expect(await retrievalNeighbors(r, P.img1Sat)).toMatchObject({ previousId: P.img1Fri, nextId: list[2], position: 2 });
    expect(await retrievalNeighbors(r, list[2])).toMatchObject({ previousId: P.img1Sat, nextId: list[3], position: 3 });
    expect(await retrievalNeighbors(r, list[32])).toMatchObject({ nextId: null, position: 33 });
  });

  it("follows the literal fallback when concept ranking is down", async () => {
    provider.down = true;
    const r = req({ text: "Fri-pm" });
    const list = (await retrievePhotos({ ...r, limit: 50 })).items.map((i) => i.photoId);
    expect(await retrievalNeighbors(r, list[0])).toMatchObject({ inContext: true, nextId: list[1] ?? null, position: 1, total: list.length });
  });
});

