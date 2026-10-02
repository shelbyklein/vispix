import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Functional-review acceptance journeys (#223, TT-VPX-ACCEPT-02), API level.
//
// EVIDENCE CLASS: API/HTTP + fixture data + MOCKED embedding provider. These
// journeys exercise the real Express app and a real Postgres + pgvector
// database through the same endpoints the web app and MCP use, but the query
// embedding is a stub (fixtures/acceptanceLibrary.ts) and photo embeddings are
// synthetic vectors. Passing here is NOT live-provider relevance, browser,
// physical-device or production evidence; see docs/RELEASE_CHECKLIST.md.
//
// Auth is mocked as in the org isolation suite (x-test-auth-user header).
vi.mock("../auth", () => ({
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
vi.mock("../aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiEmbedding")>()),
  embedQuery: async (q: string) => (await import("./fixtures/acceptanceLibrary")).stubEmbedQuery(q),
}));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, photosTable, photoEmbeddingsTable, photoAiEvaluationsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { resetDb } from "./testDb";
import { clearQueryEmbeddingCache, CONCEPT_QUALITY_WEIGHT, NEUTRAL_QUALITY_SCORE } from "../photoRetrieval";
import {
  buildAcceptanceLibrary,
  expectedConceptOrder,
  providerControl,
  resetProvider,
  withSimilarity,
  type AcceptanceLibrary,
  type FixtureUser,
  type FixturePhoto,
} from "./fixtures/acceptanceLibrary";

let server: Server;
let base: string;
let L: AcceptanceLibrary;

// Informational latency samples (single local run; not an SLA, see the release checklist).
const latency: { journey: string; ms: number }[] = [];
async function timed<T>(journey: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    latency.push({ journey, ms: Math.round(performance.now() - t0) });
  }
}

type Res = { status: number; headers: Headers; body: any };
async function call(method: string, path: string, as: FixtureUser | null, org: number | null, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (as) headers["x-test-auth-user"] = as.authUserId;
  if (org != null) headers["x-organization-id"] = String(org);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}
const get = (path: string, as: FixtureUser | null, org: number | null) => call("GET", path, as, org);
const qs = (p: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

const search = (as: FixtureUser, org: number, p: Record<string, string | number | boolean | undefined>) =>
  get(`/api/search/photos?${qs(p)}`, as, org);
const searchIds = (r: Res): number[] => r.body.items.map((i: { photo: { id: number } }) => i.photo.id);

/** Pages through /search/photos with a cursor; fails on a repeated photo. */
async function pageAll(as: FixtureUser, org: number, p: Record<string, string | number | boolean | undefined>): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 400; guard++) {
    const r = await search(as, org, { ...p, cursor });
    expect(r.status).toBe(200);
    ids.push(...searchIds(r));
    if (!r.body.page.nextCursor) break;
    cursor = r.body.page.nextCursor;
  }
  return ids;
}

const visible = (p: FixturePhoto) => !p.hidden;
const order = (pred: (p: FixturePhoto) => boolean = () => true) =>
  expectedConceptOrder(L.photosA, CONCEPT_QUALITY_WEIGHT, NEUTRAL_QUALITY_SCORE, pred);
const idOf = (index: number) => L.photosA[index].id;

beforeAll(async () => {
  await resetDb();
  L = await buildAcceptanceLibrary();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 120_000);

beforeEach(() => {
  resetProvider();
  clearQueryEmbeddingCache();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  // Informational only: no budget is agreed yet (TT-VPX-ACCEPT-01), so nothing is asserted.
  const groups = new Map<string, number[]>();
  for (const l of latency) groups.set(l.journey, [...(groups.get(l.journey) ?? []), l.ms]);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.info(
    "[acceptance latency, informational: local run, mocked provider, no budget asserted]\n" +
      [...groups].map(([j, xs]) => `  median ${String(median(xs)).padStart(4)} ms  max ${String(Math.max(...xs)).padStart(4)} ms  n=${xs.length}  ${j}`).join("\n"),
  );
});

describe("fixture sanity", () => {
  it("has two orgs, 120+ photos in orgA and the documented edge cases", () => {
    expect(L.photosA.length).toBeGreaterThanOrEqual(120);
    expect(L.photosB.length).toBeGreaterThan(0);
    expect(new Set(L.photosA.map((p) => p.id)).size).toBe(L.photosA.length);
    expect(L.photosA.filter((p) => p.hidden)).toHaveLength(5);
    expect(L.photosA.filter((p) => p.rights.length === 0).length).toBeGreaterThan(0);
    expect(L.photosA.filter((p) => !p.embedded)).toHaveLength(3);
  });
});

describe("journey: exact filename and photo-ID lookup (#208)", () => {
  it("finds a punctuation-rich filename first, with and without the extension", async () => {
    for (const q of ["Fri-pm (146).webp", "fri-pm (146).JPG", "Fri-pm (146)"]) {
      const r = await timed("exact filename (combined)", () => search(L.memberA, L.orgA, { q, limit: 10 }));
      expect(r.status).toBe(200);
      expect(r.body.items[0].photo.id).toBe(idOf(3));
      expect(r.body.items[0].match).toMatchObject({ type: "exact", fields: ["filename"] });
    }
  });

  it("returns every photo that shares a repeated filename, across albums", async () => {
    const r = await search(L.memberA, L.orgA, { q: "dup-name.jpg", limit: 20 });
    const exact = r.body.items.filter((i: any) => i.match.type === "exact").map((i: any) => i.photo.id);
    expect(exact.sort((a: number, b: number) => a - b)).toEqual([idOf(10), idOf(70), idOf(100)].sort((a, b) => a - b));
    const albums = new Set(r.body.items.filter((i: any) => i.match.type === "exact").map((i: any) => i.photo.albumId));
    expect(albums.size).toBeGreaterThan(1);
  });

  it("matches NFC-normalized names and keeps wildcards literal", async () => {
    const nfc = await search(L.memberA, L.orgA, { q: "Café-final", limit: 5 });
    expect(nfc.body.items[0].photo.id).toBe(idOf(6));
    const wild = await search(L.memberA, L.orgA, { q: "100%_wild", limit: 5 });
    expect(wild.body.items[0].photo.id).toBe(idOf(5));
    // A bare wildcard must not exact-match every filename.
    const percent = await search(L.memberA, L.orgA, { q: "%", mode: "keyword", limit: 50 });
    expect(percent.body.items.every((i: any) => i.match.type !== "exact")).toBe(true);
  });

  it.each([(id: number) => String(id), (id: number) => `#${id}`, (id: number) => `id:${id}`, (id: number) => `photo ${id}`, (id: number) => `https://x.test/photos/${id}`])(
    "resolves a photo-ID query form (%#)",
    async (form) => {
      const r = await timed("exact photo id", () => search(L.memberA, L.orgA, { q: form(idOf(50)), limit: 5 }));
      expect(r.body.items[0].photo.id).toBe(idOf(50));
      expect(r.body.items[0].match).toMatchObject({ type: "exact", fields: ["photo_id"] });
    },
  );

  it("does not exact-match hidden photos for a member, but does for an admin", async () => {
    const hidden = L.photosA.find((p) => p.hidden)!;
    const asMember = await search(L.memberA, L.orgA, { q: `#${hidden.id}` });
    expect(searchIds(asMember)).not.toContain(hidden.id);
    const asAdmin = await search(L.adminA, L.orgA, { q: `#${hidden.id}`, includeHidden: true });
    expect(asAdmin.body.items[0].photo.id).toBe(hidden.id);
  });

  it("never resolves another org's photo ID or identically named photo", async () => {
    const foreign = L.photosB[3];
    const byId = await search(L.memberA, L.orgA, { q: `#${foreign.id}` });
    expect(searchIds(byId)).not.toContain(foreign.id);
    const byName = await search(L.memberA, L.orgA, { q: "Fri-pm (146).webp" });
    expect(searchIds(byName)).not.toContain(foreign.id);
    const ownSide = await search(L.memberB, L.orgB, { q: "Fri-pm (146).webp" });
    expect(searchIds(ownSide)[0]).toBe(foreign.id);
  });
});

describe("journey: conceptual search (mocked query embedding)", () => {
  it("ranks the visible, embedded library by the documented blend, org-scoped", async () => {
    const expected = order(visible);
    const r = await timed("concept search page 1 (mock embed)", () => search(L.memberA, L.orgA, { q: "archer at full draw", mode: "concept", limit: 30 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok", degraded: null });
    expect(searchIds(r)).toEqual(expected.slice(0, 30));
    expect(r.body.total).toBe(expected.length);
    expect(r.body.coverage.notEmbedded).toBe(L.photosA.filter((p) => !p.embedded && !p.hidden).length);
    const foreign = new Set(L.photosB.map((p) => p.id));
    expect(searchIds(r).some((id) => foreign.has(id))).toBe(false); // orgB's perfect matches never appear
    expect(r.body.items.every((i: any) => i.match.type === "concept")).toBe(true);
  });

  it("combined mode with a conceptual query ranks the same way when nothing matches exactly", async () => {
    const r = await search(L.memberA, L.orgA, { q: "smiling children", limit: 30 });
    expect(r.body.status).toBe("ok");
    expect(searchIds(r)).toEqual(order(visible).slice(0, 30));
  });
});

describe("journey: filter switching (#205)", () => {
  const cases: { name: string; params: Record<string, string | number>; pred: (p: FixturePhoto) => boolean }[] = [
    { name: "ratingMin 4", params: { ratingMin: 4 }, pred: (p) => p.rating >= 4 },
    { name: "ratingMin 3 / ratingMax 4", params: { ratingMin: 3, ratingMax: 4 }, pred: (p) => p.rating >= 3 && p.rating <= 4 },
    { name: "minQuality 7", params: { minQuality: 7 }, pred: (p) => (p.quality ?? -1) >= 7 },
    { name: "date range 2026-05-03..2026-05-05 (dateTo inclusive)", params: { dateFrom: "2026-05-03", dateTo: "2026-05-05" }, pred: (p) => p.takenAt != null && p.index % 10 >= 2 && p.index % 10 <= 4 },
  ];
  it.each(cases)("$name: pages are filtered in SQL, before pagination", async ({ params, pred }) => {
    const expected = order((p) => visible(p) && pred(p));
    expect(expected.length).toBeGreaterThan(0);
    const ids = await timed("filtered concept paging", () => pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 7, ...params }));
    expect(ids).toEqual(expected);
  });

  it("rights tag and person filters follow the org's own tags/people", async () => {
    const sponsor = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10, rightsTagId: L.tags.sponsorA });
    expect(sponsor).toEqual(order((p) => visible(p) && p.rights.includes("Sponsor OK")));
    const jane = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10, personId: L.people.janeA });
    expect(jane).toEqual(order((p) => visible(p) && p.people.includes("Jane Archer")));
    // Photos with NO rights tag are simply absent from every rights filter.
    const noRights = new Set(L.photosA.filter((p) => p.rights.length === 0).map((p) => p.id));
    expect(sponsor.some((id) => noRights.has(id))).toBe(false);
  });

  it("another org's rights tag or person id yields no results rather than leaking or being ignored", async () => {
    for (const p of [{ rightsTagId: L.tags.sponsorB }, { personId: L.people.janeB }]) {
      const r = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", ...p });
      expect(r.status).toBe(200);
      expect(r.body.items).toEqual([]);
    }
  });

  it("combining filters narrows monotonically and switching back restores the full set", async () => {
    const all = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 50 });
    const rated = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 50, ratingMin: 4 });
    const ratedAndSponsor = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 50, ratingMin: 4, rightsTagId: L.tags.sponsorA });
    expect(ratedAndSponsor.every((id) => rated.includes(id))).toBe(true);
    expect(rated.every((id) => all.includes(id))).toBe(true);
    expect(ratedAndSponsor.length).toBeLessThan(rated.length);
    expect(rated.length).toBeLessThan(all.length);
    expect(await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 50 })).toEqual(all);
  });

  it("hidden photos by role: members never see them (includeHidden ignored); admins and owners opt in", async () => {
    const hidden = new Set(L.photosA.filter((p) => p.hidden).map((p) => p.id));
    for (const who of [L.memberA]) {
      const ids = await pageAll(who, L.orgA, { q: "archer", mode: "concept", limit: 50, includeHidden: true });
      expect(ids.some((id) => hidden.has(id))).toBe(false);
    }
    for (const who of [L.adminA, L.ownerA]) {
      const without = await pageAll(who, L.orgA, { q: "archer", mode: "concept", limit: 50 });
      expect(without.some((id) => hidden.has(id))).toBe(false);
      const withHidden = await pageAll(who, L.orgA, { q: "archer", mode: "concept", limit: 50, includeHidden: true });
      expect(withHidden).toEqual(order());
    }
  });

  it("rejects malformed filters instead of ignoring them", async () => {
    for (const p of [{ dateFrom: "05/01/2026" }, { ratingMin: 9 }, { dateFrom: "2026-05-05", dateTo: "2026-05-01" }, { rightsTagId: "abc" }]) {
      const r = await search(L.memberA, L.orgA, { q: "archer", ...p });
      expect(r.status).toBe(400);
    }
  });
});

describe("journey: pagination and error recovery (#209)", () => {
  it.each([1, 7, 30, 125, 200])("limit %i pages the whole ranking with no gaps or duplicates", async (limit) => {
    const ids = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit });
    expect(ids).toEqual(order(visible));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keyword paging is exhaustive and stable too", async () => {
    // "IMG_" is a filename substring present on most photos.
    const ids = await pageAll(L.memberA, L.orgA, { q: "IMG_", mode: "keyword", limit: 11 });
    expect(new Set(ids).size).toBe(ids.length);
    const expectedCount = L.photosA.filter((p) => !p.hidden && p.filename.includes("IMG_")).length;
    expect(ids).toHaveLength(expectedCount);
  });

  it("a photo added mid-paging does not shift or duplicate later pages", async () => {
    const first = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 20 });
    const [added] = await db
      .insert(photosTable)
      .values({ albumId: L.albums.nationals, uploaderId: L.ownerA.id, organizationId: L.orgA, url: "/api/storage/objects/acceptance/late", filename: "late.jpg" })
      .returning({ id: photosTable.id });
    try {
      await db.insert(photoEmbeddingsTable).values({ photoId: added.id, organizationId: L.orgA, embedding: withSimilarity(0.999), model: "test" });
      await db.insert(photoAiEvaluationsTable).values({ photoId: added.id, organizationId: L.orgA, technicalQuality: 10, composition: 10, subjectClarity: 10, emotionalImpact: 10, marketingUsability: 10, overallScore: 10 });
      const rest: number[] = [];
      let cursor: string | null = first.body.page.nextCursor;
      while (cursor) {
        const r = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 20, cursor });
        rest.push(...searchIds(r));
        cursor = r.body.page.nextCursor;
      }
      expect([...searchIds(first), ...rest]).toEqual(order(visible));
      // A fresh search does show it, first.
      clearQueryEmbeddingCache();
      const fresh = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 5 });
      expect(searchIds(fresh)[0]).toBe(added.id);
    } finally {
      await db.delete(photosTable).where(inArray(photosTable.id, [added.id]));
    }
  });

  it("a cursor from a different query/filter set is refused (cursor_mismatch); restarting from page one recovers", async () => {
    const first = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10 });
    const cursor = first.body.page.nextCursor as string;
    expect(cursor).toBeTruthy();
    for (const changed of [{ q: "different query" }, { ratingMin: 4 }]) {
      const stale = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10, ...changed, cursor });
      expect(stale.status).toBe(400);
      expect(stale.body.code).toBe("cursor_mismatch");
    }
    // Replaying a concept cursor against the keyword ranking is also refused.
    const crossMode = await search(L.memberA, L.orgA, { q: "archer", mode: "keyword", limit: 10, cursor });
    expect(crossMode.status).toBe(400);
    expect(["cursor_mismatch", "invalid_cursor"]).toContain(crossMode.body.code);
    // Recovery: the same changed request without the cursor works from page one.
    const restart = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10, ratingMin: 4 });
    expect(restart.status).toBe(200);
    expect(searchIds(restart)).toEqual(order((p) => visible(p) && p.rating >= 4).slice(0, 10));
  });

  it("a garbled cursor is a client error, not a 500 or an empty result", async () => {
    const r = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", cursor: "not-a-real-cursor" });
    expect(r.status).toBe(400);
  });

  it("a cursor issued for one viewer role cannot be replayed with another role's visibility", async () => {
    const adminFirst = await search(L.adminA, L.orgA, { q: "archer", mode: "concept", limit: 10, includeHidden: true });
    const replay = await search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10, includeHidden: true, cursor: adminFirst.body.page.nextCursor });
    expect(replay.status).toBe(400);
  });
});

describe("journey: deep photo navigation (#210)", () => {
  it("steps through search results far beyond the first page, in search order", async () => {
    const seq = order(visible);
    for (const idx of [0, 1, 29, 30, 60, 95, seq.length - 1]) {
      const r = await timed("neighbors in search (deep)", () =>
        get(`/api/photos/${seq[idx]}/neighbors?${qs({ q: "archer", mode: "concept" })}`, L.memberA, L.orgA),
      );
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        context: "search",
        inContext: true,
        previousId: idx > 0 ? seq[idx - 1] : null,
        nextId: idx < seq.length - 1 ? seq[idx + 1] : null,
        position: idx + 1,
        total: seq.length,
      });
    }
  });

  it("search neighbors honour the active filters", async () => {
    const seq = order((p) => visible(p) && p.rating >= 4);
    const idx = Math.floor(seq.length / 2);
    const r = await get(`/api/photos/${seq[idx]}/neighbors?${qs({ q: "archer", mode: "concept", ratingMin: 4 })}`, L.memberA, L.orgA);
    expect(r.body).toMatchObject({ previousId: seq[idx - 1], nextId: seq[idx + 1], position: idx + 1, total: seq.length });
  });

  it("album context: position past the first page, hidden photos skipped for members", async () => {
    // Album order is created_at DESC (== fixture index ascending), hidden removed for a member.
    const album = L.photosA.filter((p) => p.albumId === L.albums.nationals && !p.hidden);
    const idx = 55; // > one 50-photo page
    expect(album.length).toBeGreaterThan(idx + 1);
    const r = await get(`/api/photos/${album[idx].id}/neighbors`, L.memberA, L.orgA);
    expect(r.body).toMatchObject({ context: "album", albumId: L.albums.nationals, inContext: true, previousId: album[idx - 1].id, nextId: album[idx + 1].id, position: idx + 1, total: album.length });
    // The album page's own paging agrees about what sits at that position.
    const page2 = await get(`/api/albums/${L.albums.nationals}/photos?limit=50&offset=50`, L.memberA, L.orgA);
    expect(page2.body.photos[idx - 50].id).toBe(album[idx].id);
  });

  it("a hidden photo is not navigable for a member and is in sequence for an admin", async () => {
    const hidden = L.photosA.find((p) => p.hidden && p.albumId === L.albums.nationals)!;
    expect((await get(`/api/photos/${hidden.id}/neighbors`, L.memberA, L.orgA)).status).toBe(404);
    const asAdmin = await get(`/api/photos/${hidden.id}/neighbors`, L.adminA, L.orgA);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.inContext).toBe(true);
  });

  it("never navigates to or reveals another org's photos", async () => {
    const r = await get(`/api/photos/${L.photosB[0].id}/neighbors`, L.memberA, L.orgA);
    expect(r.status).toBe(404);
  });
});

describe("journey: shortlist to project (supported part: save the shortlist, #211)", () => {
  it("saves a ten-photo concept shortlist to a project, in order, org-scoped", async () => {
    const shortlist = order(visible).slice(0, 10);
    for (const id of shortlist) {
      const r = await timed("add shortlist photo to project", () => call("POST", `/api/projects/${L.projects.springCampaign}/photos`, L.ownerA, L.orgA, { photoId: id }));
      expect(r.status).toBe(204);
    }
    const project = await get(`/api/projects/${L.projects.springCampaign}`, L.memberA, L.orgA);
    expect(project.status).toBe(200);
    expect(project.body.photos.map((p: { id: number }) => p.id).sort((a: number, b: number) => a - b)).toEqual([...shortlist].sort((a, b) => a - b));
    // Another org's photo cannot be added; another org cannot read the project.
    expect((await call("POST", `/api/projects/${L.projects.springCampaign}/photos`, L.ownerA, L.orgA, { photoId: L.photosB[0].id })).status).toBe(404);
    expect((await get(`/api/projects/${L.projects.springCampaign}`, L.ownerB, L.orgB)).status).toBe(404);
    // A plain member cannot modify a project someone else created (#218).
    expect((await call("POST", `/api/projects/${L.projects.springCampaign}/photos`, L.memberA, L.orgA, { photoId: idOf(60) })).status).toBe(403);
  });

  it("a member cannot smuggle a hidden photo into their own project and read it back", async () => {
    const hidden = L.photosA.find((p) => p.hidden)!;
    const mine = await call("POST", "/api/projects", L.memberA, L.orgA, { name: "Member shortlist" });
    expect(mine.status).toBe(201);
    const added = await call("POST", `/api/projects/${mine.body.id}/photos`, L.memberA, L.orgA, { photoId: hidden.id });
    const back = await get(`/api/projects/${mine.body.id}`, L.memberA, L.orgA);
    const leaked = added.status === 204 && back.body.photos.some((p: { id: number }) => p.id === hidden.id);
    expect(leaked).toBe(false);
  });

  it.todo("export the shortlist as a zip: needs object storage objects; covered by manual/dev acceptance (docs/RELEASE_CHECKLIST.md)");
});

describe("journey: primary-logo retrieval (#206)", () => {
  const brand = async (as: FixtureUser, org: number, extra = "") => (await get(`/api/assets?kind=brand${extra}`, as, org)).body as any[];

  it("returns exactly one primary for the org (global) and a distinct one for the project; variants stay inspectable", async () => {
    const all = await timed("list brand assets", () => brand(L.memberA, L.orgA));
    const orgPrimary = all.filter((a) => a.isPrimary && a.projectId == null);
    const projectPrimary = all.filter((a) => a.isPrimary && a.projectId === L.projects.springCampaign);
    expect(orgPrimary.map((a) => a.id)).toEqual([L.assets["Acceptance Logo"]]);
    expect(projectPrimary.map((a) => a.id)).toEqual([L.assets["Spring Open Logo"]]);
    expect(all.filter((a) => a.isPrimary)).toHaveLength(2);
    // The decoy's name says "primary" but it was never designated.
    expect(all.find((a) => a.name === "Primary Logo (old)").isPrimary).toBe(false);
    expect(all.filter((a) => a.projectId == null).map((a) => a.variant).sort()).toEqual(["icon-only", "legacy", "primary", "stacked", "white"]);
    expect(all.find((a) => a.id === L.assets["Acceptance Logo"]).notes).toBe("Use on light backgrounds");
  });

  it("project-scoped listing carries the project's primary and variants", async () => {
    const own = await brand(L.memberA, L.orgA, `&projectId=${L.projects.springCampaign}`);
    expect(own.map((a) => a.name).sort()).toEqual(["Spring Open Logo", "Spring Open Logo White"]);
    expect(own.filter((a) => a.isPrimary).map((a) => a.name)).toEqual(["Spring Open Logo"]);
  });

  it("is org-isolated: orgB sees only its own primary", async () => {
    const b = await brand(L.memberB, L.orgB);
    expect(b.map((a) => a.name)).toEqual(["B Logo"]);
    expect(b[0].isPrimary).toBe(true);
    expect(await brand(L.memberB, L.orgB, `&projectId=${L.projects.springCampaign}`)).toEqual([]);
  });

  it("only owners/admins designate the primary; designating replaces the old one within its scope only", async () => {
    const stacked = L.assets["Acceptance Logo Stacked"];
    expect((await call("PATCH", `/api/assets/${stacked}`, L.memberA, L.orgA, { isPrimary: true })).status).toBe(403);
    expect((await call("PATCH", `/api/assets/${stacked}`, L.outsider, L.orgA, { isPrimary: true })).status).toBe(403); // not a member of orgA
    try {
      expect((await call("PATCH", `/api/assets/${stacked}`, L.adminA, L.orgA, { isPrimary: true })).status).toBe(200);
      const all = await brand(L.memberA, L.orgA);
      expect(all.filter((a) => a.isPrimary && a.projectId == null).map((a) => a.id)).toEqual([stacked]);
      expect(all.filter((a) => a.isPrimary && a.projectId === L.projects.springCampaign).map((a) => a.id)).toEqual([L.assets["Spring Open Logo"]]);
    } finally {
      await call("PATCH", `/api/assets/${L.assets["Acceptance Logo"]}`, L.ownerA, L.orgA, { isPrimary: true });
    }
    const restored = await brand(L.memberA, L.orgA);
    expect(restored.filter((a) => a.isPrimary && a.projectId == null).map((a) => a.id)).toEqual([L.assets["Acceptance Logo"]]);
  });
});

describe("journey: Photo Graph basic (#202)", () => {
  type Graph = { seedId: number; nodes: { id: number; ring: number }[]; edges: { source: number; target: number; kind: string; label: string }[] };
  it("builds the threads around a photo from the caller's org only, hiding hidden photos from members", async () => {
    const seed = L.photosA[18]; // in Jane Archer's thread (i % 9 == 0)
    const r = await timed("photo graph", () => get(`/api/photos/${seed.id}/graph?threads=similar,person,event&perThread=12`, L.memberA, L.orgA));
    expect(r.status).toBe(200);
    const g = r.body as Graph;
    expect(g.seedId).toBe(seed.id);
    const ownIds = new Set(L.photosA.map((p) => p.id));
    expect(g.nodes.every((n) => ownIds.has(n.id))).toBe(true);
    const hidden = new Set(L.photosA.filter((p) => p.hidden).map((p) => p.id));
    expect(g.nodes.some((n) => hidden.has(n.id))).toBe(false);
    const person = g.edges.filter((e) => e.kind === "person");
    expect(person.length).toBeGreaterThan(0);
    expect(new Set(person.map((e) => e.label))).toEqual(new Set(["Jane Archer"]));
    const janeIds = new Set(L.photosA.filter((p) => p.people.includes("Jane Archer")).map((p) => p.id));
    for (const e of person) expect(janeIds.has(e.source === seed.id ? e.target : e.source)).toBe(true);
  });

  it("404s another org's photo and refuses non-members", async () => {
    expect((await get(`/api/photos/${L.photosB[0].id}/graph`, L.memberA, L.orgA)).status).toBe(404);
    expect((await get(`/api/photos/${idOf(0)}/graph`, L.outsider, L.orgA)).status).toBe(403);
    expect((await get(`/api/photos/${idOf(0)}/graph`, null, null)).status).toBe(401);
  });
});

describe("journey: provider failure and delay states (mocked provider)", () => {
  it.each(["timeout", "provider_error", "not_configured"] as const)("concept search while the provider is %s is 'unavailable', never an empty result", async (mode) => {
    providerControl.mode = mode;
    const r = await search(L.memberA, L.orgA, { q: "archer", mode: "concept" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("unavailable");
    expect(r.body.degraded).toMatchObject({ reason: mode, affects: "query" });
    expect(r.body.items).toEqual([]);
  });

  it("combined search degrades to literal results and says concept matching is off", async () => {
    providerControl.mode = "timeout";
    const r = await search(L.memberA, L.orgA, { q: "IMG_001", limit: 30 });
    expect(r.body.status).toBe("ok");
    expect(r.body.degraded).toMatchObject({ affects: "concept", reason: "timeout" });
    const ids = searchIds(r);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(r.body.items.map((i: any) => i.match.type))).toEqual(new Set(["keyword"]));
    // Exact lookup still works with the provider down.
    const exact = await search(L.memberA, L.orgA, { q: "Fri-pm (146).webp" });
    expect(exact.body.items[0].photo.id).toBe(idOf(3));
  });

  it("the legacy semantic endpoint reports the failure in headers", async () => {
    providerControl.mode = "provider_error";
    const r = await get(`/api/search/semantic?${qs({ q: "archer" })}`, L.memberA, L.orgA);
    expect(r.headers.get("x-search-status")).toBe("unavailable");
    expect(r.headers.get("x-search-degraded")).toContain("provider_error");
  });

  it("neighbors in a search that cannot be ranked report out-of-context instead of guessing", async () => {
    providerControl.mode = "timeout";
    const r = await get(`/api/photos/${idOf(0)}/neighbors?${qs({ q: "archer", mode: "concept" })}`, L.memberA, L.orgA);
    expect(r.status).toBe(200);
    expect(r.body.inContext).toBe(false);
    expect(r.body.previousId).toBeNull();
    expect(r.body.nextId).toBeNull();
  });

  it("a slow provider still answers correctly, and the embedding is reused across pages", async () => {
    providerControl.delayMs = 250;
    const first = await timed("concept search with 250 ms provider delay (mock)", () => search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10 }));
    expect(first.body.status).toBe("ok");
    const callsAfterFirst = providerControl.calls;
    const second = await timed("concept page 2 (cached query embedding)", () => search(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 10, cursor: first.body.page.nextCursor }));
    expect(second.body.status).toBe("ok");
    expect(providerControl.calls).toBe(callsAfterFirst);
  });

  it("recovers on the next request once the provider is back", async () => {
    providerControl.mode = "timeout";
    expect((await search(L.memberA, L.orgA, { q: "archer", mode: "concept" })).body.status).toBe("unavailable");
    resetProvider();
    expect((await search(L.memberA, L.orgA, { q: "archer", mode: "concept" })).body.status).toBe("ok");
  });
});

describe("journey: organization isolation and roles throughout", () => {
  it("a non-member is refused everywhere, including with another org's header", async () => {
    for (const path of ["/api/search/photos?q=archer", `/api/photos/${idOf(0)}`, `/api/albums/${L.albums.nationals}/photos`, "/api/assets", "/api/projects"]) {
      expect((await get(path, L.outsider, L.orgA)).status).toBe(403);
      expect((await get(path, L.outsider, null)).status).toBe(403); // belongs to no org
    }
    // A member of B asking for A's org by header is refused, not silently switched.
    expect((await get("/api/search/photos?q=archer", L.memberB, L.orgA)).status).toBe(403);
    expect((await get("/api/search/photos?q=archer", null, L.orgA)).status).toBe(401);
  });

  it("each org searches only its own library; B's perfect matches never reach A", async () => {
    const a = await pageAll(L.memberA, L.orgA, { q: "archer", mode: "concept", limit: 50 });
    const b = await pageAll(L.memberB, L.orgB, { q: "archer", mode: "concept", limit: 50 });
    expect(new Set(a).size).toBe(order(visible).length);
    expect(b.sort((x, y) => x - y)).toEqual(L.photosB.map((p) => p.id).sort((x, y) => x - y));
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it("direct object access across orgs is a 404, not a disclosure", async () => {
    expect((await get(`/api/photos/${L.photosA[0].id}`, L.memberB, L.orgB)).status).toBe(404);
    expect((await get(`/api/photos/${L.photosB[0].id}`, L.memberA, L.orgA)).status).toBe(404);
    expect((await get(`/api/projects/${L.projects.projectB}`, L.memberA, L.orgA)).status).toBe(404);
  });

  it("same-named albums and people resolve per org", async () => {
    const albumsA = await get("/api/albums", L.memberA, L.orgA);
    const albumsB = await get("/api/albums", L.memberB, L.orgB);
    expect(albumsA.body.map((a: any) => a.id)).toContain(L.albums.nationals);
    expect(albumsA.body.map((a: any) => a.id)).not.toContain(L.albums.nationalsB);
    expect(albumsB.body.map((a: any) => a.id)).toEqual([L.albums.nationalsB]);
  });
});

describe("journeys not supported by the current API (tracked, not invented)", () => {
  it.todo("brief-save ordering: save-then-generate for campaign briefs (#216) - no API-level ordering contract to assert yet");
  it.todo("nested folder import files and recovery (#222) - needs the import workflow and object storage; dev acceptance only");
  it.todo("MCP writes: the MCP connector is read-only by design (capabilities.ts); no write journey exists");
  it.todo("browser/physical-device journeys (grids, lightbox, narrow layouts): out of scope for API tests; see docs/RELEASE_CHECKLIST.md");
});
