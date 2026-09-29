import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Search filters in both modes (#205). Auth is mocked (as in the org isolation
// suite) and the query embedding is stubbed so /search/semantic runs its real
// pgvector query against fixture embeddings — no embedding provider is called.
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

const DIM = 1408;
function unit(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}

vi.mock("../aiEmbedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiEmbedding")>()),
  // Every query points along axis 0; exclusion concepts along axis 2.
  embedQuery: async (q: string) => ({ ok: true, vec: /crowd/.test(q) ? unit({ 2: 1 }) : unit({ 0: 1 }) }),
}));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, photosTable, photoEmbeddingsTable, photoAiEvaluationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, ratePhoto } from "./testDb";

let server: Server;
let baseUrl: string;
let admin: { id: number; authUserId: string };
let member: { id: number; authUserId: string };
let other: { id: number; authUserId: string };
let orgId: number;
const P: Record<string, number> = {};

async function addPhoto(
  key: string,
  opts: { organizationId: number; albumId: number; uploaderId: number; takenAt: string | null; similarity: number; desc: string; hidden?: boolean; quality?: number },
) {
  const photo = await createPhoto(opts.albumId, opts.uploaderId, {
    organizationId: opts.organizationId,
    aiDescription: opts.desc,
    isHidden: opts.hidden ?? false,
  });
  await db.update(photosTable).set({ takenAt: opts.takenAt ? new Date(opts.takenAt) : null }).where(eq(photosTable.id, photo.id));
  // Cosine similarity to the query axis = opts.similarity.
  const s = opts.similarity;
  await db.insert(photoEmbeddingsTable).values({
    photoId: photo.id,
    organizationId: opts.organizationId,
    embedding: unit({ 0: s, 1: Math.sqrt(1 - s * s) }),
    model: "test",
  });
  if (opts.quality != null) {
    const q = Math.round(opts.quality);
    await db.insert(photoAiEvaluationsTable).values({
      photoId: photo.id,
      organizationId: opts.organizationId,
      technicalQuality: q,
      composition: q,
      subjectClarity: q,
      emotionalImpact: q,
      marketingUsability: q,
      overallScore: opts.quality,
    });
  }
  P[key] = photo.id;
  return photo;
}

beforeAll(async () => {
  await resetDb();
  const org = await createOrganization({ name: "Search Org", slug: "search-org" });
  const orgB = await createOrganization({ name: "Other Org", slug: "search-other-org" });
  orgId = org.id;
  admin = await createUser({ name: "Ada Admin", role: "admin" });
  member = await createUser({ name: "Milo Member", role: "member" });
  other = await createUser({ name: "Uma Uploader", role: "member" });
  await addOrganizationMember(org.id, admin.id, "owner");
  await addOrganizationMember(org.id, member.id, "member");
  await addOrganizationMember(org.id, other.id, "member");
  await addOrganizationMember(orgB.id, admin.id, "owner");
  const album = await createAlbum(admin.id, "Spring Open", org.id);
  const albumB = await createAlbum(admin.id, "Other album", orgB.id);

  const base = { organizationId: org.id, albumId: album.id };
  await addPhoto("morning", { ...base, uploaderId: admin.id, takenAt: "2026-03-10T08:00:00Z", similarity: 0.99, desc: "archer smiling on the range", quality: 8 });
  await addPhoto("lateEndDay", { ...base, uploaderId: other.id, takenAt: "2026-03-10T21:30:00Z", similarity: 0.97, desc: "archer at full draw", quality: 4 });
  await addPhoto("nextDay", { ...base, uploaderId: admin.id, takenAt: "2026-03-11T00:30:00Z", similarity: 0.95, desc: "archer packing up near the crowd" });
  await addPhoto("hidden", { ...base, uploaderId: admin.id, takenAt: "2026-03-10T12:00:00Z", similarity: 0.93, desc: "archer hidden shot", hidden: true });
  await addPhoto("undated", { ...base, uploaderId: other.id, takenAt: null, similarity: 0.91, desc: "archer undated scan" });
  // Least similar, so an unfiltered topK/limit cuts it off first.
  await addPhoto("future", { ...base, uploaderId: other.id, takenAt: "2030-06-01T12:00:00Z", similarity: 0.5, desc: "archer in 2030", quality: 9 });
  await addPhoto("otherOrgFuture", { organizationId: orgB.id, albumId: albumB.id, uploaderId: admin.id, takenAt: "2030-06-01T12:00:00Z", similarity: 0.999, desc: "archer other org" });

  await ratePhoto(P.morning, member.id, 5);
  await ratePhoto(P.lateEndDay, member.id, 2);
  await ratePhoto(P.future, member.id, 4);

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

type Mode = "keyword" | "semantic";

async function search(mode: Mode, params: Record<string, string | string[]>, as = admin): Promise<{ status: number; ids: number[]; body: unknown }> {
  const qs = new URLSearchParams();
  qs.set("q", "archer");
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x);
  const path = mode === "keyword" ? "/api/search" : "/api/search/semantic";
  const res = await fetch(`${baseUrl}${path}?${qs}`, { headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgId) } });
  const body = (await res.json()) as unknown;
  const photos = mode === "keyword" ? (body as { photos?: { id: number }[] }).photos : (body as { id: number }[]);
  return { status: res.status, ids: Array.isArray(photos) ? photos.map((p) => p.id) : [], body };
}

const ids = (...keys: string[]) => keys.map((k) => P[k]).sort((a, b) => a - b);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

describe("reproduction: future-date filter survives a mode switch (TT-VPX-FILTER-01)", () => {
  it.each(["keyword", "semantic"] as const)("%s search with dateFrom=2030-01-01 returns no 2026 photos", async (mode) => {
    const r = await search(mode, { dateFrom: "2030-01-01" });
    expect(r.status).toBe(200);
    expect(sorted(r.ids)).toEqual(ids("future"));
  });
});

describe.each(["keyword", "semantic"] as const)("%s mode enforces every filter (TT-VPX-FILTER-02)", (mode) => {
  it("treats dateTo as an inclusive whole day, with non-midnight capture times", async () => {
    const r = await search(mode, { dateFrom: "2026-03-10", dateTo: "2026-03-10" });
    // 08:00 and 21:30 on the 10th are in; 00:30 on the 11th, hidden and undated are out.
    expect(sorted(r.ids)).toEqual(ids("morning", "lateEndDay"));
  });

  it("applies date bounds on their own", async () => {
    expect(sorted((await search(mode, { dateTo: "2026-03-10" })).ids)).toEqual(ids("morning", "lateEndDay"));
    expect(sorted((await search(mode, { dateFrom: "2026-03-11" })).ids)).toEqual(ids("nextDay", "future"));
  });

  it("applies minimum and maximum average rating (unrated counts as 0)", async () => {
    expect(sorted((await search(mode, { ratingMin: "4" })).ids)).toEqual(ids("morning", "future"));
    expect(sorted((await search(mode, { ratingMax: "2" })).ids)).toEqual(ids("lateEndDay", "nextDay", "undated"));
  });

  it("applies the AI quality floor", async () => {
    expect(sorted((await search(mode, { minQuality: "8" })).ids)).toEqual(ids("morning", "future"));
  });

  it("applies the uploader filter", async () => {
    expect(sorted((await search(mode, { uploaderId: String(other.id) })).ids)).toEqual(ids("lateEndDay", "undated", "future"));
  });

  it("combines filters", async () => {
    const r = await search(mode, { dateTo: "2026-12-31", ratingMin: "2", uploaderId: String(other.id) });
    expect(sorted(r.ids)).toEqual(ids("lateEndDay"));
  });

  it("filters before the result limit, so a low-ranked match is still found", async () => {
    const limit: Record<string, string> = mode === "keyword" ? { limit: "1" } : { topK: "1" };
    expect((await search(mode, { ...limit, dateFrom: "2030-01-01" })).ids).toEqual(ids("future"));
  });

  it("shows hidden photos only to admins who ask, and never another org's photos", async () => {
    const day = { dateFrom: "2026-03-10", dateTo: "2026-03-10" };
    expect(sorted((await search(mode, { ...day, includeHidden: "true" })).ids)).toEqual(ids("morning", "lateEndDay", "hidden"));
    expect(sorted((await search(mode, { ...day, includeHidden: "true" }, member)).ids)).toEqual(ids("morning", "lateEndDay"));
    const all = await search(mode, { dateFrom: "2030-01-01", includeHidden: "true" });
    expect(all.ids).not.toContain(P.otherOrgFuture);
  });

  it.each([
    [{ dateFrom: "2026-03-12", dateTo: "2026-03-10" }, "dateFrom must be on or before dateTo"],
    [{ dateFrom: "2026-02-30" }, "dateFrom must be a date"],
    [{ dateTo: "March 10" }, "dateTo must be a date"],
    [{ ratingMin: "4", ratingMax: "2" }, "ratingMin must be at most ratingMax"],
    [{ ratingMin: "9" }, "ratingMin must be a number"],
    [{ uploaderId: "abc" }, "uploaderId must be a positive integer"],
  ])("rejects invalid filters %j instead of ignoring them", async (params, message) => {
    const r = await search(mode, params as Record<string, string>);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain(message);
  });
});

describe("exclusions", () => {
  it("keyword exclusion removes matching photos", async () => {
    const r = await search("keyword", { exclude: "crowd" });
    expect(r.ids).not.toContain(P.nextDay);
    expect(r.ids).toContain(P.morning);
  });

  it("semantic exclusion re-ranks but keeps date filters hard", async () => {
    const r = await search("semantic", { exclude: "crowd", dateFrom: "2026-03-11" });
    expect(sorted(r.ids)).toEqual(ids("nextDay", "future"));
  });
});

describe("Photos page date filter uses the same inclusive day", () => {
  it("includes the whole dateTo day", async () => {
    const res = await fetch(`${baseUrl}/api/photos?dateFrom=2026-03-10&dateTo=2026-03-10`, {
      headers: { "x-test-auth-user": admin.authUserId, "x-organization-id": String(orgId) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { photos?: { id: number }[] } | { id: number }[];
    const list = Array.isArray(body) ? body : body.photos ?? [];
    expect(sorted(list.map((p) => p.id))).toEqual(ids("morning", "lateEndDay"));
  });
});
