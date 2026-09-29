import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Photo details Previous/Next (#210). Auth mocked as in the org isolation suite.
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

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, photosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, ratePhoto } from "./testDb";

let server: Server;
let baseUrl: string;
let admin: { id: number; authUserId: string };
let member: { id: number; authUserId: string };
let orgId: number;
let bigAlbumId: number;
let smallAlbumId: number;
let otherOrgPhotoId: number;
// The big album's visible photos in album order (created_at DESC, id DESC).
let order: number[] = [];
let hiddenId: number;
let rated = new Set<number>();

const T0 = Date.parse("2026-05-01T12:00:00Z");

beforeAll(async () => {
  await resetDb();
  const org = await createOrganization({ name: "Nav Org", slug: "nav-org" });
  const orgB = await createOrganization({ name: "Nav Other", slug: "nav-other" });
  orgId = org.id;
  admin = await createUser({ name: "Ada", role: "admin" });
  member = await createUser({ name: "Milo", role: "member" });
  await addOrganizationMember(org.id, admin.id, "owner");
  await addOrganizationMember(org.id, member.id, "member");
  await addOrganizationMember(orgB.id, admin.id, "owner");
  const big = await createAlbum(admin.id, "Nationals", org.id);
  const small = await createAlbum(admin.id, "Small", org.id);
  const other = await createAlbum(admin.id, "Other org", orgB.id);
  bigAlbumId = big.id;
  smallAlbumId = small.id;

  // 130 photos, one minute apart; photos 40–42 share one timestamp (a tie,
  // broken by id DESC); photo 60 is hidden; every third photo is rated.
  const rows: { id: number; createdAt: number; hidden: boolean }[] = [];
  for (let i = 0; i < 130; i++) {
    const createdAt = i >= 40 && i <= 42 ? T0 - 40 * 60_000 : T0 - i * 60_000;
    const hidden = i === 60;
    const p = await createPhoto(big.id, admin.id, { organizationId: org.id, createdAt: new Date(createdAt), isHidden: hidden });
    rows.push({ id: p.id, createdAt, hidden });
    if (hidden) hiddenId = p.id;
    if (i % 3 === 0) {
      await ratePhoto(p.id, member.id, 4);
      rated.add(p.id);
    }
  }
  order = rows
    .filter((r) => !r.hidden)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
    .map((r) => r.id);
  await createPhoto(small.id, admin.id, { organizationId: org.id });
  otherOrgPhotoId = (await createPhoto(other.id, admin.id, { organizationId: orgB.id })).id;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function get(path: string, as = admin): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgId) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const neighbors = (id: number, qs = "", as = admin) => get(`/api/photos/${id}/neighbors${qs ? `?${qs}` : ""}`, as);

describe("neighbour fixture: 130-photo album (TT-VPX-NAV-01)", () => {
  it("the album page's own paging returns the documented order (created_at DESC, id DESC)", async () => {
    const pages: number[] = [];
    for (const offset of [0, 50, 100]) {
      const r = await get(`/api/albums/${bigAlbumId}/photos?limit=50&offset=${offset}`);
      pages.push(...r.body.photos.map((p: { id: number }) => p.id));
    }
    expect(pages).toEqual(order);
  });

  it.each([0, 1, 41, 49, 50, 75, 100, 128])("resolves neighbours for position %i, including beyond the first page", async (idx) => {
    const r = await neighbors(order[idx]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      albumId: bigAlbumId,
      inContext: true,
      previousId: idx > 0 ? order[idx - 1] : null,
      nextId: idx < order.length - 1 ? order[idx + 1] : null,
      position: idx + 1,
      total: order.length,
    });
  });
});

describe("boundaries, visibility and mutation (TT-VPX-NAV-04)", () => {
  it("follows the album view's filters", async () => {
    const ratedOrder = order.filter((id) => rated.has(id));
    const idx = 20; // well past the first page of the filtered view
    const r = await neighbors(ratedOrder[idx], `albumId=${bigAlbumId}&hasRating=true`);
    expect(r.body).toMatchObject({ inContext: true, previousId: ratedOrder[idx - 1], nextId: ratedOrder[idx + 1], position: idx + 1, total: ratedOrder.length });
    // An unrated photo isn't part of that view: explicit, not a wrong neighbour.
    const unrated = order.find((id) => !rated.has(id))!;
    expect((await neighbors(unrated, `albumId=${bigAlbumId}&hasRating=true`)).body).toMatchObject({ inContext: false, previousId: null, nextId: null, position: null });
  });

  it("skips hidden photos for members and hides a hidden photo's page from them", async () => {
    const r = await neighbors(order[58], "", member);
    expect(r.body).toMatchObject({ previousId: order[57], nextId: order[59], total: order.length });
    expect((await neighbors(hiddenId, "", member)).status).toBe(404);
  });

  it("includes hidden photos for admins who ask, and for an admin viewing a hidden photo", async () => {
    const all = await get(`/api/photos/${hiddenId}/neighbors`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ inContext: true, total: order.length + 1 });
    // The hidden photo (created 60th) sits between visible order[59] and order[60].
    const withHidden = await neighbors(order[59], "includeHidden=true");
    expect(withHidden.body.nextId).toBe(hiddenId);
    // A member asking for hidden photos doesn't get them.
    expect((await neighbors(order[59], "includeHidden=true", member)).body.nextId).toBe(order[60]);
  });

  it("recovers when a neighbour is deleted", async () => {
    const idx = 90;
    const before = await neighbors(order[idx]);
    expect(before.body.nextId).toBe(order[idx + 1]);
    await db.delete(photosTable).where(eq(photosTable.id, order[idx + 1]));
    const after = await neighbors(order[idx]);
    expect(after.body).toMatchObject({ nextId: order[idx + 2], total: order.length - 1 });
    order.splice(idx + 1, 1);
  });

  it("answers explicitly for a photo outside the requested album", async () => {
    const r = await neighbors(order[10], `albumId=${smallAlbumId}`);
    expect(r.body).toMatchObject({ albumId: smallAlbumId, inContext: false, previousId: null, nextId: null, position: null, total: 1 });
  });

  it("never exposes another organization's photo", async () => {
    expect((await neighbors(otherOrgPhotoId)).status).toBe(404);
  });

  it("rejects malformed ids", async () => {
    expect((await get(`/api/photos/abc/neighbors`)).status).toBe(400);
    expect((await neighbors(order[0], "albumId=xyz")).status).toBe(400);
  });
});
