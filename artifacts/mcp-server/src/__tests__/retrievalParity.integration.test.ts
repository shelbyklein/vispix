import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Caller parity for the shared retrieval service (#213): the same normalized
// request through web search (/search/semantic, /search/photos), the MCP
// search_photos data path and Create's hero-photo lookup returns the same
// photos in the same order. Real Postgres + pgvector; the query embedding is
// stubbed to a fixed vector (axis 0), so similarities are exactly the fixture's.
const DIM = 1408;
function unit(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}

vi.mock("@workspace/api-server/src/lib/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-auth-user");
        return id ? { user: { id, email: id, name: id } } : null;
      },
    },
    handler: async () => new Response(null, { status: 404 }),
  },
}));
vi.mock("@workspace/api-server/src/lib/aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-server/src/lib/aiEmbedding")>()),
  embedQuery: async () => ({ ok: true, vec: unit({ 0: 1 }) }),
}));

import type { Server } from "node:http";
import app from "@workspace/api-server/src/app";
import { db, pool, photosTable, photoEmbeddingsTable, photoAiEvaluationsTable, ratingsTable } from "@workspace/db";
import { findPhotoCandidates } from "@workspace/api-server/src/lib/imageGeneration/plan";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum } from "@workspace/api-server/src/lib/__tests__/testDb";
import { searchPhotos } from "../photoLibrary";

let server: Server;
let baseUrl: string;
let orgA: number;
let member: { id: number; authUserId: string };
let foreignId: number;

async function get(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${baseUrl}${path}?${qs}`, {
    headers: { "x-test-auth-user": member.authUserId, "x-organization-id": String(orgA) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response shapes are asserted below
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

beforeAll(async () => {
  await resetDb();
  const owner = await createUser();
  member = await createUser();
  orgA = (await createOrganization({ name: "Parity A" })).id;
  const orgB = (await createOrganization({ name: "Parity B" })).id;
  await addOrganizationMember(orgA, owner.id, "owner");
  await addOrganizationMember(orgA, member.id, "member");
  const album = await createAlbum(owner.id, "Parity album", orgA);
  const albumB = await createAlbum(owner.id, "Other", orgB);

  // 300 photos: similarity 0.95 down in 0.003 steps; a spread of AI scores so
  // the quality blend reorders neighbours; some ratings for the rating filter.
  const rows = await db
    .insert(photosTable)
    .values(
      Array.from({ length: 300 }, (_, i) => ({
        albumId: album.id,
        uploaderId: owner.id,
        organizationId: orgA,
        url: `/parity/${i}`,
        isHidden: i % 97 === 5,
      })),
    )
    .returning({ id: photosTable.id });
  await db.insert(photoEmbeddingsTable).values(
    rows.map((r, i) => {
      const s = 0.95 - i * 0.003;
      return { photoId: r.id, organizationId: orgA, embedding: unit({ 0: s, 1: Math.sqrt(1 - s * s) }), model: "test" };
    }),
  );
  await db.insert(photoAiEvaluationsTable).values(
    rows
      .filter((_, i) => i % 3 === 0)
      .map((r, i) => {
        const q = [9.4, 2.1, 7.7, 5.5, 8.8][i % 5];
        const r5 = Math.round(q);
        return { photoId: r.id, organizationId: orgA, technicalQuality: r5, composition: r5, subjectClarity: r5, emotionalImpact: r5, marketingUsability: r5, overallScore: q };
      }),
  );
  await db.insert(ratingsTable).values(rows.filter((_, i) => i % 4 === 0).map((r) => ({ photoId: r.id, userId: owner.id, score: 4 })));

  const [foreign] = await db
    .insert(photosTable)
    .values({ albumId: albumB.id, uploaderId: owner.id, organizationId: orgB, url: "/parity/foreign" })
    .returning({ id: photosTable.id });
  foreignId = foreign.id;
  await db.insert(photoEmbeddingsTable).values({ photoId: foreign.id, organizationId: orgB, embedding: unit({ 0: 1 }), model: "test" });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

const QUERY = "archer at full draw";
const ids = (photos: { id: number }[]) => photos.map((p) => p.id);

describe("identical requests give identical ordered photos in every caller (TT-VPX-RETRIEVAL-03)", () => {
  it("web semantic, web contract endpoint, MCP and Create agree", async () => {
    const semantic = await get("/search/semantic", { q: QUERY, topK: 40 });
    const contract = await get("/search/photos", { q: QUERY, mode: "concept", limit: 40 });
    const mcp = await searchPhotos({ query: QUERY, count: 40, organizationId: orgA });
    const create = await findPhotoCandidates(orgA, QUERY);

    expect(semantic.status).toBe(200);
    expect(contract.status).toBe(200);
    const reference = ids(semantic.body);
    expect(reference).toHaveLength(40);
    expect(reference).not.toContain(foreignId);
    expect(contract.body.items.map((i: { photo: { id: number } }) => i.photo.id)).toEqual(reference);
    expect(mcp.results.map((p) => p.id)).toEqual(reference);
    // Create asks for its six best candidates: the same six.
    expect(create.map((c) => c.refId)).toEqual(reference.slice(0, 6));
    expect(semantic.headers.get("x-search-status")).toBe("ok");
  });

  it("agrees under filters (web ratingMin/minQuality = MCP minRating/minQuality)", async () => {
    const web = await get("/search/photos", { q: QUERY, mode: "concept", limit: 25, ratingMin: 4, minQuality: 7 });
    const mcp = await searchPhotos({ query: QUERY, count: 25, minRating: 4, minQuality: 7, organizationId: orgA });
    const webIds = web.body.items.map((i: { photo: { id: number } }) => i.photo.id);
    expect(webIds.length).toBeGreaterThan(0);
    expect(mcp.results.map((p) => p.id)).toEqual(webIds);
    // Every result really satisfies both filters.
    for (const item of web.body.items as { photo: { averageRating: number | null } }[]) expect(item.photo.averageRating).toBeGreaterThanOrEqual(4);
  });

  it("deep filtered pages from the web endpoint equal one long page", async () => {
    const pages: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const r = await get("/search/photos", { q: QUERY, mode: "concept", limit: 7, minQuality: 5, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200);
      pages.push(...r.body.items.map((i: { photo: { id: number } }) => i.photo.id));
      cursor = r.body.page.nextCursor;
      if (!cursor) {
        expect(r.body.page.exhausted).toBe(true);
        break;
      }
    }
    const whole = await get("/search/photos", { q: QUERY, mode: "concept", limit: 200, minQuality: 5 });
    const wholeIds = whole.body.items.map((i: { photo: { id: number } }) => i.photo.id);
    expect(pages).toEqual(wholeIds);
    expect(new Set(pages).size).toBe(pages.length);
    expect(whole.body.total).toBe(wholeIds.length);
  });

  it("reports contract metadata and rejects a stale cursor over HTTP", async () => {
    // The default mode is combined (#208): no exact match here, so concept results.
    const p1 = await get("/search/photos", { q: QUERY, limit: 5 });
    expect(p1.body.retrieval).toMatchObject({ version: "photo-retrieval/1", mode: "combined" });
    expect(p1.body.items[0].match).toMatchObject({ type: "concept" });
    const stale = await get("/search/photos", { q: QUERY, limit: 5, minQuality: 3, cursor: p1.body.page.nextCursor });
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe("cursor_mismatch");
  });

  it("keyword mode keeps the legacy /search response and matches the contract endpoint", async () => {
    const legacy = await get("/search", { q: "parity", limit: 12, offset: 12 });
    const contract1 = await get("/search/photos", { q: "parity", mode: "keyword", limit: 12 });
    const contract2 = await get("/search/photos", { q: "parity", mode: "keyword", limit: 12, cursor: contract1.body.page.nextCursor });
    expect(legacy.body.hasMore).toBe(true);
    expect(ids(legacy.body.photos)).toEqual(contract2.body.items.map((i: { photo: { id: number } }) => i.photo.id));
    expect(contract1.body.items[0].match).toEqual({ type: "keyword", fields: ["album_title"] });
  });
});
