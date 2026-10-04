import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Usage rights (#207, docs/USAGE_RIGHTS.md): an explicit not_recorded state,
// rights at Create decision points, shortlist/generation/export snapshots, and
// re-checking at action time. Policy is warning-only: nothing here may block.
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
// No provider calls: query embeddings are unavailable (keyword fallback), the
// image model returns fixed bytes, and the org has a fake key.
vi.mock("../aiEmbedding", async (orig) => ({
  ...(await orig<typeof import("../aiEmbedding")>()),
  embedQuery: async () => ({ ok: false as const, reason: "not_configured" as const }),
}));
vi.mock("../imageGeneration/openaiImage", () => ({
  generateImage: async () => ({ buffer: Buffer.from("png"), responseId: "resp", imageModel: "test-model" }),
}));
vi.mock("../aiProviders", async (orig) => ({
  ...(await orig<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => ({ apiKey: "sk-test", baseURL: undefined }),
}));
vi.mock("../objectStorage", async (orig) => ({
  ...(await orig<typeof import("../objectStorage")>()),
  getPrivateObjectDir: () => "/test-bucket/private",
}));

import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import app from "../../app";
import {
  db,
  pool,
  photosTable,
  attributionTagsTable,
  photoAttributionTagsTable,
  photoAiEvaluationsTable,
  projectsTable,
  projectPhotosTable,
  imageGenerationsTable,
} from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";
import { findPhotoCandidates } from "../imageGeneration/plan";
import { resetGenerationLimits } from "../imageGeneration/limits";

let server: Server;
let base: string;
let orgA: number;
let orgB: number;
let admin: { id: number; authUserId: string };
let member: { id: number; authUserId: string };
let tagged: number;
let untagged: number;
let foreign: number;
let sponsor: number;
let social: number;

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Rights A" })).id;
  orgB = (await createOrganization({ name: "Rights B" })).id;
  admin = await createUser({ name: "Admin" });
  member = await createUser({ name: "Member" });
  await addOrganizationMember(orgA, admin.id, "admin");
  await addOrganizationMember(orgA, member.id, "member");
  const album = await createAlbum(admin.id, "Spring Open", orgA);
  const albumB = await createAlbum(admin.id, "Elsewhere", orgB);
  const add = async (name: string, org: number, albumId: number) => {
    const p = await createPhoto(albumId, admin.id, { organizationId: org, url: dataUrl, aiDescription: `An archer at full draw, ${name}` });
    await db.update(photosTable).set({ filename: `${name}.jpg` }).where(eq(photosTable.id, p.id));
    return p.id;
  };
  tagged = await add("tagged_archer", orgA, album.id);
  untagged = await add("untagged_archer", orgA, album.id);
  foreign = await add("foreign_archer", orgB, albumB.id);
  sponsor = (await db.insert(attributionTagsTable).values({ organizationId: orgA, name: "USA Archery" }).returning())[0].id;
  social = (await db.insert(attributionTagsTable).values({ organizationId: orgA, name: "Social" }).returning())[0].id;
  const foreignTag = (await db.insert(attributionTagsTable).values({ organizationId: orgB, name: "USA Archery" }).returning())[0].id;
  await db.insert(photoAttributionTagsTable).values([
    { photoId: tagged, tagId: sponsor },
    { photoId: foreign, tagId: foreignTag },
  ]);
  await db.insert(photoAiEvaluationsTable).values({ photoId: tagged, organizationId: orgA, technicalQuality: 8, composition: 8, subjectClarity: 8, emotionalImpact: 7, marketingUsability: 8, overallScore: 7.84, flaws: [] });
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

async function call(method: string, path: string, body?: unknown, as = admin, org = orgA) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, bytes: Buffer.from(text, "latin1") };
}

describe("explicit rights state on photos (RIGHTS-02)", () => {
  it("an untagged photo is not_recorded, never an empty 'approved' list", async () => {
    const r = await call("GET", `/photos/${untagged}`);
    expect(r.status).toBe(200);
    expect(r.body.usageRights).toEqual({ status: "not_recorded", tags: [] });
    expect(r.body.attributionTags).toEqual([]); // existing field unchanged
  });

  it("a tagged photo is recorded with its tag ids and names", async () => {
    const r = await call("GET", `/photos/${tagged}`);
    expect(r.body.usageRights).toEqual({ status: "recorded", tags: [{ id: sponsor, name: "USA Archery" }] });
  });

  it("list responses carry the same state for every photo", async () => {
    const r = await call("GET", "/photos?limit=50");
    const byId = new Map(r.body.photos.map((p: any) => [p.id, p.usageRights]));
    expect(byId.get(untagged)).toEqual({ status: "not_recorded", tags: [] });
    expect(byId.get(tagged)).toMatchObject({ status: "recorded" });
    expect(byId.has(foreign)).toBe(false); // org-scoped
  });
});

describe("Create candidates show rights and quality (RIGHTS-03 contract)", () => {
  it("photo candidates carry usageRights and AI quality or null when not evaluated", async () => {
    const cands = await findPhotoCandidates(orgA, "archer");
    const t = cands.find((c) => c.refId === tagged)!;
    const u = cands.find((c) => c.refId === untagged)!;
    expect(t.usageRights).toEqual({ status: "recorded", tags: [{ id: sponsor, name: "USA Archery" }] });
    expect(t.quality).toEqual({ overallScore: 7.8 });
    expect(u.usageRights).toEqual({ status: "not_recorded", tags: [] }); // still offered: warning-only
    expect(u.quality).toBeNull();
    expect(cands.some((c) => c.refId === foreign)).toBe(false);
  });
});

describe("shortlist, export and generation snapshots (RIGHTS-04)", () => {
  let projectId: number;

  it("adding a photo to a project records its rights at that moment", async () => {
    projectId = (await call("POST", "/projects", { name: "Spring promo" })).body.id;
    expect((await call("POST", `/projects/${projectId}/photos`, { photoId: tagged })).status).toBe(204);
    expect((await call("POST", `/projects/${projectId}/photos`, { photoId: untagged })).status).toBe(204);
    const [row] = await db.select().from(projectPhotosTable).where(and(eq(projectPhotosTable.projectId, projectId), eq(projectPhotosTable.photoId, tagged)));
    expect(row.rightsSnapshot).toMatchObject({ status: "recorded", tags: [{ id: sponsor, name: "USA Archery" }] });
    expect(new Date(row.rightsSnapshot!.checkedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a rights change after shortlisting is detected at export time", async () => {
    // The tag is removed and another added after the photo was shortlisted.
    await db.delete(photoAttributionTagsTable).where(and(eq(photoAttributionTagsTable.photoId, tagged), eq(photoAttributionTagsTable.tagId, sponsor)));
    await db.insert(photoAttributionTagsTable).values({ photoId: tagged, tagId: social });
    const r = await call("GET", `/projects/${projectId}/rights-check`, undefined, member);
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ total: 2, recorded: 1, notRecorded: 1, changedSinceShortlist: 1, notCapturedAtShortlist: 0 });
    const t = r.body.photos.find((p: any) => p.photoId === tagged);
    expect(t.usageRights).toEqual({ status: "recorded", tags: [{ id: social, name: "Social" }] });
    expect(t.changedSinceShortlist).toEqual({ added: [{ id: social, name: "Social" }], removed: [{ id: sponsor, name: "USA Archery" }] });
    expect(t.shortlistedRights.tags).toEqual([{ id: sponsor, name: "USA Archery" }]);
    const u = r.body.photos.find((p: any) => p.photoId === untagged);
    expect(u).toMatchObject({ usageRights: { status: "not_recorded", tags: [] }, changedSinceShortlist: null });
  });

  it("photos shortlisted before snapshots existed are reported as not captured, not as changed", async () => {
    await db.update(projectPhotosTable).set({ rightsSnapshot: null }).where(and(eq(projectPhotosTable.projectId, projectId), eq(projectPhotosTable.photoId, untagged)));
    const r = await call("GET", `/projects/${projectId}/rights-check`);
    expect(r.body.counts.notCapturedAtShortlist).toBe(1);
    expect(r.body.photos.find((p: any) => p.photoId === untagged).changedSinceShortlist).toBeNull();
  });

  it("export is not blocked and the zip carries a usage-rights manifest", async () => {
    const r = await call("GET", `/projects/${projectId}/download`);
    expect(r.status).toBe(200); // warning-only: unknown and changed rights don't block
    const text = r.bytes.toString("utf8");
    expect(text).toContain("usage-rights.json");
    const start = text.indexOf('{\n  "project"');
    const manifest = JSON.parse(text.slice(start, text.indexOf("\n}", start) + 2));
    expect(manifest.counts).toMatchObject({ total: 2, notRecorded: 1, changedSinceShortlist: 1 });
    expect(manifest.note).toMatch(/not a legal clearance/);
    expect(Date.parse(manifest.checkedAt)).not.toBeNaN();
  });

  it("a rights-check of another org's project is not found", async () => {
    expect((await call("GET", `/projects/${projectId}/rights-check`, undefined, admin, orgB)).status).toBe(403); // not a member of B
    const other = await createUser({ name: "Other" });
    await addOrganizationMember(orgB, other.id, "owner");
    expect((await call("GET", `/projects/${projectId}/rights-check`, undefined, other, orgB)).status).toBe(404);
  });

  it("generation snapshots each photo's current rights and never calls a tag a clearance", async () => {
    resetGenerationLimits();
    const r = await call("POST", "/image-generation/generate", {
      prompt: "Spring Open post",
      format: "1:1",
      variantCount: 1,
      inputs: [
        { kind: "photo", refId: tagged, role: "hero_photo" },
        { kind: "photo", refId: untagged, role: "style" },
      ],
    });
    expect(r.status).toBe(200); // a not_recorded input does not block generation
    const genId = r.body.generations[0].id;
    const [gen] = await db.select().from(imageGenerationsTable).where(eq(imageGenerationsTable.id, genId));
    expect(gen.rightsSnapshot).toEqual([
      expect.objectContaining({ photoId: tagged, name: "tagged_archer.jpg", status: "recorded", tags: [{ id: social, name: "Social" }] }),
      expect.objectContaining({ photoId: untagged, name: "untagged_archer.jpg", status: "not_recorded", tags: [] }),
    ]);
    expect(gen.usageNotesSnapshot.join(" ")).not.toMatch(/cleared/i);
    expect(gen.usageNotesSnapshot.join(" ")).toMatch(/not a legal clearance/);
    // The gallery shows what was considered.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const list = await call("GET", "/image-generation/all?limit=10&includeFailed=true");
    expect(list.body.items.find((i: any) => i.id === genId).rightsConsidered).toHaveLength(2);
  });
});
