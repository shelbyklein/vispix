import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Photo Graph (#202): the threads around one photo — each kind, ordering,
// org isolation, hidden-photo visibility by role, depth, limits and params.
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
import {
  db, pool, photosTable, photoEmbeddingsTable, nearDuplicatePairsTable, collectionsTable,
  attributionTagsTable, photoAttributionTagsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto, addPhotoToCollection } from "./testDb";

const DIM = 1408;
function unit(parts: Record<number, number>): number[] {
  const v = new Array(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const near = (s: number) => unit({ 0: s, 1: Math.sqrt(1 - s * s) });

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let orgA: number;
let orgB: number;
let admin: U;
let member: U;
let outsider: U;
const P: Record<string, number> = {};

type Graph = {
  seedId: number;
  nodes: { id: number; ring: number; albumTitle: string | null; embedded: boolean }[];
  edges: { source: number; target: number; kind: string; weight: number; label: string }[];
  truncated: boolean;
  unavailable: { photoId: number; kind: string; reason: string }[];
};

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Graph A" })).id;
  orgB = (await createOrganization({ name: "Graph B" })).id;
  admin = await createUser({ name: "Admin" });
  member = await createUser({ name: "Member" });
  outsider = await createUser({ name: "Outsider" });
  await addOrganizationMember(orgA, admin.id, "admin");
  await addOrganizationMember(orgA, member.id, "member");
  await addOrganizationMember(orgB, outsider.id, "owner");

  const nationals = await createAlbum(admin.id, "Nationals", orgA);
  const spring = await createAlbum(admin.id, "Spring Open", orgA);
  const elsewhere = await createAlbum(outsider.id, "Nationals", orgB);
  const t0 = new Date("2026-05-01T10:00:00Z").getTime();
  const add = async (key: string, album: number, o: { at?: number; hidden?: boolean; org?: number; vec?: number[] } = {}) => {
    const p = await createPhoto(album, admin.id, { organizationId: o.org ?? orgA, isHidden: o.hidden ?? false });
    await db.update(photosTable).set({ filename: `${key}.jpg`, ...(o.at !== undefined ? { takenAt: new Date(t0 + o.at * 1000) } : {}) }).where(eq(photosTable.id, p.id));
    if (o.vec) await db.insert(photoEmbeddingsTable).values({ photoId: p.id, organizationId: o.org ?? orgA, embedding: o.vec, model: "test" });
    P[key] = p.id;
  };
  await add("seed", nationals.id, { at: 0, vec: unit({ 0: 1 }) });
  await add("s1", spring.id, { at: 86400, vec: near(0.99) });
  await add("s2", spring.id, { at: 86400, vec: near(0.9) });
  await add("s3", spring.id, { at: 86400, vec: near(0.7) });
  await add("hidden", spring.id, { at: 86400, hidden: true, vec: near(0.995) });
  await add("e1", nationals.id, { at: 60 });
  await add("e2", nationals.id, { at: 3600 });
  await add("dup", spring.id, { at: 90000 });
  await add("p1", spring.id, { at: 864000 });
  await add("r1", spring.id, { at: 900000 });
  // Another org's photo: identical embedding, same album title and person name.
  await add("foreign", elsewhere.id, { at: 0, org: orgB, vec: unit({ 0: 1 }) });

  const [a, b] = [P.seed, P.dup].sort((x, y) => x - y);
  await db.insert(nearDuplicatePairsTable).values({ organizationId: orgA, photoA: a, photoB: b, distance: 2 });
  const [ava] = await db.insert(collectionsTable).values({ organizationId: orgA, createdById: admin.id, title: "Ava R.", kind: "person" }).returning();
  await addPhotoToCollection(ava.id, P.seed);
  await addPhotoToCollection(ava.id, P.p1);
  await addPhotoToCollection(ava.id, P.hidden);
  const [avaB] = await db.insert(collectionsTable).values({ organizationId: orgB, createdById: outsider.id, title: "Ava R.", kind: "person" }).returning();
  await addPhotoToCollection(avaB.id, P.foreign);
  const [sponsor] = await db.insert(attributionTagsTable).values({ organizationId: orgA, name: "Sponsor" }).returning();
  await db.insert(photoAttributionTagsTable).values([{ photoId: P.seed, tagId: sponsor.id }, { photoId: P.r1, tagId: sponsor.id }]);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function graph(id: number, qs = "", as: U | null = member, org = orgA) {
  const res = await fetch(`${base}/photos/${id}/graph${qs ? `?${qs}` : ""}`, {
    headers: as ? { "x-test-auth-user": as.authUserId, "x-organization-id": String(org) } : {},
  });
  return { status: res.status, body: (res.status === 200 ? await res.json() : null) as Graph };
}
const targets = (g: Graph, kind: string, from = g.seedId) =>
  g.edges.filter((e) => e.kind === kind && (e.source === from || e.target === from)).map((e) => (e.source === from ? e.target : e.source));

describe("GET /photos/:id/graph", () => {
  it("returns each default thread kind around the centre photo, strongest first", async () => {
    const { status, body } = await graph(P.seed);
    expect(status).toBe(200);
    expect(body.nodes.find((n) => n.id === P.seed)).toMatchObject({ ring: 0, albumTitle: "Nationals", embedded: true });
    expect(targets(body, "similar")).toEqual([P.s1, P.s2, P.s3]);
    const sim = body.edges.filter((e) => e.kind === "similar").map((e) => e.weight);
    expect(sim).toEqual([...sim].sort((x, y) => y - x));
    expect(sim[0]).toBeCloseTo(0.99, 2);
    expect(targets(body, "duplicate")).toEqual([P.dup]);
    expect(body.edges.find((e) => e.kind === "person")).toMatchObject({ label: "Ava R." });
    expect(targets(body, "person")).toEqual([P.p1]);
    expect(targets(body, "event")).toEqual([P.e1, P.e2]); // nearest capture time first
    expect(body.edges.find((e) => e.kind === "event")?.label).toBe("Nationals");
    expect(targets(body, "rights")).toEqual([]); // opt-in
    for (const n of body.nodes.filter((n) => n.id !== P.seed)) expect(n.ring).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.unavailable).toEqual([]);
  });

  it("never includes another organization's photos", async () => {
    const all = await graph(P.seed, "threads=similar,duplicate,person,event,rights&perThread=12", admin);
    expect(all.body.nodes.map((n) => n.id)).not.toContain(P.foreign);
    expect((await graph(P.foreign, "", admin)).status).toBe(404); // foreign centre: no existence leak
    expect((await graph(P.seed, "", outsider, orgA)).status).toBe(403); // not a member of org A
    expect((await graph(P.seed, "", outsider, orgB)).status).toBe(404);
  });

  it("hides hidden photos from members but not from org admins", async () => {
    const m = await graph(P.seed);
    expect(m.body.nodes.map((n) => n.id)).not.toContain(P.hidden);
    const a = await graph(P.seed, "", admin);
    expect(targets(a.body, "similar")[0]).toBe(P.hidden);
    expect(targets(a.body, "person")).toContain(P.hidden);
    expect((await graph(P.hidden, "", member)).status).toBe(404);
    expect((await graph(P.hidden, "", admin)).status).toBe(200);
  });

  it("filters thread kinds and labels rights threads with the tag", async () => {
    const { body } = await graph(P.seed, "threads=rights");
    expect(new Set(body.edges.map((e) => e.kind))).toEqual(new Set(["rights"]));
    expect(body.edges).toEqual([expect.objectContaining({ label: "Sponsor" })]);
    expect(targets(body, "rights")).toEqual([P.r1]);
  });

  it("depth 2 grows a second ring from the strongest first-ring photos", async () => {
    const one = await graph(P.seed);
    const two = await graph(P.seed, "depth=2");
    expect(two.body.nodes.length).toBeGreaterThan(one.body.nodes.length);
    // r1 isn't linked to the centre by default threads; it's reached through a
    // first-ring photo in its album.
    expect(two.body.nodes.find((n) => n.id === P.r1)?.ring).toBe(2);
    const ring1 = new Set(two.body.nodes.filter((n) => n.ring === 1).map((n) => n.id));
    expect(two.body.edges.some((e) => e.kind === "event" && [e.source, e.target].includes(P.r1) && (ring1.has(e.source) || ring1.has(e.target)))).toBe(true);
    expect(two.body.nodes.map((n) => n.id)).not.toContain(P.hidden);
  });

  it("caps the photo count and reports truncation", async () => {
    const { body } = await graph(P.seed, "limit=3");
    expect(body.nodes).toHaveLength(3);
    expect(body.truncated).toBe(true);
    const ids = new Set(body.nodes.map((n) => n.id));
    for (const e of body.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
  });

  it("reports similarity as unavailable for a photo without an embedding", async () => {
    const { status, body } = await graph(P.e1);
    expect(status).toBe(200);
    expect(body.unavailable).toEqual([{ photoId: P.e1, kind: "similar", reason: "not_embedded" }]);
    expect(targets(body, "event")[0]).toBe(P.seed);
  });

  it.each([
    ["threads=bogus"], ["threads="], ["perThread=0"], ["perThread=13"], ["perThread=1.5"], ["depth=3"], ["limit=1"], ["limit=151"],
  ])("rejects %s", async (qs) => {
    expect((await graph(P.seed, qs)).status).toBe(400);
  });

  it("rejects a bad id and requires sign-in", async () => {
    expect((await graph(0 as number)).status).toBe(400);
    expect((await graph(P.seed, "", null)).status).toBe(401);
  });
});
