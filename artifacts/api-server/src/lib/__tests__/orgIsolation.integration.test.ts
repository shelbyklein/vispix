import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mock Better Auth so a request authenticates as whichever user's authUserId it
// sends in the x-test-auth-user header (see `api()` below). The real session
// machinery (cookies/DB) isn't exercised here — this suite is about org scoping.
vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-test-auth-user");
        // email/name mirror the id so a not-yet-provisioned id (e.g. an email)
        // is provisioned by requireAuth — exercising invite auto-join.
        // Real sessions exist only for verified addresses (requireEmailVerification).
        return id ? { user: { id, email: id, name: id, emailVerified: true } } : null;
      },
    },
    // app.ts mounts toNodeHandler(auth); tests never hit /api/auth, but the
    // handler must exist for the mount to succeed.
    handler: async () => new Response(null, { status: 404 }),
  },
}));

import type { Server } from "node:http";
import app from "../../app";
import { mayAccessObjectPath } from "../../routes/storage";
import { eq } from "drizzle-orm";
import { db, pool, assetsTable, attributionTagsTable, organizationsTable, nearDuplicatePairsTable } from "@workspace/db";
import { assertUploadAllowed } from "../billing/subscriptions";
import { listNearDuplicatePhotoGroups } from "../perceptualHash";
import {
  resetDb,
  createUser,
  createOrganization,
  addOrganizationMember,
  createAlbum,
  createPhoto,
  createCollection,
  createProject,
} from "./testDb";

const GB = 1024 * 1024 * 1024;
async function orgRow(id: number) {
  const [row] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, id));
  return row;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function api(
  path: string,
  opts: { user?: { authUserId: string }; orgId?: number; method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.user) headers["x-test-auth-user"] = opts.user.authUserId;
  if (opts.orgId != null) headers["x-organization-id"] = String(opts.orgId);
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// Two fully-populated tenants; user A belongs only to org A, user B only to B.
async function seedTwoOrgs() {
  const orgA = await createOrganization({ name: "Org A", slug: "org-a" });
  const orgB = await createOrganization({ name: "Org B", slug: "org-b" });
  const userA = await createUser({ name: "Alice" });
  const userB = await createUser({ name: "Bob" });
  await addOrganizationMember(orgA.id, userA.id, "owner");
  await addOrganizationMember(orgB.id, userB.id, "owner");

  async function populate(orgId: number, ownerId: number, tag: string) {
    const album = await createAlbum(ownerId, `${tag} album`, orgId);
    const photo = await createPhoto(album.id, ownerId, { organizationId: orgId });
    const collection = await createCollection(ownerId, `${tag} collection`, orgId);
    const project = await createProject(ownerId, `${tag} project`, orgId);
    const [asset] = await db
      .insert(assetsTable)
      .values({ kind: "brand", name: `${tag} asset`, storageKey: "/objects/x", contentType: "image/png", organizationId: orgId, createdById: ownerId })
      .returning();
    const [attr] = await db
      .insert(attributionTagsTable)
      .values({ name: `${tag}-rights`, organizationId: orgId })
      .returning();
    return { album, photo, collection, project, asset, attr };
  }

  const a = await populate(orgA.id, userA.id, "A");
  const b = await populate(orgB.id, userB.id, "B");
  return { orgA, orgB, userA, userB, a, b };
}

beforeEach(async () => {
  await resetDb();
});

describe("org isolation — a member of org A cannot reach org B's data", () => {
  it("blocks a non-member from acting in an org (403) but allows a member", async () => {
    const { orgA, orgB, userA } = await seedTwoOrgs();
    expect((await api("/api/albums", { user: userA, orgId: orgA.id })).status).toBe(200);
    // userA is not a member of org B — every org-scoped route must 403.
    expect((await api("/api/albums", { user: userA, orgId: orgB.id })).status).toBe(403);
    expect((await api("/api/photos", { user: userA, orgId: orgB.id })).status).toBe(403);
    expect((await api("/api/stats/dashboard", { user: userA, orgId: orgB.id })).status).toBe(403);
  });

  async function listIds(path: string, user: { authUserId: string }, orgId: number): Promise<number[]> {
    const data = (await (await api(path, { user, orgId })).json()) as Array<{ id: number }>;
    return data.map((x) => x.id);
  }

  it("lists only the caller's own org resources", async () => {
    const { orgA, userA, a } = await seedTwoOrgs();

    expect(await listIds("/api/albums", userA, orgA.id)).toEqual([a.album.id]);
    expect(await listIds("/api/collections", userA, orgA.id)).toEqual([a.collection.id]);
    expect(await listIds("/api/projects", userA, orgA.id)).toEqual([a.project.id]);
    expect(await listIds("/api/assets", userA, orgA.id)).toEqual([a.asset.id]);
    expect(await listIds("/api/attribution-tags", userA, orgA.id)).toEqual([a.attr.id]);

    const photos = (await (await api("/api/photos", { user: userA, orgId: orgA.id })).json()) as {
      photos: Array<{ id: number }>;
    };
    expect(photos.photos.map((x) => x.id)).toEqual([a.photo.id]);
  });

  it("returns 404 when fetching another org's entity by id", async () => {
    const { orgA, userA, b } = await seedTwoOrgs();
    const opts = { user: userA, orgId: orgA.id };
    expect((await api(`/api/albums/${b.album.id}`, opts)).status).toBe(404);
    expect((await api(`/api/photos/${b.photo.id}`, opts)).status).toBe(404);
    expect((await api(`/api/collections/${b.collection.id}`, opts)).status).toBe(404);
    expect((await api(`/api/projects/${b.project.id}`, opts)).status).toBe(404);
  });

  it("dashboard counts only the caller's org", async () => {
    const { orgA, userA } = await seedTwoOrgs();
    const stats = (await (await api("/api/stats/dashboard", { user: userA, orgId: orgA.id })).json()) as {
      totalAlbums: number;
      totalPhotos: number;
      totalCollections: number;
      totalProjects: number;
      totalUsers: number;
    };
    // Exactly the one album/photo/collection/project seeded for org A.
    expect(stats.totalAlbums).toBe(1);
    expect(stats.totalPhotos).toBe(1);
    expect(stats.totalCollections).toBe(1);
    expect(stats.totalProjects).toBe(1);
    expect(stats.totalUsers).toBe(1); // one member in org A
  });

  it("cannot mutate another org's entity", async () => {
    const { orgA, userA, b } = await seedTwoOrgs();
    const opts = { user: userA, orgId: orgA.id };
    // Rename B's album as A → 404 (not found in A's scope).
    expect((await api(`/api/albums/${b.album.id}`, { ...opts, method: "PATCH", body: { title: "hijacked" } })).status).toBe(404);
    // Delete B's photo as A → 404.
    expect((await api(`/api/photos/${b.photo.id}`, { ...opts, method: "DELETE" })).status).toBe(404);
    // Add B's photo to A's collection → 404 (photo not in A).
    expect((await api(`/api/collections/${b.collection.id}/photos`, { ...opts, method: "POST", body: { photoId: b.photo.id } })).status).toBe(404);
  });

  it("/organizations lists only memberships; switch to a non-member org 403s", async () => {
    const { orgA, orgB, userA } = await seedTwoOrgs();
    const orgs = (await (await api("/api/organizations", { user: userA })).json()) as Array<{ slug: string }>;
    expect(orgs.map((o) => o.slug)).toEqual(["org-a"]);
    expect((await api("/api/organizations/switch", { user: userA, method: "POST", body: { organizationId: orgB.id } })).status).toBe(403);
    expect((await api("/api/organizations/switch", { user: userA, method: "POST", body: { organizationId: orgA.id } })).status).toBe(200);
  });

  it("a user with no org can create one and is enrolled as owner (#113 Phase 4b)", async () => {
    const user = await createUser({ name: "New Signup" });

    // No membership → tenant routes 403 and the org list is empty.
    expect((await api("/api/albums", { user })).status).toBe(403);
    expect(await (await api("/api/organizations", { user })).json()).toEqual([]);

    // Create an org — becomes owner, slug derived from the name.
    const res = await api("/api/organizations", { user, method: "POST", body: { name: "Acme Photos" } });
    expect(res.status).toBe(201);
    const org = (await res.json()) as { id: number; name: string; slug: string; role: string };
    expect(org.name).toBe("Acme Photos");
    expect(org.slug).toBe("acme-photos");
    expect(org.role).toBe("owner");

    // Now a member → tenant routes work and the org list shows it.
    expect((await api("/api/albums", { user, orgId: org.id })).status).toBe(200);
    const orgs = (await (await api("/api/organizations", { user })).json()) as Array<{ id: number }>;
    expect(orgs.map((o) => o.id)).toEqual([org.id]);
  });

  it("org admin manages members and invites; member is forbidden (#113 Phase 4c)", async () => {
    const { orgA, userA } = await seedTwoOrgs();
    const member = await createUser({ name: "Member" });
    await addOrganizationMember(orgA.id, member.id, "member");
    const opts = { user: userA, orgId: orgA.id };

    // A plain member can't invite.
    expect((await api("/api/organizations/invites", { user: member, orgId: orgA.id, method: "POST", body: { email: "x@y.com" } })).status).toBe(403);

    // Owner invites (email lowercased); listing shows it.
    const inv = await api("/api/organizations/invites", { ...opts, method: "POST", body: { email: "Teammate@Example.com", role: "member" } });
    expect(inv.status).toBe(201);
    const invite = (await inv.json()) as { id: number; email: string };
    expect(invite.email).toBe("teammate@example.com");
    const invites = (await (await api("/api/organizations/invites", opts)).json()) as unknown[];
    expect(invites).toHaveLength(1);

    // Members list has the owner + the member.
    const members = (await (await api("/api/organizations/members", opts)).json()) as Array<{ userId: number }>;
    expect(members.map((m) => m.userId).sort()).toEqual([userA.id, member.id].sort());

    // Can't remove the sole owner; can remove the member.
    expect((await api(`/api/organizations/members/${userA.id}`, { ...opts, method: "DELETE" })).status).toBe(400);
    expect((await api(`/api/organizations/members/${member.id}`, { ...opts, method: "DELETE" })).status).toBe(204);

    // Revoke the invite.
    expect((await api(`/api/organizations/invites/${invite.id}`, { ...opts, method: "DELETE" })).status).toBe(204);
  });

  it("an invited email auto-joins the org on first sign-in (#113 Phase 4c)", async () => {
    const { orgA, userA, a } = await seedTwoOrgs();
    expect((await api("/api/organizations/invites", { user: userA, orgId: orgA.id, method: "POST", body: { email: "newbie@test.local", role: "member" } })).status).toBe(201);

    // A brand-new user with that email signs in — requireAuth provisions them and
    // consumes the invite, enrolling them in org A.
    const newUser = { authUserId: "newbie@test.local" };
    const albums = await api("/api/albums", { user: newUser }); // no org header → resolves the sole (invited) org
    expect(albums.status).toBe(200);
    expect(((await albums.json()) as Array<{ id: number }>).map((x) => x.id)).toEqual([a.album.id]);

    const orgs = (await (await api("/api/organizations", { user: newUser })).json()) as Array<{ slug: string }>;
    expect(orgs.map((o) => o.slug)).toEqual([orgA.slug]);

    // Invite consumed.
    expect((await (await api("/api/organizations/invites", { user: userA, orgId: orgA.id })).json()) as unknown[]).toHaveLength(0);
  });

  it("org details are viewable by members and editable by admins (#113 Phase 4d)", async () => {
    const { orgA, userA } = await seedTwoOrgs();
    const member = await createUser({ name: "Member" });
    await addOrganizationMember(orgA.id, member.id, "member");

    // Any member can view details.
    const view = await api("/api/organizations/current", { user: member, orgId: orgA.id });
    expect(view.status).toBe(200);
    const details = (await view.json()) as { name: string; memberCount: number; role: string; description: string | null };
    expect(details.name).toBe("Org A");
    expect(details.memberCount).toBe(2);
    expect(details.role).toBe("member");
    expect(details.description).toBeNull();

    // A plain member cannot edit.
    expect((await api("/api/organizations/current", { user: member, orgId: orgA.id, method: "PATCH", body: { name: "Hacked" } })).status).toBe(403);

    // Owner renames + describes.
    const upd = await api("/api/organizations/current", { user: userA, orgId: orgA.id, method: "PATCH", body: { name: "Org A Renamed", description: "Our shared library" } });
    expect(upd.status).toBe(200);
    const updated = (await upd.json()) as { name: string; description: string | null };
    expect(updated.name).toBe("Org A Renamed");
    expect(updated.description).toBe("Our shared library");

    // Persisted, and the switcher list reflects the new name.
    const after = (await (await api("/api/organizations/current", { user: userA, orgId: orgA.id })).json()) as { name: string };
    expect(after.name).toBe("Org A Renamed");
    const myOrgs = (await (await api("/api/organizations", { user: userA })).json()) as Array<{ name: string }>;
    expect(myOrgs[0].name).toBe("Org A Renamed");
  });

  it("billing status is per-org; gate enforces the plan cap; enterprise is unlimited (#118)", async () => {
    const { orgA, userA, a } = await seedTwoOrgs(); // orgA defaults to the free plan (2 GB)
    const member = await createUser({ name: "Viewer" });
    await addOrganizationMember(orgA.id, member.id, "member");

    // One 1 GB photo → under the 2 GB free cap.
    await createPhoto(a.album.id, userA.id, { organizationId: orgA.id, filesize: 1 * GB });

    // Status: owner sees plan/usage/cap and canManage; a plain member cannot manage.
    const owner = (await (await api("/api/billing/status", { user: userA, orgId: orgA.id })).json()) as {
      plan: string; usageBytes: number; capBytes: number; overLimit: boolean; canManage: boolean;
    };
    expect(owner.plan).toBe("free");
    expect(owner.usageBytes).toBe(1 * GB);
    expect(owner.capBytes).toBe(2 * GB);
    expect(owner.overLimit).toBe(false);
    expect(owner.canManage).toBe(true);
    const viewer = (await (await api("/api/billing/status", { user: member, orgId: orgA.id })).json()) as { canManage: boolean };
    expect(viewer.canManage).toBe(false);

    // Checkout is unavailable until Stripe is configured (no keys in tests).
    expect((await api("/api/billing/create-checkout-session", { user: userA, orgId: orgA.id, method: "POST", body: {} })).status).toBe(503);

    // Push usage to the 2 GB cap → the upload gate refuses more.
    await createPhoto(a.album.id, userA.id, { organizationId: orgA.id, filesize: 1 * GB });
    const atCap = await assertUploadAllowed(await orgRow(orgA.id), 1);
    expect(atCap.allowed).toBe(false);
    expect(atCap.capBytes).toBe(2 * GB);

    // ...and the presign route refuses to mint an upload URL with a 402 (#118),
    // so over-cap bytes never reach storage.
    const preflight = await api("/api/storage/uploads/request-url", {
      user: userA,
      orgId: orgA.id,
      method: "POST",
      body: { name: "next.jpg", size: 1024, contentType: "image/jpeg" },
    });
    expect(preflight.status).toBe(402);
    expect(((await preflight.json()) as { code: string }).code).toBe("storage_limit_exceeded");

    // Enterprise = unlimited → always allowed, regardless of usage.
    await db.update(organizationsTable).set({ plan: "enterprise" }).where(eq(organizationsTable.id, orgA.id));
    const ent = await assertUploadAllowed(await orgRow(orgA.id), 999 * GB);
    expect(ent.allowed).toBe(true);
    expect(ent.capBytes).toBeNull();
  });

  it("platform admin sees all orgs and can join one on demand; non-admins refused (#120)", async () => {
    const { orgA, orgB, userA, a } = await seedTwoOrgs();
    const platformAdmin = await createUser({ name: "Operator", role: "admin" });
    await createPhoto(a.album.id, userA.id, { organizationId: orgA.id, filesize: 1024 });

    // A regular org owner is NOT a platform admin → 403 on the overview.
    expect((await api("/api/admin/organizations", { user: userA })).status).toBe(403);

    // The platform admin sees every org with stats, without being a member.
    const listRes = await api("/api/admin/organizations", { user: platformAdmin });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      id: number; plan: string; memberCount: number; photoCount: number; usageBytes: number; myRole: string | null;
    }[];
    const a1 = list.find((o) => o.id === orgA.id)!;
    const b1 = list.find((o) => o.id === orgB.id)!;
    expect(a1.photoCount).toBe(2); // seedTwoOrgs' photo (null filesize) + the 1024-byte one
    expect(a1.usageBytes).toBe(1024);
    expect(a1.myRole).toBeNull();
    expect(b1.photoCount).toBe(1);

    // Membership is still required to act inside the org (the tenancy wall holds).
    expect((await api("/api/albums", { user: platformAdmin, orgId: orgA.id })).status).toBe(403);

    // Join-on-demand: becomes an org-admin member, visible in the roster.
    const join = await api(`/api/admin/organizations/${orgA.id}/join`, { user: platformAdmin, method: "POST", body: {} });
    expect(join.status).toBe(200);
    expect(((await join.json()) as { role: string }).role).toBe("admin");
    expect((await api("/api/albums", { user: platformAdmin, orgId: orgA.id })).status).toBe(200);

    // Idempotent — rejoining reports the existing membership, role unchanged.
    const again = (await (
      await api(`/api/admin/organizations/${orgA.id}/join`, { user: platformAdmin, method: "POST", body: {} })
    ).json()) as { role: string; alreadyMember: boolean };
    expect(again.role).toBe("admin");
    expect(again.alreadyMember).toBe(true);

    // The overview now reflects the membership.
    const after = (await (await api("/api/admin/organizations", { user: platformAdmin })).json()) as {
      id: number; myRole: string | null; memberCount: number;
    }[];
    expect(after.find((o) => o.id === orgA.id)!.myRole).toBe("admin");
  });

  it("ignoring a near-duplicate comparison persists across index rebuilds (#124)", async () => {
    const { orgA, userA, a } = await seedTwoOrgs();
    const p1 = await createPhoto(a.album.id, userA.id, { organizationId: orgA.id });
    const p2 = await createPhoto(a.album.id, userA.id, { organizationId: orgA.id });
    const [lo, hi] = [Math.min(p1.id, p2.id), Math.max(p1.id, p2.id)];
    await db.insert(nearDuplicatePairsTable).values({ organizationId: orgA.id, photoA: lo, photoB: hi, distance: 2 });

    // The pair groups...
    expect((await listNearDuplicatePhotoGroups(6, orgA.id)).length).toBe(1);

    // ...until it's ignored via the route (org-admin only).
    const ignore = await api("/api/admin/photos/near-duplicates/ignore", {
      user: userA,
      orgId: orgA.id,
      method: "POST",
      body: { photoIds: [p1.id, p2.id] },
    });
    expect(ignore.status).toBe(200);
    expect(((await ignore.json()) as { ignoredPairs: number }).ignoredPairs).toBe(1);
    expect((await listNearDuplicatePhotoGroups(6, orgA.id)).length).toBe(0);

    // Simulate an index rebuild re-inserting the same pair: still ignored.
    await db.insert(nearDuplicatePairsTable).values({ organizationId: orgA.id, photoA: lo, photoB: hi, distance: 2 }).onConflictDoNothing();
    expect((await listNearDuplicatePhotoGroups(6, orgA.id)).length).toBe(0);
  });

  it("service readiness endpoint is platform-admin only and reports all services (#122)", async () => {
    const { userA } = await seedTwoOrgs();
    const platformAdmin = await createUser({ name: "Operator", role: "admin" });

    expect((await api("/api/admin/service-status", { user: userA })).status).toBe(403);

    const res = await api("/api/admin/service-status", { user: platformAdmin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; services: { key: string; ok: boolean; optional: boolean }[] };
    expect(body.services.map((s) => s.key).sort()).toEqual(["ai", "billing"]);
    expect(typeof body.ready).toBe("boolean");
  });

  it("org-scoped service readiness admits org admins, refuses members (#122)", async () => {
    const { orgA, userA } = await seedTwoOrgs(); // userA = org owner, NOT a platform admin
    const member = await createUser({ name: "Plain member" });
    await addOrganizationMember(orgA.id, member.id, "member");

    // Plain member → refused; org owner → allowed, same four services.
    expect((await api("/api/admin/org-service-status", { user: member, orgId: orgA.id })).status).toBe(403);
    const res = await api("/api/admin/org-service-status", { user: userA, orgId: orgA.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: { key: string; ok: boolean }[] };
    expect(body.services.map((s) => s.key).sort()).toEqual(["ai", "billing"]);
    // No AI key stored for this org and no env fallback in tests → not ok.
    expect(body.services.find((s) => s.key === "ai")!.ok).toBe(false);
  });

  it("platform admin can change a member's org role; last owner is protected (#120)", async () => {
    const { orgA, userA } = await seedTwoOrgs(); // userA = sole owner of orgA
    const platformAdmin = await createUser({ name: "Operator", role: "admin" });
    const member = await createUser({ name: "Colleague" });
    await addOrganizationMember(orgA.id, member.id, "member");

    const setRole = (user: { authUserId: string }, userId: number, role: string) =>
      api(`/api/admin/organizations/${orgA.id}/members/${userId}`, { user, method: "PATCH", body: { role } });

    // Only platform admins may use the platform-level role route.
    expect((await setRole(userA, member.id, "owner")).status).toBe(403);

    // Promote the member to owner — without the caller being in the org at all.
    expect((await setRole(platformAdmin, member.id, "owner")).status).toBe(204);

    // Now the original owner can be demoted (another owner exists)...
    expect((await setRole(platformAdmin, userA.id, "member")).status).toBe(204);

    // ...but the last remaining owner cannot be.
    const last = await setRole(platformAdmin, member.id, "admin");
    expect(last.status).toBe(400);

    // Unknown membership → 404.
    expect((await setRole(platformAdmin, 99999, "member")).status).toBe(404);
  });

  it("org owners can set, serve, and remove an org logo (#121)", async () => {
    const { orgA, userA } = await seedTwoOrgs();
    const member = await createUser({ name: "Plain member" });
    await addOrganizationMember(orgA.id, member.id, "member");

    // Members can't manage settings; arbitrary (non-upload-flow) keys refused.
    expect(
      (await api("/api/organizations/current", { user: member, orgId: orgA.id, method: "PATCH", body: { logoKey: "/objects/uploads/x" } })).status,
    ).toBe(403);
    expect(
      (await api("/api/organizations/current", { user: userA, orgId: orgA.id, method: "PATCH", body: { logoKey: "../../etc/passwd" } })).status,
    ).toBe(400);
    // Only this org's uploads (the request-url flow) — not legacy or other orgs' keys.
    expect(
      (await api("/api/organizations/current", { user: userA, orgId: orgA.id, method: "PATCH", body: { logoKey: "/objects/uploads/logo-1" } })).status,
    ).toBe(400);

    // Owner sets a logo → logoUrl appears on details and the org-switcher list.
    const logoKey = `/objects/orgs/${orgA.id}/uploads/0b8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d`;
    const set = await api("/api/organizations/current", {
      user: userA, orgId: orgA.id, method: "PATCH", body: { logoKey },
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { logoUrl: string | null }).logoUrl).toBe(`/api/storage${logoKey}`);
    const mine = (await (await api("/api/organizations", { user: userA })).json()) as { id: number; logoUrl: string | null }[];
    expect(mine.find((o) => o.id === orgA.id)!.logoUrl).toBe(`/api/storage${logoKey}`);

    // Removal nulls it out.
    const removed = await api("/api/organizations/current", {
      user: userA, orgId: orgA.id, method: "PATCH", body: { logoKey: null },
    });
    expect(((await removed.json()) as { logoUrl: string | null }).logoUrl).toBeNull();
  });

  it("instance-admin set-plan overrides a plan; non-admins are refused (#118)", async () => {
    const { orgA, userA } = await seedTwoOrgs(); // orgA on the free plan; userA is its owner (not an instance admin)
    const instanceAdmin = await createUser({ name: "Root", role: "admin" });

    // An org owner who is not an instance admin cannot use the override.
    const forbidden = await api("/api/billing/admin/set-plan", {
      user: userA,
      method: "POST",
      body: { organizationId: orgA.id, plan: "enterprise" },
    });
    expect(forbidden.status).toBe(403);
    expect((await orgRow(orgA.id)).plan).toBe("free");

    // The instance admin flips it to Enterprise → unlimited.
    const granted = await api("/api/billing/admin/set-plan", {
      user: instanceAdmin,
      method: "POST",
      body: { organizationId: orgA.id, plan: "enterprise" },
    });
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as { plan: string; capBytes: number | null };
    expect(body.plan).toBe("enterprise");
    expect(body.capBytes).toBeNull();
    expect((await orgRow(orgA.id)).plan).toBe("enterprise");
    expect((await assertUploadAllowed(await orgRow(orgA.id), 999 * GB)).allowed).toBe(true);

    // ...and back down to Free re-imposes the cap.
    await api("/api/billing/admin/set-plan", {
      user: instanceAdmin,
      method: "POST",
      body: { organizationId: orgA.id, plan: "free" },
    });
    expect((await orgRow(orgA.id)).plan).toBe("free");
  });

  it("requires authentication and org membership", async () => {
    const { orgA } = await seedTwoOrgs();
    // No auth header → 401.
    expect((await api("/api/albums", { orgId: orgA.id })).status).toBe(401);
  });

  it("storage ACL: every object key requires membership of its org (#113 Phase 3c/4)", async () => {
    // orgA is created first, so it's the default (lowest-id) org that legacy
    // (unprefixed) keys belong to. userA is in orgA, userB only in orgB.
    const { orgA, orgB, userA, userB } = await seedTwoOrgs();

    // Own org → allowed; other org → denied.
    expect(await mayAccessObjectPath(userA.id, `orgs/${orgA.id}/uploads/x`)).toBe(true);
    expect(await mayAccessObjectPath(userA.id, `orgs/${orgB.id}/uploads/x`)).toBe(false);

    // Legacy keys are gated to the default org: userA (default-org member) may
    // read; userB (only in orgB) may not — no more "any member" pass.
    expect(await mayAccessObjectPath(userA.id, "uploads/legacy-key")).toBe(true);
    expect(await mayAccessObjectPath(userB.id, "uploads/legacy-key")).toBe(false);
  });

  it("admin maintenance (hub-status) is org-admin-gated and per-org (#113 Phase 3d)", async () => {
    const { orgA, userA } = await seedTwoOrgs();
    const member = await createUser({ name: "Plain Member 2" });
    await addOrganizationMember(orgA.id, member.id, "member");

    // Owner gets a per-org status payload; a plain member is forbidden.
    const owner = await api("/api/admin/hub-status", { user: userA, orgId: orgA.id });
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as { aiAnalysisPending: number; duplicateGroups: number };
    expect(typeof body.aiAnalysisPending).toBe("number");
    expect(typeof body.duplicateGroups).toBe("number");

    expect((await api("/api/admin/hub-status", { user: member, orgId: orgA.id })).status).toBe(403);
  });

  it("AI settings are per-org and gated to org owner/admin (#113 Phase 3)", async () => {
    const { orgA, orgB, userA, userB } = await seedTwoOrgs();
    const member = await createUser({ name: "Plain Member" });
    await addOrganizationMember(orgA.id, member.id, "member");

    // Owner can read (this also lazily creates org A's settings row).
    expect((await api("/api/admin/ai-settings", { user: userA, orgId: orgA.id })).status).toBe(200);
    // A plain member is forbidden by requireOrgRole("owner","admin").
    expect((await api("/api/admin/ai-settings", { user: member, orgId: orgA.id })).status).toBe(403);

    // Change org A's active provider; org B must be unaffected.
    const patch = await api("/api/admin/ai-settings", {
      user: userA, orgId: orgA.id, method: "PATCH", body: { activeProvider: "anthropic" },
    });
    expect(patch.status).toBe(200);

    const a = (await (await api("/api/admin/ai-settings", { user: userA, orgId: orgA.id })).json()) as { activeProvider: string };
    const b = (await (await api("/api/admin/ai-settings", { user: userB, orgId: orgB.id })).json()) as { activeProvider: string };
    expect(a.activeProvider).toBe("anthropic");
    expect(b.activeProvider).toBe("openai");
  });
});
