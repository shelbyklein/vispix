import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The Photos page filters (GET /photos), pinned against a small fixture so the
// move to the shared SQL predicates (#205 FILTER-04) keeps every filter's
// meaning: search, tag, rating, dates, uploader, album, AI status, rights,
// hidden visibility, tenant scope and paging.
vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-auth-user");
        return id ? { user: { id, email: id, name: id, emailVerified: true } } : null;
      },
    },
    handler: async () => new Response(null, { status: 404 }),
  },
}));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, photosTable, tagsTable, collectionTagsTable, attributionTagsTable, photoAttributionTagsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, ratePhoto, addAiEvent, createCollection, addPhotoToCollection } from "./testDb";

let server: Server;
let baseUrl: string;
let orgId: number;
let admin: { id: number; authUserId: string };
let bob: { id: number; authUserId: string };
let nationalsId: number;
let sponsorTagId: number;
const P: Record<string, number> = {};

beforeAll(async () => {
  await resetDb();
  admin = await createUser({ name: "Alice Admin", role: "admin" });
  bob = await createUser({ name: "Bob Member" });
  orgId = (await createOrganization({ name: "Library Org" })).id;
  const orgB = (await createOrganization({ name: "Other" })).id;
  await addOrganizationMember(orgId, admin.id, "owner");
  await addOrganizationMember(orgId, bob.id, "member");
  const spring = await createAlbum(admin.id, "Spring Open", orgId);
  const nationals = await createAlbum(admin.id, "Nationals", orgId);
  nationalsId = nationals.id;
  const other = await createAlbum(admin.id, "Elsewhere", orgB);
  const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
  const add = async (key: string, album: number, uploader: number, n: number, o: { desc?: string | null; takenAt?: string; hidden?: boolean; org?: number } = {}) => {
    const p = await createPhoto(album, uploader, { organizationId: o.org ?? orgId, aiDescription: o.desc ?? null, isHidden: o.hidden ?? false, createdAt: t(n) });
    if (o.takenAt) await db.update(photosTable).set({ takenAt: new Date(o.takenAt) }).where(eq(photosTable.id, p.id));
    P[key] = p.id;
  };
  await add("p1", spring.id, admin.id, 1, { desc: "archer at full draw", takenAt: "2026-03-10T15:00:00Z" });
  await add("p2", spring.id, bob.id, 2, { desc: "crowd at the finals", takenAt: "2026-03-11T09:00:00Z" });
  await add("p3", nationals.id, admin.id, 3);
  await add("p4", nationals.id, bob.id, 4, { desc: "coach and archer", takenAt: "2026-04-01T12:00:00Z" });
  await add("p5", nationals.id, admin.id, 5, { desc: "team photo", hidden: true });
  await add("p6", other.id, admin.id, 6, { desc: "archer elsewhere", org: orgB });

  await ratePhoto(P.p1, admin.id, 5);
  await ratePhoto(P.p2, admin.id, 2);
  await ratePhoto(P.p4, admin.id, 4);
  await addAiEvent(P.p1, "success");
  await addAiEvent(P.p2, "failed");
  await addAiEvent(P.p4, "success", { createdAt: new Date("2026-01-01") });
  await addAiEvent(P.p4, "failed", { createdAt: new Date("2026-02-01") });

  const hero = await createCollection(admin.id, "Hero", orgId);
  await addPhotoToCollection(hero.id, P.p3);
  const [featured] = await db.insert(tagsTable).values({ name: "featured" }).returning();
  await db.insert(collectionTagsTable).values({ collectionId: hero.id, tagId: featured.id });

  const [sponsor] = await db.insert(attributionTagsTable).values({ organizationId: orgId, name: "Sponsor" }).returning();
  sponsorTagId = sponsor.id;
  await db.insert(photoAttributionTagsTable).values([{ photoId: P.p1, tagId: sponsor.id }, { photoId: P.p4, tagId: sponsor.id }]);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function photos(params: Record<string, string | number>, as = bob) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${baseUrl}/photos?${qs}`, { headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgId) } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { photos: { id: number }[]; hasMore: boolean };
  return { ids: body.photos.map((p) => p.id), hasMore: body.hasMore };
}
const ids = (...keys: string[]) => keys.map((k) => P[k]);

describe("Photos page filters (GET /photos)", () => {
  it.each([
    ["no filters: this org, visible, newest first", {}, ["p4", "p3", "p2", "p1"]],
    ["search an album title", { search: "spring" }, ["p2", "p1"]],
    ["search an uploader", { search: "bob" }, ["p4", "p2"]],
    ["search any description word", { search: "archer finals" }, ["p4", "p2", "p1"]],
    ["collection tag", { tag: "Featured" }, ["p3"]],
    ["unknown tag", { tag: "nope" }, []],
    ["minimum rating (unrated = 0)", { ratingMin: 4 }, ["p4", "p1"]],
    ["maximum rating (unrated = 0)", { ratingMax: 2 }, ["p3", "p2"]],
    ["capture date range, whole days", { dateFrom: "2026-03-10", dateTo: "2026-03-11" }, ["p2", "p1"]],
    ["uploader", { uploaderId: "admin" }, ["p3", "p1"]],
    ["album", { albumId: "nationals" }, ["p4", "p3"]],
    ["AI: has a description", { aiStatus: "has_description" }, ["p4", "p2", "p1"]],
    ["AI: never analysed", { aiStatus: "not_analysed" }, ["p3"]],
    ["AI: latest analysis failed", { aiStatus: "failed" }, ["p4", "p2"]],
    ["rights tag", { attributionTagId: "sponsor" }, ["p4", "p1"]],
    ["no rights tag", { hasAttribution: "false" }, ["p3", "p2"]],
    ["some rights tag", { hasAttribution: "true" }, ["p4", "p1"]],
    ["combined", { search: "archer", ratingMin: 4, albumId: "nationals" }, ["p4"]],
  ])("%s", async (_label, raw, expected) => {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(raw)) {
      params[k] = v === "admin" ? admin.id : v === "nationals" ? nationalsId : v === "sponsor" ? sponsorTagId : v;
    }
    expect((await photos(params)).ids).toEqual(ids(...expected));
  });

  it("shows hidden photos only to an admin who asks", async () => {
    expect((await photos({ includeHidden: "true" }, admin)).ids).toEqual(ids("p5", "p4", "p3", "p2", "p1"));
    expect((await photos({ includeHidden: "true" }, bob)).ids).toEqual(ids("p4", "p3", "p2", "p1"));
  });

  it("pages in order", async () => {
    expect(await photos({ limit: 2, offset: 1 })).toEqual({ ids: ids("p3", "p2"), hasMore: true });
    expect(await photos({ limit: 2, offset: 2 })).toEqual({ ids: ids("p2", "p1"), hasMore: false });
  });
});
