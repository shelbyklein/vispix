import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Collection recommendation lifecycle (#212, docs/COLLECTION_SUGGESTIONS.md):
// pending -> accepted | dismissed, decisions are idempotent, re-analysis never
// resurrects a decided suggestion, hand-added membership resolves a pending
// one, and hidden-photo / role / org rules hold for every decision.
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
// Provider boundary only: the model result is scripted, no image bytes or call.
type Scripted = { suggestedCollectionIds: number[]; suggestedNewCollectionNames?: string[] };
let scripted: Scripted = { suggestedCollectionIds: [] };
vi.mock("../aiProviders", async (o) => ({
  ...(await o<typeof import("../aiProviders")>()),
  getActiveProvider: async () => ({
    provider: {
      id: "openai",
      model: "test-model-1",
      analyze: async () => ({ description: "A scripted description", ...scripted }),
      generateText: async () => null,
    },
    settings: {},
  }),
}));
vi.mock("../aiEmbedding", () => ({ generateAndStorePhotoEmbedding: async () => {} }));

import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import app from "../../app";
import {
  db,
  pool,
  photosTable,
  collectionsTable,
  collectionNegativePhotosTable,
  photoCollectionsTable,
  photoCollectionSuggestionsTable,
  photoNewCollectionSuggestionsTable,
} from "@workspace/db";
import { runAndRecordPhotoAnalysis } from "../aiPhotoAnalysis";
import { ANALYSIS_VERSION } from "../collectionSuggestions";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, createCollection, addPhotoToCollection } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let org: number;
let otherOrg: number;
let owner: U; // photo uploader + member
let stranger: U; // member who neither uploaded nor created anything
let admin: U;
let outsider: U; // member of another org only
let albumId: number;
let photoId: number;
let youth: { id: number };
let targets: { id: number };

beforeAll(async () => {
  await resetDb();
  org = (await createOrganization({ name: "Sugg A" })).id;
  otherOrg = (await createOrganization({ name: "Sugg B" })).id;
  owner = await createUser({ name: "owner" });
  stranger = await createUser({ name: "stranger" });
  admin = await createUser({ name: "admin" });
  outsider = await createUser({ name: "outsider" });
  await addOrganizationMember(org, owner.id, "member");
  await addOrganizationMember(org, stranger.id, "member");
  await addOrganizationMember(org, admin.id, "admin");
  await addOrganizationMember(otherOrg, outsider.id, "admin");
  albumId = (await createAlbum(owner.id, "Album", org)).id;
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

// Fresh photo + two collections per test so states never leak between cases.
beforeEach(async () => {
  await db.delete(photoCollectionsTable);
  await db.delete(collectionNegativePhotosTable);
  await db.delete(collectionsTable);
  photoId = (await createPhoto(albumId, owner.id, { organizationId: org })).id;
  youth = await createCollection(owner.id, "Youth", org);
  targets = await createCollection(owner.id, "Targets", org);
  scripted = { suggestedCollectionIds: [] };
});

async function call(as: U, method: string, path: string, body?: unknown, orgId = org) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgId), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function analyze(ids: number[], newNames: string[] = [], pid = photoId) {
  scripted = { suggestedCollectionIds: ids, suggestedNewCollectionNames: newNames };
  await runAndRecordPhotoAnalysis(pid);
}
const suggestedIds = async (as: U = owner, pid = photoId) =>
  ((await call(as, "GET", `/photos/${pid}`)).body.suggestedCollections as { id: number }[]).map((s) => s.id).sort((x, y) => x - y);
const membership = async (collectionId: number, pid = photoId) =>
  db.select().from(photoCollectionsTable).where(and(eq(photoCollectionsTable.collectionId, collectionId), eq(photoCollectionsTable.photoId, pid)));
const suggestionRow = async (collectionId: number, pid = photoId) =>
  (await db.select().from(photoCollectionSuggestionsTable).where(and(eq(photoCollectionSuggestionsTable.collectionId, collectionId), eq(photoCollectionSuggestionsTable.photoId, pid))))[0];

describe("analysis writes provenance", () => {
  it("records model source, provider, model id and analysis version on each pending suggestion", async () => {
    await analyze([youth.id], ["Brand New"]);
    const photo = (await call(owner, "GET", `/photos/${photoId}`)).body;
    expect(photo.suggestedCollections).toEqual([
      expect.objectContaining({ id: youth.id, title: "Youth", source: "model", provider: "openai", model: "test-model-1", analysisVersion: ANALYSIS_VERSION, reason: expect.any(String) }),
    ]);
    // New-collection names are only offered when no existing collection fits.
    expect(photo.suggestedNewCollections).toEqual([]);
    await analyze([], ["Brand New"]);
    const again = (await call(owner, "GET", `/photos/${photoId}`)).body;
    expect(again.suggestedNewCollections).toEqual([
      expect.objectContaining({ suggestedName: "Brand New", source: "model", model: "test-model-1", analysisVersion: ANALYSIS_VERSION }),
    ]);
  });

  it("serves the same list from the single-photo and list endpoints", async () => {
    await analyze([youth.id, targets.id]);
    const single = (await call(owner, "GET", `/photos/${photoId}`)).body.suggestedCollections;
    const list = (await call(owner, "GET", `/albums/${albumId}/photos`)).body;
    const fromList = (Array.isArray(list) ? list : list.photos).find((p: { id: number }) => p.id === photoId).suggestedCollections;
    expect(fromList).toEqual(single);
    expect(single).toHaveLength(2);
  });
});

describe("accept / dismiss", () => {
  it("accept adds exactly one membership and is idempotent", async () => {
    await analyze([youth.id]);
    const first = await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`);
    expect(first.status).toBe(200);
    expect(first.body.suggestedCollections).toEqual([]);
    expect(first.body.photoCollections.map((c: { id: number }) => c.id)).toEqual([youth.id]);
    const again = await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`);
    expect(again.status).toBe(200);
    expect(await membership(youth.id)).toHaveLength(1);
    const row = await suggestionRow(youth.id);
    expect(row).toMatchObject({ status: "accepted", resolution: "review", decidedById: owner.id });
    expect(row.decidedAt).not.toBeNull();
    // The opposite decision on a resolved suggestion is rejected, not applied.
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`)).status).toBe(409);
    expect((await suggestionRow(youth.id)).status).toBe("accepted");
  });

  it("dismiss persists across reads, is idempotent, and never adds membership", async () => {
    await analyze([youth.id, targets.id]);
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`)).status).toBe(200);
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`)).status).toBe(200);
    expect(await suggestedIds()).toEqual([targets.id]);
    expect(await membership(youth.id)).toHaveLength(0);
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`)).status).toBe(409);
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/99999/accept`)).status).toBe(404);
  });

  it("accepting clears a negative example for the pair but leaves other negatives alone", async () => {
    await analyze([youth.id]);
    await db.insert(collectionNegativePhotosTable).values([
      { collectionId: youth.id, photoId },
      { collectionId: targets.id, photoId },
    ]);
    await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`);
    const negatives = await db.select().from(collectionNegativePhotosTable).where(eq(collectionNegativePhotosTable.photoId, photoId));
    expect(negatives.map((n) => n.collectionId)).toEqual([targets.id]);
  });

  it("new-collection suggestion: accept creates one collection even when repeated; dismiss is idempotent", async () => {
    await analyze([], ["Fresh Idea", "Other Idea"]);
    const photo = (await call(owner, "GET", `/photos/${photoId}`)).body;
    const [fresh, other] = photo.suggestedNewCollections;
    const before = (await db.select().from(collectionsTable)).length;
    expect((await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${fresh.id}/accept`, {})).status).toBe(200);
    expect((await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${fresh.id}/accept`, {})).status).toBe(200);
    expect((await db.select().from(collectionsTable)).length).toBe(before + 1);
    expect((await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${other.id}/dismiss`)).status).toBe(200);
    expect((await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${other.id}/dismiss`)).status).toBe(200);
    expect((await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${other.id}/accept`, {})).status).toBe(409);
    expect((await call(owner, "GET", `/photos/${photoId}`)).body.suggestedNewCollections).toEqual([]);
  });
});

describe("re-analysis respects decisions", () => {
  it("never resurrects a dismissed collection suggestion, but refreshes undecided ones", async () => {
    await analyze([youth.id, targets.id]);
    await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`);
    await analyze([youth.id, targets.id]);
    await analyze([youth.id]);
    expect(await suggestedIds()).toEqual([]);
    expect((await suggestionRow(youth.id)).status).toBe("dismissed");
    await analyze([youth.id, targets.id]);
    expect(await suggestedIds()).toEqual([targets.id]);
  });

  it("does not re-offer an accepted suggestion or a collection the photo is already in", async () => {
    await analyze([youth.id]);
    await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`);
    await call(owner, "DELETE", `/collections/${youth.id}/photos/${photoId}`);
    await addPhotoToCollection(targets.id, photoId);
    await analyze([youth.id, targets.id]);
    // youth: decided (accepted) earlier, even though membership was later removed by a human.
    expect(await suggestedIds()).toEqual([]);
    expect(await membership(youth.id)).toHaveLength(0);
    expect(await membership(targets.id)).toHaveLength(1);
  });

  it("does not re-offer a dismissed or accepted new-collection name (case/whitespace-insensitive)", async () => {
    await analyze([], ["Fresh Idea", "Other Idea"]);
    const [fresh, other] = (await call(owner, "GET", `/photos/${photoId}`)).body.suggestedNewCollections;
    await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${fresh.id}/dismiss`);
    await call(owner, "POST", `/photos/${photoId}/new-collection-suggestions/${other.id}/accept`, {});
    await analyze([], ["Third Idea", "  fresh   idea "]);
    await analyze([], ["OTHER IDEA", "Third Idea"]);
    const names = (await call(owner, "GET", `/photos/${photoId}`)).body.suggestedNewCollections.map((s: { suggestedName: string }) => s.suggestedName);
    expect(names).toEqual(["Third Idea"]);
    const rows = await db.select().from(photoNewCollectionSuggestionsTable).where(eq(photoNewCollectionSuggestionsTable.photoId, photoId));
    expect(rows.filter((r) => r.status === "dismissed")).toHaveLength(1);
  });

  it("keeps people collections, memberships and negative examples untouched", async () => {
    const [person] = await db.insert(collectionsTable).values({ title: "Jane", kind: "person", createdById: owner.id, organizationId: org }).returning();
    await addPhotoToCollection(person.id, photoId);
    await db.insert(collectionNegativePhotosTable).values({ collectionId: targets.id, photoId });
    // A (bogus) model answer naming the person collection must never surface.
    await db.insert(photoCollectionSuggestionsTable).values({ photoId, collectionId: person.id, status: "pending" });
    await analyze([youth.id]);
    expect(await suggestedIds()).toEqual([youth.id]);
    expect(await membership(person.id)).toHaveLength(1);
    expect(await db.select().from(collectionNegativePhotosTable).where(eq(collectionNegativePhotosTable.photoId, photoId))).toHaveLength(1);
  });
});

describe("manual membership", () => {
  it("resolves a pending suggestion as accepted/manual without duplicating membership", async () => {
    await analyze([youth.id, targets.id]);
    expect((await call(owner, "POST", `/collections/${youth.id}/photos`, { photoId })).status).toBe(204);
    expect((await call(owner, "POST", `/collections/${youth.id}/photos`, { photoId })).status).toBe(204);
    expect(await membership(youth.id)).toHaveLength(1);
    expect(await suggestedIds()).toEqual([targets.id]);
    expect(await suggestionRow(youth.id)).toMatchObject({ status: "accepted", resolution: "manual", decidedById: owner.id });
    // Accepting afterwards is the idempotent no-op, not a second membership.
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`)).status).toBe(200);
    expect(await membership(youth.id)).toHaveLength(1);
  });

  it("leaves a dismissed row dismissed when the human adds the photo anyway", async () => {
    await analyze([youth.id]);
    await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`);
    await call(owner, "POST", `/collections/${youth.id}/photos`, { photoId });
    expect(await membership(youth.id)).toHaveLength(1);
    expect((await suggestionRow(youth.id)).status).toBe("dismissed");
  });

  it("never lists a pending suggestion for a collection the photo is already in", async () => {
    await analyze([youth.id]);
    await addPhotoToCollection(youth.id, photoId); // bypasses the route: raw membership
    expect(await suggestedIds()).toEqual([]);
  });
});

describe("roles, hidden photos and org isolation", () => {
  it("members who neither uploaded the photo nor made the collection cannot decide (403); managers can", async () => {
    await analyze([youth.id, targets.id]);
    expect((await call(stranger, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`)).status).toBe(403);
    expect((await call(stranger, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`)).status).toBe(403);
    expect((await call(admin, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`)).status).toBe(200);
  });

  it("hidden photos: members get 404 on read and decisions; managers can still decide", async () => {
    await analyze([youth.id]);
    await db.update(photosTable).set({ isHidden: true }).where(eq(photosTable.id, photoId));
    expect((await call(owner, "GET", `/photos/${photoId}`)).status).toBe(404);
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`)).status).toBe(404);
    expect((await call(owner, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`)).status).toBe(404);
    expect((await suggestionRow(youth.id)).status).toBe("pending");
    expect(await suggestedIds(admin)).toEqual([youth.id]);
    expect((await call(admin, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`)).status).toBe(200);
  });

  it("another org cannot read or decide suggestions, and foreign-org collections are never served", async () => {
    await analyze([youth.id]);
    expect((await call(outsider, "GET", `/photos/${photoId}`, undefined, otherOrg)).status).toBe(404);
    expect((await call(outsider, "POST", `/photos/${photoId}/suggestions/${youth.id}/accept`, undefined, otherOrg)).status).toBe(404);
    expect((await call(outsider, "POST", `/photos/${photoId}/suggestions/${youth.id}/dismiss`, undefined, otherOrg)).status).toBe(404);
    expect((await suggestionRow(youth.id)).status).toBe("pending");
    // A stray row pointing at another org's collection is not served either.
    const foreign = await createCollection(outsider.id, "Foreign", otherOrg);
    await db.insert(photoCollectionSuggestionsTable).values({ photoId, collectionId: foreign.id, status: "pending" });
    expect(await suggestedIds()).toEqual([youth.id]);
  });
});

describe("lifecycle on deletion", () => {
  it("deleting the collection or the photo removes their suggestion rows", async () => {
    await analyze([youth.id, targets.id], []);
    await call(owner, "DELETE", `/collections/${youth.id}`);
    expect(await suggestionRow(youth.id)).toBeUndefined();
    await call(owner, "DELETE", `/photos/${photoId}`);
    expect(await suggestionRow(targets.id)).toBeUndefined();
  });
});

describe("migration 0039 existing-data mapping", () => {
  it("maps legacy rows explicitly and deletes nothing", async () => {
    const sqlText = readFileSync(
      fileURLToPath(new URL("../../../../../lib/db/drizzle/0039_collection_suggestion_lifecycle.sql", import.meta.url)),
      "utf8",
    );
    const updates = sqlText.split("--> statement-breakpoint").filter((st) => /^(\s*--.*\n)*\s*UPDATE\b/.test(st));
    expect(updates.length).toBeGreaterThan(0);

    const [p2, p3, p4] = await Promise.all([1, 2, 3].map(() => createPhoto(albumId, owner.id, { organizationId: org })));
    const mk = (pid: number, cid: number, status: "pending" | "accepted" | "dismissed") =>
      db.insert(photoCollectionSuggestionsTable).values({ photoId: pid, collectionId: cid, status });
    await mk(p2.id, youth.id, "accepted"); // legacy accepted
    await mk(p2.id, targets.id, "dismissed"); // legacy dismissed
    await mk(p3.id, youth.id, "pending"); // pending, photo already a member
    await addPhotoToCollection(youth.id, p3.id);
    await mk(p4.id, youth.id, "pending"); // pending, still undecided
    await db.insert(collectionNegativePhotosTable).values({ collectionId: targets.id, photoId: p4.id });
    await db.insert(photoNewCollectionSuggestionsTable).values({ photoId: p4.id, suggestedName: "Old name", status: "dismissed" });

    for (const st of updates) await pool.query(st);
    for (const st of updates) await pool.query(st); // safe to re-run

    expect(await suggestionRow(youth.id, p2.id)).toMatchObject({ status: "accepted", resolution: "review", source: "model", provider: null, analysisVersion: null });
    expect(await suggestionRow(targets.id, p2.id)).toMatchObject({ status: "dismissed", resolution: "review" });
    expect(await suggestionRow(youth.id, p3.id)).toMatchObject({ status: "accepted", resolution: "manual" });
    expect(await suggestionRow(youth.id, p4.id)).toMatchObject({ status: "pending", resolution: null });
    expect((await membership(youth.id, p3.id)).length).toBe(1);
    expect(await db.select().from(collectionNegativePhotosTable).where(eq(collectionNegativePhotosTable.photoId, p4.id))).toHaveLength(1);
    const legacyNew = await db.select().from(photoNewCollectionSuggestionsTable).where(eq(photoNewCollectionSuggestionsTable.photoId, p4.id));
    expect(legacyNew).toEqual([expect.objectContaining({ status: "dismissed", resolution: "review", source: "model" })]);
  });
});
