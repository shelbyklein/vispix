import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// One organization-role capability matrix (#218, decided 2026-10-01):
//   creator/uploader  edit + delete own items; set rights on own photos
//   org owner/admin   manage all of the org's content; see hidden photos
//   member            create/view/rate; only their own items
//   platform admin    everything
// Every action is tried by every role; other orgs' IDs and removed members
// always fail.
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
import { db, pool, assetsTable, attributionTagsTable, organizationMembersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, createProject, createCollection } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let orgA: number;
let orgB: number;
const u: Record<"creator" | "member" | "admin" | "owner" | "platform" | "outsider" | "removed", U> = {} as never;

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Matrix A" })).id;
  orgB = (await createOrganization({ name: "Matrix B" })).id;
  for (const k of ["creator", "member", "admin", "owner", "platform", "outsider", "removed"] as const) {
    u[k] = await createUser({ name: k, role: k === "platform" ? "admin" : "member" });
  }
  await addOrganizationMember(orgA, u.creator.id, "member");
  await addOrganizationMember(orgA, u.member.id, "member");
  await addOrganizationMember(orgA, u.admin.id, "admin");
  await addOrganizationMember(orgA, u.owner.id, "owner");
  await addOrganizationMember(orgA, u.removed.id, "member");
  // Platform admins act inside orgs they belong to (tenancy is unchanged); a
  // plain membership is enough for their elevated rights to apply.
  await addOrganizationMember(orgA, u.platform.id, "member");
  await addOrganizationMember(orgB, u.outsider.id, "owner");
  await addOrganizationMember(orgB, u.platform.id, "member");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
  // A member removed from org A after creating content keeps no access.
  await db.delete(organizationMembersTable).where(and(eq(organizationMembersTable.userId, u.removed.id), eq(organizationMembersTable.organizationId, orgA)));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function call(as: U, method: string, path: string, body?: unknown, org = orgA) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

// Fresh items owned by `creator` in org A for each attempt (deletes consume them).
const make = {
  photo: async () => {
    const album = await createAlbum(u.owner.id, "Host album", orgA);
    return (await createPhoto(album.id, u.creator.id, { organizationId: orgA })).id;
  },
  album: async () => (await createAlbum(u.creator.id, "Creator's album", orgA)).id,
  project: async () => (await createProject(u.creator.id, "Creator's project", orgA)).id,
  collection: async () => (await createCollection(u.creator.id, "Creator's collection", orgA)).id,
  asset: async () =>
    (await db.insert(assetsTable).values({ organizationId: orgA, kind: "brand", name: "Mark", storageKey: `/objects/orgs/${orgA}/uploads/x`, contentType: "image/png", createdById: u.creator.id }).returning())[0].id,
};
const edits: Record<keyof typeof make, [string, (id: number) => string, unknown]> = {
  photo: ["PATCH", (id) => `/photos/${id}`, { aiDescription: "edited" }],
  album: ["PATCH", (id) => `/albums/${id}`, { title: "edited" }],
  project: ["PATCH", (id) => `/projects/${id}`, { name: "edited" }],
  collection: ["PATCH", (id) => `/collections/${id}`, { title: "edited" }],
  asset: ["PATCH", (id) => `/assets/${id}`, { name: "edited" }],
};
const deletes: Record<keyof typeof make, (id: number) => string> = {
  photo: (id) => `/photos/${id}`,
  album: (id) => `/albums/${id}`,
  project: (id) => `/projects/${id}`,
  collection: (id) => `/collections/${id}`,
  asset: (id) => `/assets/${id}`,
};
const ok = (s: number) => s >= 200 && s < 300;

describe.each(Object.keys(make) as (keyof typeof make)[])("%s", (kind) => {
  it.each([
    ["creator", true],
    ["member", false],
    ["admin", true],
    ["owner", true],
    ["platform", true],
  ] as const)("%s may edit and delete someone's item: %s", async (who, allowed) => {
    const [method, path, body] = edits[kind];
    const id1 = await make[kind]();
    const editStatus = await call(u[who], method, path(id1), body);
    expect(ok(editStatus), `edit -> ${editStatus}`).toBe(allowed);
    if (!allowed) expect(editStatus).toBe(403);
    const id2 = await make[kind]();
    const delStatus = await call(u[who], "DELETE", deletes[kind](id2));
    expect(ok(delStatus), `delete -> ${delStatus}`).toBe(allowed);
  });

  it("another org's owner and a removed member are refused", async () => {
    const [method, path, body] = edits[kind];
    const id = await make[kind]();
    expect(await call(u.outsider, method, path(id), body, orgB)).toBe(404);
    expect(await call(u.outsider, method, path(id), body, orgA)).toBe(403); // not a member of A
    expect(await call(u.removed, method, path(id), body, orgA)).toBe(403);
  });
});

describe("photos: bulk actions, hidden visibility and usage rights", () => {
  it("bulk hide/delete is for org owners/admins", async () => {
    const ids = [await make.photo(), await make.photo()];
    expect(await call(u.member, "PATCH", "/photos/bulk", { ids, isHidden: true })).toBe(403);
    expect(await call(u.creator, "PATCH", "/photos/bulk", { ids, isHidden: true })).toBe(403);
    expect(ok(await call(u.admin, "PATCH", "/photos/bulk", { ids, isHidden: true }))).toBe(true);
    expect(await call(u.member, "DELETE", "/photos/bulk", { ids })).toBe(403);
    expect(ok(await call(u.owner, "DELETE", "/photos/bulk", { ids }))).toBe(true);
  });

  it("hidden photos are visible to org owners/admins, not members", async () => {
    const id = await make.photo();
    expect(ok(await call(u.admin, "PATCH", `/photos/${id}`, { isHidden: true }))).toBe(true);
    expect(await call(u.member, "GET", `/photos/${id}`)).toBe(404);
    expect(await call(u.admin, "GET", `/photos/${id}`)).toBe(200);
    expect(await call(u.owner, "GET", `/photos/${id}`)).toBe(200);
    const list = async (as: U) => {
      const res = await fetch(`${base}/photos?includeHidden=true&limit=200`, { headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgA) } });
      return ((await res.json()) as { photos: { id: number }[] }).photos.map((p) => p.id);
    };
    expect(await list(u.member)).not.toContain(id);
    expect(await list(u.admin)).toContain(id);
  });

  it("usage rights on one photo: its uploader and org owners/admins", async () => {
    const [tag] = await db.insert(attributionTagsTable).values({ organizationId: orgA, name: `Cleared ${Date.now()}` }).returning();
    const id = await make.photo();
    expect(await call(u.member, "POST", `/photos/${id}/attribution-tags`, { tagId: tag.id })).toBe(403);
    expect(await call(u.creator, "POST", `/photos/${id}/attribution-tags`, { tagId: tag.id })).toBe(204);
    expect(await call(u.member, "DELETE", `/photos/${id}/attribution-tags/${tag.id}`)).toBe(403);
    expect(await call(u.admin, "DELETE", `/photos/${id}/attribution-tags/${tag.id}`)).toBe(204);
  });

  it("members keep creating, rating and viewing", async () => {
    const id = await make.photo();
    expect(await call(u.member, "GET", `/photos/${id}`)).toBe(200);
    expect(ok(await call(u.member, "POST", `/photos/${id}/rating`, { score: 4 }))).toBe(true);
    expect(ok(await call(u.member, "POST", "/albums", { title: "Member album" }))).toBe(true);
  });
});

describe("removed features (#250)", () => {
  it.each(["/image-generation/all", "/campaigns"])("GET %s is gone for a signed-in member", async (path) => {
    expect(await call(u.member, "GET", path)).toBe(404);
  });
});
