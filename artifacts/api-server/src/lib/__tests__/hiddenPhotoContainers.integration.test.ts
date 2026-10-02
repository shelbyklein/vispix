import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Hidden photos stay hidden inside every photo container (#218): org
// owners/admins see them, members never do. Members can't add a hidden photo
// to a project/collection, use it as a cover or generation input, or read one
// back through a container, count, cover, stats list or duplicate check.
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
// Provider boundary only: no real image bytes, model call or storage.
vi.mock("../aiPhotoAnalysis", async (o) => ({
  ...(await o<typeof import("../aiPhotoAnalysis")>()),
  resolveImageForAI: async () => ({ dataUrl: "data:image/png;base64,AA==" }),
}));
vi.mock("../imageGeneration/openaiImage", () => ({
  generateImage: async () => {
    throw new Error("provider disabled in tests");
  },
}));
vi.mock("../aiProviders", async (o) => ({
  ...(await o<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => ({ apiKey: "test-key", baseURL: null }),
}));

import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import app from "../../app";
import { db, pool, albumsTable, collectionsTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, createProject, createCollection, addPhotoToProject, addPhotoToCollection, ratePhoto } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let org: number;
let member: U;
let admin: U;
let hiddenId: number;
let visibleId: number;
let hiddenUrl: string;
let visibleUrl: string;
let albumId: number;

beforeAll(async () => {
  await resetDb();
  org = (await createOrganization({ name: "Hidden A" })).id;
  member = await createUser({ name: "member" });
  admin = await createUser({ name: "admin" });
  await addOrganizationMember(org, member.id, "member");
  await addOrganizationMember(org, admin.id, "admin");
  albumId = (await createAlbum(member.id, "Member album", org)).id;
  const hidden = await createPhoto(albumId, member.id, { organizationId: org, isHidden: true, filesize: 111 });
  const visible = await createPhoto(albumId, member.id, { organizationId: org, filesize: 222 });
  hiddenId = hidden.id;
  visibleId = visible.id;
  hiddenUrl = hidden.url;
  visibleUrl = visible.url;
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function call(as: U, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const ids = (photos: { id: number }[]) => photos.map((p) => p.id).sort((x, y) => x - y);

describe("projects", () => {
  it("blocks a member adding a hidden photo (404, same as a missing photo); a manager may", async () => {
    const mine = await createProject(member.id, "Member project", org);
    const blocked = await call(member, "POST", `/projects/${mine.id}/photos`, { photoId: hiddenId });
    const missing = await call(member, "POST", `/projects/${mine.id}/photos`, { photoId: 999999 });
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual(missing.body);
    expect((await call(member, "POST", `/projects/${mine.id}/photos`, { photoId: visibleId })).status).toBe(204);
    expect((await call(admin, "POST", `/projects/${mine.id}/photos`, { photoId: hiddenId })).status).toBe(204);
  });

  it("filters hidden photos from reads, counts and covers for members only", async () => {
    const p = await createProject(member.id, "Pre-existing hidden", org);
    await addPhotoToProject(p.id, hiddenId);
    const asMember = await call(member, "GET", `/projects/${p.id}`);
    expect(asMember.body.photos).toEqual([]);
    expect(asMember.body.photoCount).toBe(0);
    expect(asMember.body.coverPhotoUrl).toBeNull();
    const inList = (await call(member, "GET", "/projects")).body.find((x: { id: number }) => x.id === p.id);
    expect(inList.photoCount).toBe(0);
    expect(inList.coverPhotoUrl).toBeNull();
    const asAdmin = await call(admin, "GET", `/projects/${p.id}`);
    expect(ids(asAdmin.body.photos)).toEqual([hiddenId]);
    expect(asAdmin.body.photoCount).toBe(1);
    expect(asAdmin.body.coverPhotoUrl).toBe(hiddenUrl);
  });
});

describe("collections", () => {
  it("blocks members adding a hidden photo, or using it as a negative example or cover; managers may", async () => {
    const c = await createCollection(member.id, "Member collection", org);
    for (const [method, path, body] of [
      ["POST", `/collections/${c.id}/photos`, { photoId: hiddenId }],
      ["POST", `/collections/${c.id}/negative-photos`, { photoId: hiddenId }],
      ["PATCH", `/collections/${c.id}/cover`, { photoId: hiddenId }],
    ] as const) {
      const r = await call(member, method, path, body);
      expect(r.status, path).toBe(404);
      expect(r.body.error).toBe("Photo not found");
    }
    expect((await call(admin, "POST", `/collections/${c.id}/photos`, { photoId: hiddenId })).status).toBe(204);
    expect((await call(admin, "PATCH", `/collections/${c.id}/cover`, { photoId: hiddenId })).status).toBe(200);
  });

  it("filters hidden members, counts and covers from member reads (collections and People)", async () => {
    for (const kind of ["collection", "person"] as const) {
      const c = await createCollection(member.id, `Seeded ${kind}`, org);
      if (kind === "person") await db.update(collectionsTable).set({ kind: "person" }).where(eq(collectionsTable.id, c.id));
      await addPhotoToCollection(c.id, hiddenId);
      await addPhotoToCollection(c.id, visibleId);
      await db.update(collectionsTable).set({ coverPhotoId: hiddenId }).where(eq(collectionsTable.id, c.id));
      const asMember = await call(member, "GET", `/collections/${c.id}`);
      expect(ids(asMember.body.photos)).toEqual([visibleId]);
      expect(asMember.body.photoCount).toBe(1);
      expect(asMember.body.coverPhotoUrl).toBeNull();
      const row = (await call(member, "GET", `/collections?kind=${kind}`)).body.find((x: { id: number }) => x.id === c.id);
      expect(row.photoCount).toBe(1);
      expect(row.coverPhotoUrl).toBeNull();
      const asAdmin = await call(admin, "GET", `/collections/${c.id}`);
      expect(ids(asAdmin.body.photos)).toEqual([hiddenId, visibleId].sort((x, y) => x - y));
      expect(asAdmin.body.photoCount).toBe(2);
      expect(asAdmin.body.coverPhotoUrl).toBe(hiddenUrl);
    }
  });

  it("filters hidden photos from the negative-examples list", async () => {
    const c = await createCollection(member.id, "Negatives", org);
    expect((await call(admin, "POST", `/collections/${c.id}/negative-photos`, { photoId: hiddenId })).status).toBe(204);
    expect((await call(member, "GET", `/collections/${c.id}/negative-photos`)).body).toEqual([]);
    expect(ids((await call(admin, "GET", `/collections/${c.id}/negative-photos`)).body)).toEqual([hiddenId]);
  });
});

describe("albums", () => {
  it("blocks a member choosing a hidden cover; a manager may; the cover is withheld from members", async () => {
    const blocked = await call(member, "PATCH", `/albums/${albumId}/cover`, { photoId: hiddenId });
    expect(blocked.status).toBe(400);
    expect((await call(admin, "PATCH", `/albums/${albumId}/cover`, { photoId: hiddenId })).status).toBe(200);
    expect((await call(member, "GET", `/albums/${albumId}`)).body.coverPhotoUrl).toBeNull();
    expect((await call(member, "GET", "/albums")).body.find((a: { id: number }) => a.id === albumId).coverPhotoUrl).toBeNull();
    expect((await call(admin, "GET", `/albums/${albumId}`)).body.coverPhotoUrl).toBe(hiddenUrl);
    expect((await call(member, "PATCH", `/albums/${albumId}/cover`, { photoId: visibleId })).body.coverPhotoUrl).toBe(visibleUrl);
    await db.update(albumsTable).set({ coverPhotoId: null }).where(eq(albumsTable.id, albumId));
  });

  it("keeps hidden photos out of a member's top-rated list and the upload duplicate check", async () => {
    await ratePhoto(hiddenId, admin.id, 5);
    await ratePhoto(visibleId, admin.id, 3);
    expect(ids((await call(member, "GET", `/albums/${albumId}/top-rated`)).body)).toEqual([visibleId]);
    expect(ids((await call(admin, "GET", `/albums/${albumId}/top-rated`)).body)).toEqual([hiddenId, visibleId].sort((x, y) => x - y));
    const files = { files: [{ name: "a.jpg", size: 111 }] };
    expect((await call(member, "POST", `/albums/${albumId}/photos/check-duplicates`, files)).body.duplicates).toEqual([]);
  });
});

describe("single-photo actions and dashboard lists", () => {
  it("treats a hidden photo as missing for rating, for members", async () => {
    expect((await call(member, "POST", `/photos/${hiddenId}/rating`, { score: 4 })).status).toBe(404);
    expect((await call(member, "DELETE", `/photos/${hiddenId}/rating`)).status).toBe(404);
    expect((await call(admin, "POST", `/photos/${hiddenId}/rating`, { score: 4 })).status).toBe(200);
  });

  it("excludes hidden photos from dashboard recent and top-rated lists for members", async () => {
    expect(ids((await call(member, "GET", "/stats/recent-photos")).body)).toEqual([visibleId]);
    expect((await call(member, "GET", "/stats/dashboard")).body.recentActivity.map((p: { id: number }) => p.id)).toEqual([visibleId]);
    expect(ids((await call(member, "GET", "/stats/top-rated")).body)).toEqual([visibleId]);
    expect(ids((await call(admin, "GET", "/stats/recent-photos")).body)).toEqual([hiddenId, visibleId].sort((x, y) => x - y));
  });
});

describe("image-generation inputs", () => {
  const generate = (as: U, photoId: number) =>
    call(as, "POST", "/image-generation/generate", { prompt: "Poster", inputs: [{ kind: "photo", refId: photoId, role: "hero_photo" }] });

  it("rejects a hidden photo input for members like a missing photo; allows managers and visible photos", async () => {
    const blocked = await generate(member, hiddenId);
    const missing = await generate(member, 999999);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe(missing.body.error.replace("999999", String(hiddenId)));
    expect((await generate(member, visibleId)).status).toBe(200);
    expect((await generate(admin, hiddenId)).status).toBe(200);
  });
});
