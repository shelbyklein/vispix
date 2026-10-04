import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Structured MCP read tools (#214, MCP-02) over the shared acceptance fixture.
//
// EVIDENCE CLASS: a real MCP client and server joined by the SDK's in-memory
// transport (so tool listing, outputSchema validation and structuredContent
// travel the protocol), real Postgres + pgvector, MOCKED query embedding and
// MOCKED thumbnail bytes. It is not the HTTP gateway, a real token, or real
// storage (those stay separate acceptance evidence; see docs/MCP_TOOLS.md).
// An unreachable emulator endpoint: URL signing works offline (ephemeral key),
// and nothing here ever fetches bytes.
vi.hoisted(() => {
  process.env.GCS_ENDPOINT = "http://127.0.0.1:1";
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
});
vi.mock("@workspace/api-server/src/lib/aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-server/src/lib/aiEmbedding")>()),
  embedQuery: async (q: string) =>
    (await import("@workspace/api-server/src/lib/__tests__/fixtures/acceptanceLibrary")).stubEmbedQuery(q),
}));
vi.mock("../photoLibrary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../photoLibrary.js")>()),
  loadThumbnailImage: async () => ({ base64: "AAAA", mimeType: "image/jpeg" }),
}));

import { db, pool, photosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb } from "@workspace/api-server/src/lib/__tests__/testDb";
import { clearQueryEmbeddingCache, CONCEPT_QUALITY_WEIGHT, NEUTRAL_QUALITY_SCORE, retrievePhotos } from "@workspace/api-server/src/lib/photoRetrieval";
import {
  buildAcceptanceLibrary,
  expectedConceptOrder,
  providerControl,
  resetProvider,
  type AcceptanceLibrary,
} from "@workspace/api-server/src/lib/__tests__/fixtures/acceptanceLibrary";
import { createServer } from "../server";
import { createMediaLinkIssuer, credentialFingerprint, resolveMediaGrantKeys } from "../mediaGrants";
import {
  TOOL_SCHEMA_VERSION,
  getAssetOutput,
  getPhotoOutput,
  listAlbumsOutput,
  listAssetsOutput,
  listPeopleOutput,
  listUsageRightsOutput,
  searchPhotosOutput,
} from "../structured";

let L: AcceptanceLibrary;
const T0 = Date.parse("2026-10-01T00:00:00Z");

async function connect(organizationId: number, withGrants = true): Promise<Client> {
  const mediaLinks = withGrants
    ? createMediaLinkIssuer({
        publicUrl: "https://mcp.test",
        organizationId,
        parent: { type: "env", fingerprint: credentialFingerprint("test-token") },
        keys: resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "k".repeat(40) }),
        nowMs: T0,
      })
    : undefined;
  const server = createServer({ organizationId, mediaLinks });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "structured-test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Result = {
  isError?: boolean;
  content: { type: string; text?: string; uri?: string; mimeType?: string }[];
  structuredContent?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- shapes are validated with zod below
};
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}
const text = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const parse = <T extends z.ZodRawShape>(shape: T, r: Result) => z.object(shape).parse(r.structuredContent);

let A: Client;
let B: Client;

beforeAll(async () => {
  await resetDb();
  L = await buildAcceptanceLibrary();
  for (const p of L.photosA) await db.update(photosTable).set({ thumbnailKey: `/objects/orgs/${L.orgA}/thumbs/${p.id}` }).where(eq(photosTable.id, p.id));
  A = await connect(L.orgA);
  B = await connect(L.orgB);
}, 120_000);

beforeEach(() => {
  resetProvider();
  clearQueryEmbeddingCache();
});

afterAll(async () => {
  await pool.end();
});

describe("tool surface", () => {
  it("advertises an output schema for every read tool, keeping the existing names", async () => {
    const { tools } = await A.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_asset", "get_photo", "list_albums", "list_assets", "list_people", "list_usage_rights", "search_photos"],
    );
    for (const t of tools) expect(t.outputSchema, t.name).toBeTruthy();
  });
});

describe("search_photos", () => {
  it("returns validated structured results alongside the readable text", async () => {
    const r = await call(A, "search_photos", { query: "archer", count: 5, includeImages: false });
    const out = parse(searchPhotosOutput, r);
    expect(out.schemaVersion).toBe(TOOL_SCHEMA_VERSION);
    expect(out.status).toBe("ok");
    expect(out.results).toHaveLength(5);
    const first = out.results[0];
    expect(first).toMatchObject({ filename: expect.any(String), albumTitle: expect.any(String), rating: expect.any(Object), quality: expect.any(Object) });
    expect(first.match?.type).toBe("concept");
    expect(out.retrieval).toMatchObject({ version: "photo-retrieval/1", mode: "concept" });
    expect(out.page).toMatchObject({ returned: 5, exhausted: false });
    expect(out.page.nextCursor).toBeTruthy();
    // Text fallback is still there and names the same photos and the cursor.
    const t = text(r);
    expect(t).toContain(`photo #${first.id}`);
    expect(t).toContain(`next page cursor: ${out.page.nextCursor}`);
    // Thumbnail media grant: MIME type, expiry and filename travel with the id.
    expect(first.thumbnail).toMatchObject({ kind: "thumbnail", mimeType: "image/jpeg", grant: "gateway_media_grant", expiresAt: "2026-10-01T01:00:00Z" });
    expect(first.thumbnail?.url).toMatch(/^https:\/\/mcp\.test\/media\//);
  });

  it("pages with the cursor without gaps or duplicates and matches the unpaged order", async () => {
    const expected = expectedConceptOrder(L.photosA, CONCEPT_QUALITY_WEIGHT, NEUTRAL_QUALITY_SCORE, (p) => !p.hidden);
    const ids: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call(A, "search_photos", { query: "archer", count: 13, cursor, includeImages: false });
      const out = parse(searchPhotosOutput, r);
      ids.push(...out.results.map((p) => p.id));
      cursor = out.page.nextCursor ?? undefined;
      pages++;
      if (!cursor) expect(out.page.exhausted).toBe(true);
    } while (cursor && pages < 30);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expected);
    expect(pages).toBeGreaterThan(5);
  });

  it("exact filename lookup (any case, any extension) returns the photo first, tagged exact", async () => {
    const target = L.photosA.find((p) => p.filename === "Fri-pm (146).webp")!;
    const r = await call(A, "search_photos", { query: "fri-pm (146).JPG", mode: "combined", count: 5, includeImages: false });
    const out = parse(searchPhotosOutput, r);
    expect(out.results[0].id).toBe(target.id);
    expect(out.results[0].match).toEqual({ type: "exact", fields: ["filename"] });
    expect(text(r)).toContain("EXACT match");
    // Repeated names across albums all match.
    const dup = await call(A, "search_photos", { query: "dup-name", mode: "keyword", count: 10, includeImages: false });
    expect(parse(searchPhotosOutput, dup).results.filter((p) => p.match?.type === "exact")).toHaveLength(3);
  });

  it("exact id lookup finds the photo; another organization's id finds nothing", async () => {
    const mine = L.photosA.find((p) => !p.hidden)!;
    const hit = parse(searchPhotosOutput, await call(A, "search_photos", { query: `#${mine.id}`, mode: "combined", count: 3, includeImages: false }));
    expect(hit.results[0]).toMatchObject({ id: mine.id, match: { type: "exact", fields: ["photo_id"] } });
    const foreign = L.photosB[0];
    const miss = parse(searchPhotosOutput, await call(A, "search_photos", { query: `#${foreign.id}`, mode: "keyword", count: 3, includeImages: false }));
    expect(miss.results.some((p) => p.id === foreign.id)).toBe(false);
  });

  it("a malformed or foreign cursor is an explicit error, not a silent restart", async () => {
    const first = parse(searchPhotosOutput, await call(A, "search_photos", { query: "archer", count: 3, includeImages: false }));
    const bad = await call(A, "search_photos", { query: "archer", count: 3, cursor: "not-a-cursor", includeImages: false });
    expect(bad.isError).toBe(true);
    expect(parse(searchPhotosOutput, bad).error?.code).toBe("invalid_cursor");
    const mismatch = await call(A, "search_photos", { query: "something else", count: 3, cursor: first.page.nextCursor, includeImages: false });
    expect(mismatch.isError).toBe(true);
    expect(parse(searchPhotosOutput, mismatch).error?.code).toBe("cursor_mismatch");
    expect(text(mismatch)).toContain("cursor_mismatch");
  });

  it("provider failure is explicit unavailable status, not an empty library", async () => {
    providerControl.mode = "timeout";
    const r = await call(A, "search_photos", { query: "archer", includeImages: false });
    const out = parse(searchPhotosOutput, r);
    expect(out.status).toBe("unavailable");
    expect(out.results).toEqual([]);
    expect(out.degraded).toEqual({ reason: "timeout", affects: "query" });
    expect(text(r)).toMatch(/unavailable/i);
    // combined mode keeps literal matches visible and says concept is degraded.
    clearQueryEmbeddingCache();
    const target = L.photosA.find((p) => p.filename === "IMG_0013.jpg")!;
    const c = parse(searchPhotosOutput, await call(A, "search_photos", { query: "IMG_0013", mode: "combined", includeImages: false }));
    expect(c.status).toBe("ok");
    expect(c.degraded).toMatchObject({ affects: "concept" });
    expect(c.results.map((p) => p.id)).toContain(target.id);
  });

  it("unknown filter names are an explicit invalid_request listing only the org's own names", async () => {
    const r = await call(A, "search_photos", { query: "archer", person: "Nobody", includeImages: false });
    const out = parse(searchPhotosOutput, r);
    expect(out.status).toBe("invalid_request");
    expect(out.error?.code).toBe("unknown_filter_value");
    expect(out.error?.message).toContain("Jane Archer");
  });

  it("includeImages is optional and bounded by count", async () => {
    const images = (r: Result) => r.content.filter((c) => c.type === "image").length;
    const none = await call(A, "search_photos", { query: "archer", count: 15, includeImages: false });
    expect(images(none)).toBe(0);
    expect(parse(searchPhotosOutput, none).images).toMatchObject({ requested: false, included: 0 });

    const def = await call(A, "search_photos", { query: "archer", count: 15 });
    expect(images(def)).toBe(10);
    expect(parse(searchPhotosOutput, def).images).toMatchObject({ requested: true, included: 10, omitted: 5, maxImages: 10 });
    // The thumbnail links for the rest are still there.
    expect(parse(searchPhotosOutput, def).results.every((p) => p.thumbnail)).toBe(true);

    const three = await call(A, "search_photos", { query: "archer", count: 15, maxImages: 3 });
    expect(images(three)).toBe(3);
    // The schema itself refuses a cap above the hard limit.
    const over = await call(A, "search_photos", { query: "archer", maxImages: 11 });
    expect(over.isError).toBe(true);
    expect(text(over)).toMatch(/maxImages/);
  });
});

describe("get_photo", () => {
  it("returns detail with original and thumbnail grants (MIME, expiry, size)", async () => {
    const p = L.photosA.find((x) => !x.hidden && x.rights.length > 0 && x.quality != null)!;
    const r = await call(A, "get_photo", { id: p.id });
    const out = parse(getPhotoOutput, r);
    expect(out.status).toBe("ok");
    expect(out.photo).toMatchObject({ id: p.id, filename: p.filename, albumTitle: p.albumTitle });
    expect(out.photo?.rights).toEqual(expect.arrayContaining(p.rights));
    expect(out.photo?.quality.score).toBe(p.quality);
    expect(out.photo?.original).toMatchObject({ kind: "original", grant: "gateway_media_grant", expiresAt: "2026-10-01T01:00:00Z" });
    expect(out.photo?.original?.mimeType).toMatch(/^(image\/|application\/octet-stream)/);
    expect(out.photo?.thumbnail?.mimeType).toBe("image/jpeg");
    expect(text(r)).toContain(`photo #${p.id}`);
    expect(out.images).toMatchObject({ requested: true, included: 1 });
  });

  it("includeImages false suppresses the inline image", async () => {
    const p = L.photosA.find((x) => !x.hidden)!;
    const r = await call(A, "get_photo", { id: p.id, includeImages: false });
    expect(r.content.some((c) => c.type === "image")).toBe(false);
    expect(parse(getPhotoOutput, r).images).toMatchObject({ requested: false, included: 0 });
  });

  it("another organization's id is not_found, indistinguishable from a missing id", async () => {
    const foreign = await call(A, "get_photo", { id: L.photosB[0].id });
    const missing = await call(A, "get_photo", { id: 2_000_000_000 });
    for (const r of [foreign, missing]) {
      expect(r.isError).toBe(true);
      const out = parse(getPhotoOutput, r);
      expect(out).toMatchObject({ status: "not_found", photo: null, error: { code: "not_found" } });
      expect(text(r)).not.toMatch(/hidden|forbidden|organization/i);
    }
    expect(parse(getPhotoOutput, foreign).error?.message.replace(/#\d+/, "#")).toBe(parse(getPhotoOutput, missing).error?.message.replace(/#\d+/, "#"));
  });

  it("a hidden photo in the caller's own organization reads exactly like a missing one", async () => {
    const hidden = L.photosA.find((x) => x.hidden)!;
    const r = await call(A, "get_photo", { id: hidden.id });
    const missing = await call(A, "get_photo", { id: 2_000_000_000 });
    expect(r.isError).toBe(true);
    expect(parse(getPhotoOutput, r)).toMatchObject({ status: "not_found", photo: null, error: { code: "not_found" } });
    expect(text(r)).not.toMatch(/hidden|forbidden/i);
    expect(parse(getPhotoOutput, r).error?.message.replace(/#\d+/, "#")).toBe(parse(getPhotoOutput, missing).error?.message.replace(/#\d+/, "#"));
  });
});

describe("usage rights (#207)", () => {
  it("get_photo states not_recorded explicitly for an untagged photo and recorded for a tagged one", async () => {
    const untagged = L.photosA.find((p) => p.rights.length === 0 && !p.hidden)!;
    const tagged = L.photosA.find((p) => p.rights.length > 0 && !p.hidden)!;
    const u = await call(A, "get_photo", { id: untagged.id, includeImages: false });
    const t = await call(A, "get_photo", { id: tagged.id, includeImages: false });
    expect(parse(getPhotoOutput, u).photo).toMatchObject({ rights: [], rightsStatus: "not_recorded" });
    expect(text(u)).toMatch(/not recorded/);
    expect(parse(getPhotoOutput, t).photo).toMatchObject({ rightsStatus: "recorded" });
    expect(text(t)).not.toMatch(/cleared/i);
  });

  it("search results carry rightsStatus and don't hide photos whose rights aren't recorded", async () => {
    const out = parse(searchPhotosOutput, await call(A, "search_photos", { query: "Nationals", mode: "keyword", count: 50, includeImages: false }));
    expect(out.results.length).toBeGreaterThan(10);
    for (const r of out.results) expect(r.rightsStatus).toBe(r.rights.length > 0 ? "recorded" : "not_recorded");
    expect(out.results.some((r) => r.rightsStatus === "not_recorded")).toBe(true); // warning-only: not filtered out
  });

  it("the same intended-use query yields the same permitted photos on the web and through MCP", async () => {
    const mcp = parse(searchPhotosOutput, await call(A, "search_photos", { query: "Nationals", mode: "keyword", rightsTag: "Sponsor OK", count: 50, includeImages: false }));
    const web = await retrievePhotos({ organizationId: L.orgA, canSeeHidden: false, text: "Nationals", mode: "keyword", limit: 50, filters: { rightsTagId: L.tags.sponsorA } });
    expect(web.items.length).toBeGreaterThan(3); // a real comparison, not empty vs empty
    expect(mcp.results.map((r) => r.id)).toEqual(web.items.map((i) => i.photoId));
    expect(mcp.results.every((r) => r.rights.includes("Sponsor OK") && r.rightsStatus === "recorded")).toBe(true);
  });
});

describe("list tools", () => {
  it("list_albums / list_people / list_usage_rights carry stable ids and a complete page", async () => {
    const albums = parse(listAlbumsOutput, await call(A, "list_albums"));
    expect(albums.items.map((a) => a.id).sort()).toEqual([L.albums.nationals, L.albums.spring, L.albums.practice].sort());
    expect(albums.page).toMatchObject({ nextCursor: null, exhausted: true, total: 3 });
    const people = parse(listPeopleOutput, await call(A, "list_people"));
    expect(people.items.map((p) => p.id).sort()).toEqual([L.people.janeA, L.people.samA].sort());
    const rights = parse(listUsageRightsOutput, await call(A, "list_usage_rights"));
    expect(rights.items.map((t) => t.id).sort()).toEqual([L.tags.sponsorA, L.tags.editorialA].sort());
    // Org B sees only its own; text fallback unchanged.
    const bAlbums = await call(B, "list_albums");
    expect(parse(listAlbumsOutput, bAlbums).items.map((a) => a.id)).toEqual([L.albums.nationalsB]);
    expect(text(bAlbums)).toContain("photos");
  });

  it("list_assets pages by cursor without gaps or duplicates, and filters exactly", async () => {
    const all = parse(listAssetsOutput, await call(A, "list_assets", { limit: 100 }));
    expect(all.items.length).toBe(8);
    expect(all.page).toMatchObject({ nextCursor: null, exhausted: true });
    const ids: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = parse(listAssetsOutput, await call(A, "list_assets", { limit: 3, cursor }));
      ids.push(...out.items.map((a) => a.id));
      cursor = out.page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(ids).toEqual(all.items.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(L.assets["B Logo"]);

    const exact = parse(listAssetsOutput, await call(A, "list_assets", { name: "acceptance logo" }));
    expect(exact.items.map((a) => a.name)).toEqual(["Acceptance Logo"]);
    expect(exact.items[0]).toMatchObject({ isPrimary: true, mimeType: "image/png" });
    const text1 = await call(A, "list_assets", { kind: "reference" });
    expect(text(text1)).toContain("Last Year Poster");

    // A cursor can't be replayed against different filters.
    const first = parse(listAssetsOutput, await call(A, "list_assets", { limit: 2 }));
    const bad = await call(A, "list_assets", { limit: 2, kind: "reference", cursor: first.page.nextCursor });
    expect(bad.isError).toBe(true);
    expect(parse(listAssetsOutput, bad).error?.code).toBe("cursor_mismatch");
    const junk = await call(A, "list_assets", { cursor: "zzz" });
    expect(parse(listAssetsOutput, junk).error?.code).toBe("invalid_cursor");
  });
});

describe("get_asset", () => {
  it("returns metadata and an expiring original grant with MIME type and size", async () => {
    const id = L.assets["Acceptance Logo"];
    const r = await call(A, "get_asset", { id, includeImages: false });
    const out = parse(getAssetOutput, r);
    expect(out.status).toBe("ok");
    expect(out.asset).toMatchObject({ id, name: "Acceptance Logo", variant: "primary", isPrimary: true, mimeType: "image/png" });
    expect(out.asset?.original).toMatchObject({ kind: "original", mimeType: "image/png", grant: "gateway_media_grant", expiresAt: "2026-10-01T01:00:00Z" });
    expect(text(r)).toContain(`asset #${id}`);
  });

  it("another organization's asset is not_found", async () => {
    const r = await call(A, "get_asset", { id: L.assets["B Logo"] });
    expect(r.isError).toBe(true);
    expect(parse(getAssetOutput, r)).toMatchObject({ status: "not_found", asset: null, error: { code: "not_found" } });
  });
});

describe("stdio mode (no media grants)", () => {
  it("still returns structured results; links are signed storage URLs with an expiry", async () => {
    const S = await connect(L.orgA, false);
    const r = await call(S, "get_asset", { id: L.assets["Acceptance Logo"], includeImages: false });
    const out = parse(getAssetOutput, r);
    expect(out.asset?.original?.grant).toBe("signed_storage_url");
    expect(out.asset?.original?.expiresAt).toBeTruthy();
    const s = parse(searchPhotosOutput, await call(S, "search_photos", { query: "archer", count: 2, includeImages: false }));
    expect(s.results[0].thumbnail).toBeNull();
  });
});
