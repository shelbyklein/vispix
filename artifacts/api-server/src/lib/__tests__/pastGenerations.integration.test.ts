import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Past generations gallery (#194). Better Auth is mocked as in the other
// integration suites. The AI pipeline entry points are wrapped in spies so the
// suite can assert the gallery never triggers analysis, embedding or thumbnails.
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

const spies = vi.hoisted(() => ({
  analyzePhoto: vi.fn(),
  runAndRecordPhotoAnalysis: vi.fn(),
  generateAndStorePhotoEmbedding: vi.fn(),
  embedQuery: vi.fn(),
  embedText: vi.fn(),
  generateAndStoreThumbnail: vi.fn(),
}));

vi.mock("../aiPhotoAnalysis", async (orig) => ({
  ...(await orig<typeof import("../aiPhotoAnalysis")>()),
  analyzePhoto: spies.analyzePhoto,
  runAndRecordPhotoAnalysis: spies.runAndRecordPhotoAnalysis,
}));
vi.mock("../aiEmbedding", async (orig) => ({
  ...(await orig<typeof import("../aiEmbedding")>()),
  generateAndStorePhotoEmbedding: spies.generateAndStorePhotoEmbedding,
  embedQuery: spies.embedQuery,
  embedText: spies.embedText,
}));
vi.mock("../thumbnailGeneration", async (orig) => ({
  ...(await orig<typeof import("../thumbnailGeneration")>()),
  generateAndStoreThumbnail: spies.generateAndStoreThumbnail,
}));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, imageGenerationSessionsTable, imageGenerationsTable, campaignsTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";

interface Item {
  id: number;
  imageUrl: string | null;
  prompt: string;
  status: string;
  format: string | null;
  width: number | null;
  creator: { id: number; name: string } | null;
  source: { type: string; sessionId: number; sessionTitle: string; campaignId: number | null; campaignName: string | null };
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
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

let user: { id: number; authUserId: string };
let orgId: number;

async function get(path: string, as = user, org = orgId): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org) } });
}

async function page(path: string): Promise<Page> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

async function seedSession(organizationId: number, userId: number, title = "Session") {
  const [s] = await db.insert(imageGenerationSessionsTable).values({ organizationId, userId, title }).returning();
  return s;
}

async function seedGen(
  organizationId: number,
  sessionId: number,
  opts: { prompt?: string; status?: string; createdAt?: Date } = {},
) {
  const hasImage = (opts.status ?? "succeeded") === "succeeded";
  const [g] = await db
    .insert(imageGenerationsTable)
    .values({
      organizationId,
      sessionId,
      prompt: opts.prompt ?? "a prompt",
      status: opts.status ?? "succeeded",
      storageKey: hasImage ? `/objects/orgs/${organizationId}/generated/${Math.random().toString(36).slice(2)}` : null,
      settings: { format: "1:1" },
      width: 1024,
      height: 1024,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  return g;
}

beforeEach(async () => {
  await resetDb();
  Object.values(spies).forEach((s) => s.mockClear());
  user = await createUser({ name: "Gina" });
  const org = await createOrganization();
  orgId = org.id;
  await addOrganizationMember(orgId, user.id, "member");
});

describe("GET /api/image-generation/all", () => {
  it("lists succeeded generations newest first with source and creator", async () => {
    const session = await seedSession(orgId, user.id, "Poster ideas");
    const old = await seedGen(orgId, session.id, { prompt: "old", createdAt: new Date("2026-01-01T00:00:00Z") });
    const recent = await seedGen(orgId, session.id, { prompt: "recent", createdAt: new Date("2026-02-01T00:00:00Z") });

    const body = await page("/api/image-generation/all");
    expect(body.items.map((i) => i.id)).toEqual([recent.id, old.id]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      prompt: "recent",
      status: "succeeded",
      format: "1:1",
      width: 1024,
      creator: { id: user.id, name: "Gina" },
      source: { type: "session", sessionId: session.id, sessionTitle: "Poster ideas", campaignId: null },
    });
    expect(body.items[0].imageUrl).toMatch(/^\/api\/storage\/objects\//);
  });

  it("labels campaign suggestions with their campaign", async () => {
    const session = await seedSession(orgId, user.id);
    const [campaign] = await db
      .insert(campaignsTable)
      .values({ organizationId: orgId, createdById: user.id, name: "Spring Open", brief: "b", sessionId: session.id })
      .returning();
    await seedGen(orgId, session.id);
    const body = await page("/api/image-generation/all");
    expect(body.items[0].source).toMatchObject({ type: "campaign", campaignId: campaign.id, campaignName: "Spring Open" });
  });

  it("excludes pending and failed by default; includeFailed adds failed only", async () => {
    const session = await seedSession(orgId, user.id);
    const ok = await seedGen(orgId, session.id);
    const failed = await seedGen(orgId, session.id, { status: "failed" });
    await seedGen(orgId, session.id, { status: "pending" });

    expect((await page("/api/image-generation/all")).items.map((i) => i.id)).toEqual([ok.id]);
    const withFailed = await page("/api/image-generation/all?includeFailed=true");
    expect(withFailed.items.map((i) => i.id).sort()).toEqual([ok.id, failed.id].sort());
  });

  it("pages with a cursor without skipping or repeating rows, including same-timestamp batches", async () => {
    const session = await seedSession(orgId, user.id);
    const same = new Date("2026-03-01T00:00:00.123Z");
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await seedGen(orgId, session.id, { createdAt: same })).id);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 5; n++) {
      const body: Page = await page(`/api/image-generation/all?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...ids].reverse());
    expect(cursor).toBeNull();
  });

  it("rejects a malformed cursor", async () => {
    expect((await get("/api/image-generation/all?cursor=garbage")).status).toBe(400);
  });

  it("is isolated to the active organization", async () => {
    const other = await createOrganization();
    const otherUser = await createUser();
    await addOrganizationMember(other.id, otherUser.id, "owner");
    const otherSession = await seedSession(other.id, otherUser.id);
    await seedGen(other.id, otherSession.id, { prompt: "secret" });
    const mine = await seedGen(orgId, (await seedSession(orgId, user.id)).id);

    const body = await page("/api/image-generation/all");
    expect(body.items.map((i) => i.id)).toEqual([mine.id]);
    // Naming the other org without membership must not expose its gallery.
    const foreign = await get("/api/image-generation/all", user, other.id);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  });

  it("does not include photos and never calls the AI pipeline", async () => {
    const album = await createAlbum(user.id, "Real album", orgId);
    await createPhoto(album.id, user.id, { url: "/api/storage/objects/uploads/real-photo", organizationId: orgId });
    const session = await seedSession(orgId, user.id);
    const gen = await seedGen(orgId, session.id);
    const res = await get("/api/image-generation/all");
    const body = (await res.json()) as Page;
    expect(body.items.map((i) => i.id)).toEqual([gen.id]);
    expect(JSON.stringify(body)).not.toContain("real-photo");
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  });
});
