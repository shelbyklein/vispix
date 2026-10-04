import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Generation records must not expose hidden-photo details to members, upload
// inputs must be real upload-flow keys, and revisions re-send the parent image
// with provider-side storage off. The OpenAI SDK boundary is mocked; the real
// openaiImage wrapper, routes and orchestration run against the test DB.
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

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { create: sdk.create };
  },
}));

const loaded = vi.hoisted(() => ({ keys: [] as Array<string | null> }));
vi.mock("../aiPhotoAnalysis", async (orig) => ({
  ...(await orig<typeof import("../aiPhotoAnalysis")>()),
  resolveImageForAI: async (_url: string, key: string | null) => {
    loaded.keys.push(key);
    return { dataUrl: `data:image/jpeg;base64,${Buffer.from(String(key)).toString("base64")}`, contentType: "image/jpeg" };
  },
}));
vi.mock("../aiProviders", async (orig) => ({
  ...(await orig<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => ({ apiKey: "sk-test", baseURL: null }),
}));
vi.mock("../objectStorage", async (orig) => ({
  ...(await orig<typeof import("../objectStorage")>()),
  getPrivateObjectDir: () => "/test-bucket/private",
  signObjectURL: async () => "http://fake-storage.test/put",
}));

import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import app from "../../app";
import { db, pool, photosTable, imageGenerationsTable, attributionTagsTable, photoAttributionTagsTable } from "@workspace/db";
import { resetGenerationLimits } from "../imageGeneration/limits";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let orgA: number;
let orgB: number;
let manager: U;
let member: U;
let hiddenPhoto: number;
let visiblePhoto: number;
const realFetch = globalThis.fetch;

let hiddenKey = "";
let thumbKey = "";
let visibleKey = "";

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Priv A" })).id;
  orgB = (await createOrganization({ name: "Priv B" })).id;
  manager = await createUser({ name: "Manager" });
  member = await createUser({ name: "Member" });
  await addOrganizationMember(orgA, manager.id, "admin");
  await addOrganizationMember(orgA, member.id, "member");
  const album = await createAlbum(manager.id, "Album", orgA);
  hiddenKey = `/objects/orgs/${orgA}/uploads/hidden-original`;
  thumbKey = `/objects/orgs/${orgA}/uploads/hidden-thumb`;
  visibleKey = `/objects/orgs/${orgA}/uploads/visible-original`;
  const h = await createPhoto(album.id, manager.id, { organizationId: orgA, isHidden: true });
  const v = await createPhoto(album.id, manager.id, { organizationId: orgA });
  hiddenPhoto = h.id;
  visiblePhoto = v.id;
  await db.update(photosTable).set({ filename: "secret-gala.jpg", storageKey: hiddenKey, thumbnailKey: thumbKey }).where(eq(photosTable.id, h.id));
  await db.update(photosTable).set({ filename: "public.jpg", storageKey: visibleKey }).where(eq(photosTable.id, v.id));
  const tag = (await db.insert(attributionTagsTable).values({ organizationId: orgA, name: "Embargoed Sponsor" }).returning())[0].id;
  await db.insert(photoAttributionTagsTable).values({ photoId: h.id, tagId: tag });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("http://fake-storage.test") ? Promise.resolve(new Response(null, { status: 200 })) : realFetch(input, init),
  );
});

beforeEach(() => {
  resetGenerationLimits();
  loaded.keys.length = 0;
  sdk.create.mockReset();
  sdk.create.mockResolvedValue({ id: "resp_1", output: [{ type: "image_generation_call", result: Buffer.from("png").toString("base64") }] });
  process.env.GENERATION_RATE_LIMIT_PER_ORG = "1000";
  process.env.GENERATION_RATE_LIMIT_PER_USER = "1000";
  process.env.GENERATION_MAX_PENDING_PER_ORG = "50";
  process.env.GENERATION_MAX_PENDING_PER_USER = "50";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  await pool.end();
});

async function call(method: string, path: string, as: U, body?: unknown, org = orgA) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
}

async function settle() {
  for (let i = 0; i < 200; i++) {
    const rows = await db.select({ s: imageGenerationsTable.status }).from(imageGenerationsTable);
    if (rows.every((r) => r.s !== "pending")) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("generations never settled");
}

const gen = (as: U, body: Record<string, unknown>) => call("POST", "/image-generation/generate", as, { prompt: "a poster", variantCount: 1, ...body });

describe("hidden-photo details in generation records", () => {
  it("members get no storage keys and no hidden-photo details; managers keep full detail", async () => {
    const made = await gen(manager, {
      inputs: [
        { kind: "photo", refId: hiddenPhoto, role: "hero_photo" },
        { kind: "photo", refId: visiblePhoto, role: "style" },
      ],
    });
    expect(made.status).toBe(200);
    await settle();
    const sessionId = made.body.sessionId;

    const m = await call("GET", `/image-generation/sessions/${sessionId}`, member);
    expect(m.status).toBe(200);
    expect(m.text).not.toContain(hiddenKey);
    expect(m.text).not.toContain(visibleKey);
    expect(m.text).not.toContain("secret-gala");
    expect(m.text).not.toContain("Embargoed Sponsor");
    const inputs = m.body.generations[0].inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ kind: "photo", role: "hero_photo", name: "Hidden photo", refId: null });
    expect(inputs[1]).toMatchObject({ kind: "photo", role: "style", name: "public.jpg", refId: visiblePhoto });
    for (const i of inputs) expect(i.storageKey).toBeUndefined();

    const mAll = await call("GET", "/image-generation/all", member);
    expect(mAll.text).not.toContain("secret-gala");
    expect(mAll.text).not.toContain("Embargoed Sponsor");
    const rc = mAll.body.items[0].rightsConsidered;
    expect(rc.find((r: any) => r.photoId === hiddenPhoto)).toBeUndefined();
    expect(rc.some((r: any) => r.photoId === visiblePhoto)).toBe(true);

    const mgr = await call("GET", `/image-generation/sessions/${sessionId}`, manager);
    expect(mgr.body.generations[0].inputs[0]).toMatchObject({ name: "secret-gala.jpg", refId: hiddenPhoto, storageKey: hiddenKey });
    const mgrAll = await call("GET", "/image-generation/all", manager);
    expect(mgrAll.text).toContain("secret-gala");
  });

  it("a member's own generate response is redacted too", async () => {
    await db.update(photosTable).set({ isHidden: false }).where(eq(photosTable.id, hiddenPhoto));
    const made = await gen(member, { inputs: [{ kind: "photo", refId: hiddenPhoto, role: "hero_photo" }] });
    await db.update(photosTable).set({ isHidden: true }).where(eq(photosTable.id, hiddenPhoto));
    expect(made.status).toBe(200);
    await settle();
    const again = await call("GET", `/image-generation/sessions/${made.body.sessionId}`, member);
    expect(again.text).not.toContain("secret-gala");
    expect(again.text).not.toContain(hiddenKey);
  });
});

describe("uploaded reference keys", () => {
  const upload = (storageKey: string) => gen(manager, { inputs: [{ kind: "upload", storageKey, role: "style" }] });

  it("rejects a photo's original and thumbnail keys (must be referenced as photos)", async () => {
    expect((await upload(visibleKey)).status).toBe(400);
    expect((await upload(thumbKey)).status).toBe(400);
    expect((await upload(hiddenKey)).status).toBe(400);
  });

  it("rejects traversal, backslashes, control characters and other orgs", async () => {
    for (const k of [
      `/objects/orgs/${orgA}/uploads/../generated/x`,
      `/objects/orgs/${orgA}/uploads/..%2Fx`,
      `/objects/orgs/${orgA}/uploads\\x`,
      `/objects/orgs/${orgA}/uploads/ab\u0000c`,
      `/objects/orgs/${orgA}/uploads/ab\ncd`,
      `/objects/orgs/${orgB}/uploads/abc`,
      `/objects/orgs/${orgA}/generated/abc`,
      `/objects/orgs/${orgA}/`,
    ]) {
      expect((await upload(k)).status, k).toBe(400);
    }
    expect(loaded.keys).toHaveLength(0);
  });

  it("accepts a genuine upload-flow key", async () => {
    const key = `/objects/orgs/${orgA}/uploads/6f1c2b1e-1111-4222-8333-444455556666`;
    const r = await upload(key);
    expect(r.status).toBe(200);
    await settle();
    expect(loaded.keys).toContain(key);
  });
});

describe("revisions without provider-side storage", () => {
  it("sends store:false, no previous_response_id, and the parent image", async () => {
    const first = await gen(manager, { prompt: "Summer poster with bold headline" });
    expect(first.status).toBe(200);
    await settle();
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0][0].store).toBe(false);
    const parent = first.body.generations[0];
    const parentKey = (await db.select().from(imageGenerationsTable).where(eq(imageGenerationsTable.id, parent.id)))[0].storageKey!;

    loaded.keys.length = 0;
    const rev = await gen(manager, { prompt: "make the headline larger", parentGenerationId: parent.id });
    expect(rev.status).toBe(200);
    await settle();
    expect(sdk.create).toHaveBeenCalledTimes(2);
    const params = sdk.create.mock.calls[1][0];
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("previous_response_id");
    expect(loaded.keys).toEqual([parentKey]);
    const content = params.input[0].content as Array<{ type: string; text?: string; image_url?: string }>;
    expect(content.filter((c) => c.type === "input_image")).toHaveLength(1);
    const text = content.find((c) => c.type === "input_text")!.text!;
    expect(text).toContain("make the headline larger");
    expect(text).toContain("Summer poster with bold headline");
  });

  it("refuses to revise a generation that has no image", async () => {
    const [row] = await db.select().from(imageGenerationsTable).limit(1);
    const { id: _id, ...rest } = row;
    const [failed] = await db.insert(imageGenerationsTable).values({ ...rest, storageKey: null, status: "failed" }).returning();
    expect((await gen(manager, { prompt: "again", parentGenerationId: failed.id })).status).toBe(400);
  });
});
