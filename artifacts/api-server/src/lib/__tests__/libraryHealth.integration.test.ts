import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Dashboard library health (#217): configured vs verified-working state,
// coverage with denominators, exact vs near duplicates, org scoping. Provider
// configuration is faked by DB rows (no key is ever used and no provider is
// called — the endpoint only reads recorded outcomes).
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
import { eq } from "drizzle-orm";
import app from "../../app";
import {
  db,
  pool,
  photosTable,
  organizationSettingsTable,
  aiAnalysisEventsTable,
  photoEmbeddingsTable,
  nearDuplicatePairsTable,
  EMBEDDING_DIMENSION,
} from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";
import { deriveHealthState, classifyAnalysisFailure, STALE_EVIDENCE_MS } from "../libraryHealth";
import { recordEmbeddingFailure, recordEmbeddingSuccess, resetEmbeddingHealth } from "../embeddingHealth";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let orgA: number;
let orgB: number;
let admin: U;
let member: U;
let otherAdmin: U;
let albumA: number;
let albumB: number;

const AI_ENV = ["AI_INTEGRATIONS_OPENAI_API_KEY", "AI_INTEGRATIONS_ANTHROPIC_API_KEY", "AI_INTEGRATIONS_GEMINI_API_KEY"];
const origEnv: Record<string, string | undefined> = {};
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  for (const k of [...AI_ENV, "VERTEX_PROJECT"]) origEnv[k] = process.env[k];
  for (const k of AI_ENV) delete process.env[k];
  await resetDb();
  orgA = (await createOrganization({ name: "Health A" })).id;
  orgB = (await createOrganization({ name: "Health B" })).id;
  admin = await createUser({ name: "admin" });
  member = await createUser({ name: "member" });
  otherAdmin = await createUser({ name: "otherAdmin" });
  await addOrganizationMember(orgA, admin.id, "admin");
  await addOrganizationMember(orgA, member.id, "member");
  await addOrganizationMember(orgB, otherAdmin.id, "owner");
  albumA = (await createAlbum(admin.id, "A", orgA)).id;
  albumB = (await createAlbum(otherAdmin.id, "B", orgB)).id;
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  resetEmbeddingHealth();
  delete process.env.VERTEX_PROJECT;
  await db.delete(aiAnalysisEventsTable);
  await db.delete(photoEmbeddingsTable);
  await db.delete(nearDuplicatePairsTable);
  await db.delete(photosTable);
  await db.delete(organizationSettingsTable);
});

async function health(as: U = admin, org = orgA) {
  const res = await fetch(`${base}/admin/library-health`, {
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org) },
  });
  return { status: res.status, text: await res.text() };
}
async function getHealth(as: U = admin, org = orgA) {
  const r = await health(as, org);
  expect(r.status).toBe(200);
  return JSON.parse(r.text);
}

async function setSettings(orgId: number, v: Partial<typeof organizationSettingsTable.$inferInsert>) {
  await db
    .insert(organizationSettingsTable)
    .values({ organizationId: orgId, ...v })
    .onConflictDoUpdate({ target: organizationSettingsTable.organizationId, set: v });
}
const withKey = { openaiKeyCiphertext: "fake-ciphertext", openaiKeyIv: "iv", openaiKeyTag: "tag", openaiKeyPreview: "sk-...abcd" };

async function photo(orgId: number, albumId: number, uploader: U, opts: Parameters<typeof createPhoto>[2] = {}) {
  return createPhoto(albumId, uploader.id, { organizationId: orgId, ...opts });
}
async function event(photoId: number, status: "success" | "failed" | "skipped", at: Date, errorMessage?: string) {
  await db.insert(aiAnalysisEventsTable).values({ photoId, status, provider: "openai", errorMessage: errorMessage ?? null, createdAt: at });
}

describe("deriveHealthState (pure)", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it("covers every state", () => {
    expect(deriveHealthState({ configured: false, lastSuccessAt: ago(1000), lastFailureAt: null, now })).toBe("not_configured");
    expect(deriveHealthState({ configured: true, lastSuccessAt: null, lastFailureAt: null, now })).toBe("configured");
    expect(deriveHealthState({ configured: true, lastSuccessAt: ago(1000), lastFailureAt: null, now })).toBe("working");
    expect(deriveHealthState({ configured: true, lastSuccessAt: ago(5000), lastFailureAt: ago(1000), now })).toBe("failing");
    expect(deriveHealthState({ configured: true, lastSuccessAt: ago(1000), lastFailureAt: ago(5000), now })).toBe("working");
    expect(deriveHealthState({ configured: true, lastSuccessAt: ago(STALE_EVIDENCE_MS + 1), lastFailureAt: null, now })).toBe("stale");
    expect(deriveHealthState({ configured: true, lastSuccessAt: null, lastFailureAt: ago(STALE_EVIDENCE_MS + 1), now })).toBe("stale");
  });
  it("classifies failures into fixed safe reasons", () => {
    expect(classifyAnalysisFailure("429 You exceeded your current quota").code).toBe("quota");
    expect(classifyAnalysisFailure("401 Incorrect API key provided: sk-live-abc").code).toBe("auth");
    expect(classifyAnalysisFailure("request timed out").code).toBe("timeout");
    expect(classifyAnalysisFailure("Provider returned no result").code).toBe("no_result");
    expect(classifyAnalysisFailure("boom").code).toBe("provider_error");
    expect(classifyAnalysisFailure("401 Incorrect API key provided: sk-live-abc").message).not.toContain("sk-live");
  });
});

describe("GET /admin/library-health", () => {
  it("is limited to org owners/admins", async () => {
    expect((await health(member)).status).toBe(403);
    expect((await health(admin)).status).toBe(200);
  });

  it("image analysis: not configured -> configured -> working -> failing -> recovered -> stale", async () => {
    const p = await photo(orgA, albumA, admin);

    // No key and no env fallback: not configured.
    expect((await getHealth()).imageAnalysis.state).toBe("not_configured");

    // A key alone is "configured, not yet verified" — never "working".
    await setSettings(orgA, withKey);
    let h = (await getHealth()).imageAnalysis;
    expect(h.state).toBe("configured");
    expect(h.provider).toBe("openai");
    expect(h.lastSuccessAt).toBeNull();

    // AI switched off for the org is not configured even with a key.
    await setSettings(orgA, { aiEnabled: false });
    expect((await getHealth()).imageAnalysis.state).toBe("not_configured");
    await setSettings(orgA, { aiEnabled: true });

    // A recorded success: working.
    const t1 = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await event(p.id, "success", t1);
    h = (await getHealth()).imageAnalysis;
    expect(h.state).toBe("working");
    expect(new Date(h.lastSuccessAt).getTime()).toBe(t1.getTime());
    expect(h.failureReason).toBeNull();

    // A newer failure (quota): failing, with a safe fixed reason and no raw text.
    const t2 = new Date(Date.now() - 60 * 60 * 1000);
    await event(p.id, "failed", t2, "429 You exceeded your current quota, key sk-SECRET-123");
    const r = await health();
    const f = JSON.parse(r.text).imageAnalysis;
    expect(f.state).toBe("failing");
    expect(f.failureReason.code).toBe("quota");
    expect(f.lastFailureAt).toBeTruthy();
    expect(r.text).not.toContain("sk-SECRET");
    expect(r.text).not.toContain("exceeded your current quota");

    // A later success: recovered.
    await event(p.id, "success", new Date());
    expect((await getHealth()).imageAnalysis.state).toBe("working");

    // Evidence older than the window: stale (not "working").
    await db.delete(aiAnalysisEventsTable);
    await event(p.id, "success", new Date(Date.now() - (STALE_EVIDENCE_MS + DAY)));
    expect((await getHealth()).imageAnalysis.state).toBe("stale");
  });

  it("skipped analysis attempts are not evidence of health", async () => {
    await setSettings(orgA, withKey);
    const p = await photo(orgA, albumA, admin);
    await event(p.id, "skipped", new Date(), "AI disabled");
    expect((await getHealth()).imageAnalysis.state).toBe("configured");
  });

  it("analysis coverage reports denominators and ignores other orgs", async () => {
    await setSettings(orgA, withKey);
    const done1 = await photo(orgA, albumA, admin, { aiDescription: "a" });
    await photo(orgA, albumA, admin, { aiDescription: "b" });
    const failed = await photo(orgA, albumA, admin);
    await photo(orgA, albumA, admin); // pending
    await event(failed.id, "failed", new Date(Date.now() - 1000), "provider exploded");
    await event(done1.id, "success", new Date());
    // Another org's photos, events and failures must not count here.
    const bPhoto = await photo(orgB, albumB, otherAdmin);
    await photo(orgB, albumB, otherAdmin, { aiDescription: "x" });
    await event(bPhoto.id, "failed", new Date(), "boom");

    const h = (await getHealth()).imageAnalysis;
    expect(h.coverage).toEqual({ total: 4, analysed: 2, failed: 1, pending: 1 });
    // Org A's latest failure is older than its success -> working, not failing.
    expect(h.state).toBe("working");

    const b = (await getHealth(otherAdmin, orgB)).imageAnalysis;
    expect(b.coverage).toEqual({ total: 2, analysed: 1, failed: 1, pending: 0 });
    expect(b.state).toBe("not_configured");
  });

  it("an empty library has zero coverage rather than errors", async () => {
    const h = await getHealth();
    expect(h.imageAnalysis.coverage).toEqual({ total: 0, analysed: 0, failed: 0, pending: 0 });
    expect(h.imageEmbeddings.coverage).toEqual({ total: 0, embedded: 0, missing: 0, refreshPending: 0 });
    expect(h.duplicates.exact.groups).toBe(0);
    expect(h.duplicates.near.groups).toBe(0);
  });

  it("image embeddings: coverage from rows, state from config + last embedding", async () => {
    const vec = Array.from({ length: EMBEDDING_DIMENSION }, () => 0.01);
    const p1 = await photo(orgA, albumA, admin);
    const p2 = await photo(orgA, albumA, admin);
    const p3 = await photo(orgA, albumA, admin);
    const noBytes = await photo(orgA, albumA, admin); // no storageKey: not embeddable, not in the denominator
    for (const p of [p1, p2, p3]) await db.update(photosTable).set({ storageKey: `/objects/uploads/${p.id}` }).where(eq(photosTable.id, p.id));
    void noBytes;
    const bP = await photo(orgB, albumB, otherAdmin);
    await db.update(photosTable).set({ storageKey: `/objects/uploads/${bP.id}` }).where(eq(photosTable.id, bP.id));
    const t = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(photoEmbeddingsTable).values([
      { photoId: p1.id, organizationId: orgA, embedding: vec, model: "vertex/multimodalembedding@001+desc", createdAt: t },
      { photoId: bP.id, organizationId: orgB, embedding: vec, model: "vertex/multimodalembedding@001+desc" },
    ]);

    // Embeddings off for the org: not configured.
    expect((await getHealth()).imageEmbeddings.state).toBe("not_configured");

    // Enabled but the server has no Vertex project: still not configured.
    await setSettings(orgA, { embeddingEnabled: true });
    expect((await getHealth()).imageEmbeddings.state).toBe("not_configured");

    process.env.VERTEX_PROJECT = "test-project";
    let h = (await getHealth()).imageEmbeddings;
    expect(h.state).toBe("working"); // an embedding row exists from t
    expect(h.coverage).toMatchObject({ total: 3, embedded: 1, missing: 2 });
    expect(new Date(h.lastSuccessAt).getTime()).toBe(t.getTime());

    // A newer real failure flips to failing with a fixed reason.
    recordEmbeddingFailure("image", orgA, "provider_error");
    h = (await getHealth()).imageEmbeddings;
    expect(h.state).toBe("failing");
    expect(h.failureReason?.code).toBe("provider_error");
    // ...and another org's record doesn't leak in.
    recordEmbeddingFailure("image", orgB, "timeout");
    expect((await getHealth()).imageEmbeddings.failureReason?.code).toBe("provider_error");
  });

  it("search (query embedding) readiness is separate from image embeddings", async () => {
    // Not configured without a Vertex project.
    expect((await getHealth()).searchEmbedding.state).toBe("not_configured");

    process.env.VERTEX_PROJECT = "test-project";
    // Configured but never used since boot: not yet verified.
    let s = (await getHealth()).searchEmbedding;
    expect(s.state).toBe("configured");
    expect(s.lastSuccessAt).toBeNull();

    recordEmbeddingSuccess("query", orgA);
    s = (await getHealth()).searchEmbedding;
    expect(s.state).toBe("working");

    recordEmbeddingFailure("query", orgA, "timeout", new Date(Date.now() + 1000));
    s = (await getHealth()).searchEmbedding;
    expect(s.state).toBe("failing");
    expect(s.failureReason?.code).toBe("timeout");

    // Image-embedding evidence does not make search look healthy, and other orgs are separate.
    recordEmbeddingSuccess("image", orgA);
    recordEmbeddingSuccess("query", orgB);
    expect((await getHealth()).searchEmbedding.state).toBe("failing");

    // Old evidence goes stale.
    resetEmbeddingHealth();
    recordEmbeddingSuccess("query", orgA, new Date(Date.now() - (STALE_EVIDENCE_MS + DAY)));
    expect((await getHealth()).searchEmbedding.state).toBe("stale");
  });

  it("counts exact and near duplicates separately, scoped to the org", async () => {
    // Exact: two photos share a content hash in org A; org B has its own pair.
    const e1 = await photo(orgA, albumA, admin);
    const e2 = await photo(orgA, albumA, admin);
    const e3 = await photo(orgA, albumA, admin);
    const solo = await photo(orgA, albumA, admin);
    await db.update(photosTable).set({ contentHash: "same-hash" }).where(eq(photosTable.id, e1.id));
    await db.update(photosTable).set({ contentHash: "same-hash" }).where(eq(photosTable.id, e2.id));
    await db.update(photosTable).set({ contentHash: "other-hash" }).where(eq(photosTable.id, solo.id));
    const b1 = await photo(orgB, albumB, otherAdmin);
    const b2 = await photo(orgB, albumB, otherAdmin);
    await db.update(photosTable).set({ contentHash: "b-hash" }).where(eq(photosTable.id, b1.id));
    await db.update(photosTable).set({ contentHash: "b-hash" }).where(eq(photosTable.id, b2.id));

    // Near: e2~e3 and e3~solo form one 3-photo group in org A (distance within the default threshold);
    // a different-org pair and an over-threshold pair don't count.
    const pair = (a: number, b: number) => (a < b ? { photoA: a, photoB: b } : { photoA: b, photoB: a });
    await db.update(photosTable).set({ perceptualHash: "0000000000000000" }).where(eq(photosTable.organizationId, orgA));
    await db.insert(nearDuplicatePairsTable).values([
      { organizationId: orgA, ...pair(e2.id, e3.id), distance: 2 },
      { organizationId: orgA, ...pair(e3.id, solo.id), distance: 4 },
      { organizationId: orgA, ...pair(e1.id, solo.id), distance: 9 }, // beyond default threshold of 6
      { organizationId: orgB, ...pair(b1.id, b2.id), distance: 1 },
    ]);

    const d = (await getHealth()).duplicates;
    expect(d.exact).toMatchObject({ groups: 1, hashedPhotos: 3, totalPhotos: 4 });
    expect(d.exact.extraCopies).toBe(1);
    expect(d.near).toMatchObject({ groups: 1, photos: 3, indexedPhotos: 4, totalPhotos: 4 });

    const bd = (await getHealth(otherAdmin, orgB)).duplicates;
    expect(bd.exact.groups).toBe(1);
    expect(bd.near).toMatchObject({ groups: 1, photos: 2 });
  });
});
