import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Scoped MCP reads over the shared acceptance fixture (#223, TT-VPX-ACCEPT-02).
//
// EVIDENCE CLASS: data-layer (the functions behind the MCP tools, called with
// the organization a connector token would carry) + fixture + MOCKED query
// embedding. It is NOT a real MCP client, token, transport or media-grant
// journey; those remain separate acceptance evidence (docs/RELEASE_CHECKLIST.md).
// The MCP connector is read-only by design, so there is no write journey.
vi.mock("@workspace/api-server/src/lib/aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-server/src/lib/aiEmbedding")>()),
  embedQuery: async (q: string) =>
    (await import("@workspace/api-server/src/lib/__tests__/fixtures/acceptanceLibrary")).stubEmbedQuery(q),
}));

import { pool } from "@workspace/db";
import { resetDb } from "@workspace/api-server/src/lib/__tests__/testDb";
import { clearQueryEmbeddingCache, CONCEPT_QUALITY_WEIGHT, NEUTRAL_QUALITY_SCORE } from "@workspace/api-server/src/lib/photoRetrieval";
import {
  buildAcceptanceLibrary,
  expectedConceptOrder,
  providerControl,
  resetProvider,
  type AcceptanceLibrary,
} from "@workspace/api-server/src/lib/__tests__/fixtures/acceptanceLibrary";
import { searchPhotos, getPhotoDetail, listAlbums, listPeople, listUsageRights } from "../photoLibrary";
import { listAssets } from "../assetLibrary";

let L: AcceptanceLibrary;
const order = (pred: Parameters<typeof expectedConceptOrder>[3]) =>
  expectedConceptOrder(L.photosA, CONCEPT_QUALITY_WEIGHT, NEUTRAL_QUALITY_SCORE, pred);

beforeAll(async () => {
  await resetDb();
  L = await buildAcceptanceLibrary();
}, 120_000);

beforeEach(() => {
  resetProvider();
  clearQueryEmbeddingCache();
});

afterAll(async () => {
  await pool.end();
});

describe("MCP scoped reads over the acceptance library", () => {
  it("list_albums returns only the token's organization's albums with counts", async () => {
    const a = await listAlbums(L.orgA);
    expect(a.map((x) => x.id).sort()).toEqual([L.albums.nationals, L.albums.spring, L.albums.practice].sort());
    expect(a.reduce((n, x) => n + x.photoCount, 0)).toBe(L.photosA.filter((p) => !p.hidden).length); // hidden photos are not counted
    const b = await listAlbums(L.orgB);
    expect(b.map((x) => x.id)).toEqual([L.albums.nationalsB]);
  });

  it("search_photos ranks like the web and never returns hidden or foreign photos", async () => {
    const r = await searchPhotos({ query: "archer at full draw", count: 40, organizationId: L.orgA });
    expect(r.results.map((p) => p.id)).toEqual(order((p) => !p.hidden).slice(0, 40));
    const foreign = new Set(L.photosB.map((p) => p.id));
    expect(r.results.some((p) => foreign.has(p.id))).toBe(false);
    const b = await searchPhotos({ query: "archer", count: 40, organizationId: L.orgB });
    expect(b.results.map((p) => p.id).sort((x, y) => x - y)).toEqual(L.photosB.map((p) => p.id).sort((x, y) => x - y));
  });

  it("search_photos filters (minRating, minQuality, rightsTag, person) apply before the count limit", async () => {
    const r = await searchPhotos({ query: "archer", count: 200, minRating: 4, organizationId: L.orgA });
    expect(r.results.map((p) => p.id)).toEqual(order((p) => !p.hidden && p.rating >= 4));
    const rights = await searchPhotos({ query: "archer", count: 200, rightsTag: "sponsor ok", person: "jane archer", organizationId: L.orgA });
    expect(rights.results.map((p) => p.id)).toEqual(order((p) => !p.hidden && p.rights.includes("Sponsor OK") && p.people.includes("Jane Archer")));
    const q = await searchPhotos({ query: "archer", count: 200, minQuality: 7, organizationId: L.orgA });
    expect(q.results.length).toBeGreaterThan(0);
    expect(q.results.every((p) => (p.aiScore ?? 0) >= 7)).toBe(true);
  });

  it("an unknown name is an explicit note listing only the org's own names", async () => {
    const r = await searchPhotos({ query: "archer", count: 5, person: "Nobody", organizationId: L.orgA });
    expect(r.results).toEqual([]);
    expect(r.note).toContain("Jane Archer");
    expect(r.note).toContain("Sam Rivera");
    expect((await listUsageRights(L.orgB)).map((t) => t.name)).toEqual(["Sponsor OK"]);
    expect((await listPeople(L.orgB)).map((p) => p.name)).toEqual(["Jane Archer"]);
  });

  it("search_photos reports a provider failure as unavailable, not as an empty library", async () => {
    providerControl.mode = "timeout";
    const r = await searchPhotos({ query: "archer", count: 10, organizationId: L.orgA });
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/unavailable/i);
  });

  it("get_photo is scoped: own photo resolves (stable id, rights, quality), another org's does not", async () => {
    const mine = L.photosA.find((p) => p.rights.includes("Sponsor OK") && p.quality != null && !p.hidden)!;
    const d = await getPhotoDetail(mine.id, L.orgA);
    expect(d?.photo).toMatchObject({ id: mine.id, filename: mine.filename, albumTitle: mine.albumTitle, aiScore: mine.quality });
    expect(d?.photo.rights).toContain("Sponsor OK");
    expect(await getPhotoDetail(L.photosB[0].id, L.orgA)).toBeNull();
    expect(await getPhotoDetail(mine.id, L.orgB)).toBeNull();
  });

  it("list_assets returns the org's primary logo and project logos, scoped", async () => {
    const own = await listAssets({ kind: "brand", organizationId: L.orgA });
    expect(own.assets.filter((a) => a.isPrimary && a.projectName == null).map((a) => a.name)).toEqual(["Acceptance Logo"]);
    expect(own.assets.some((a) => a.name === "B Logo")).toBe(false);
    const proj = await listAssets({ kind: "brand", project: "spring open campaign", organizationId: L.orgA });
    // A project listing includes the project's assets plus org-wide ones; both primaries are marked.
    expect(proj.assets.filter((a) => a.isPrimary).map((a) => a.name).sort()).toEqual(["Acceptance Logo", "Spring Open Logo"]);
    expect((await listAssets({ kind: "brand", organizationId: L.orgB })).assets.map((a) => a.name)).toEqual(["B Logo"]);
  });
});
