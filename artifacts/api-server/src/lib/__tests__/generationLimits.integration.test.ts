import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";

// Per-org / per-user pending caps, global queue bound, request rate limit and
// generic error handling for image generation (#229). The real routes,
// runGeneration and limiter run against the test DB; only the provider
// boundary is mocked: generateImage waits on a gate the test controls, the
// OpenAI key lookup is stubbed, and storage uploads are faked.
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

const gates: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
vi.mock("../imageGeneration/openaiImage", () => ({
  generateImage: () =>
    new Promise((resolve, reject) => {
      gates.push({
        resolve: () => resolve({ buffer: Buffer.from("png"), responseId: "resp", imageModel: "test-model" }),
        reject,
      });
    }),
}));

const keyLookup = vi.hoisted(() => ({ fail: false }));
vi.mock("../aiProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => {
    if (keyLookup.fail) throw new Error('connection to postgres://admin:hunter2@db failed');
    return { apiKey: "test-key", baseURL: null };
  },
}));

vi.mock("../objectStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../objectStorage")>()),
  getPrivateObjectDir: () => "/test-bucket/private",
  signObjectURL: async () => "http://fake-storage.test/put",
}));

import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import app from "../../app";
import { logger } from "../logger";
import { db, pool, imageGenerationsTable, campaignsTable } from "@workspace/db";
import { resetGenerationLimits } from "../imageGeneration/limits";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let orgA: number;
let orgB: number;
let a1: U;
let a2: U;
let b1: U;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Gen A" })).id;
  orgB = (await createOrganization({ name: "Gen B" })).id;
  a1 = await createUser({ name: "a1" });
  a2 = await createUser({ name: "a2" });
  b1 = await createUser({ name: "b1" });
  await addOrganizationMember(orgA, a1.id, "member");
  await addOrganizationMember(orgA, a2.id, "member");
  await addOrganizationMember(orgB, b1.id, "member");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  // Generated-image uploads go to a fake host; everything else is real.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("http://fake-storage.test") ? Promise.resolve(new Response(null, { status: 200 })) : realFetch(input, init),
  );
});

beforeEach(() => {
  resetGenerationLimits();
  keyLookup.fail = false;
  // Generous defaults; each test tightens the one limit it exercises.
  process.env.GENERATION_MAX_PENDING_PER_ORG = "50";
  process.env.GENERATION_MAX_PENDING_PER_USER = "50";
  process.env.GENERATION_MAX_QUEUE = "50";
  process.env.GENERATION_RATE_LIMIT_PER_ORG = "1000";
  process.env.GENERATION_RATE_LIMIT_PER_USER = "1000";
});

async function settle() {
  for (let i = 0; i < 200; i++) {
    while (gates.length) gates.shift()!.resolve();
    const rows = await db.select({ s: imageGenerationsTable.status }).from(imageGenerationsTable);
    if (rows.every((r) => r.s !== "pending")) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("generations never settled");
}

afterEach(async () => {
  await settle();
  await db.delete(imageGenerationsTable);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  await pool.end();
});

async function post(as: U, org: number, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(org), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}
const generate = (as: U, org: number, variantCount = 1) =>
  post(as, org, "/image-generation/generate", { prompt: "a poster", variantCount });

async function waitFor(pred: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition never met");
}
const statuses = async () => (await db.select({ s: imageGenerationsTable.status }).from(imageGenerationsTable)).map((r) => r.s);

describe("pending-job caps", () => {
  it("per-org cap rejects with 429 and frees up after completion", async () => {
    process.env.GENERATION_MAX_PENDING_PER_ORG = "2";
    expect((await generate(a1, orgA, 2)).status).toBe(200);

    const blocked = await generate(a2, orgA);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("generation_busy");
    expect(typeof blocked.body.error).toBe("string");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    await settle();
    expect((await generate(a2, orgA)).status).toBe(200);
  });

  it("releases the cap when a job fails", async () => {
    process.env.GENERATION_MAX_PENDING_PER_ORG = "1";
    expect((await generate(a1, orgA)).status).toBe(200);
    expect((await generate(a1, orgA)).status).toBe(429);

    await waitFor(() => gates.length === 1);
    gates.shift()!.reject(new Error("provider exploded"));
    await waitFor(async () => (await statuses()).every((s) => s === "failed"));

    expect((await generate(a1, orgA)).status).toBe(200);
  });

  it("releases the cap when the request fails before any job starts", async () => {
    process.env.GENERATION_MAX_PENDING_PER_ORG = "1";
    const bad = await post(a1, orgA, "/image-generation/generate", {
      prompt: "x",
      variantCount: 1,
      inputs: [{ kind: "photo", refId: 999999, role: "hero_photo" }],
    });
    expect(bad.status).toBe(400);
    expect((await generate(a1, orgA)).status).toBe(200);
  });

  it("per-user cap applies to that user only", async () => {
    process.env.GENERATION_MAX_PENDING_PER_USER = "1";
    expect((await generate(a1, orgA)).status).toBe(200);
    const blocked = await generate(a1, orgA);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("generation_busy");
    // A colleague in the same org still has their own allowance.
    expect((await generate(a2, orgA)).status).toBe(200);
  });

  it("a request that wouldn't fit entirely is rejected whole", async () => {
    process.env.GENERATION_MAX_PENDING_PER_ORG = "2";
    expect((await generate(a1, orgA, 3)).status).toBe(429);
    expect(await statuses()).toHaveLength(0);
  });

  it("bounds the global queue across organizations", async () => {
    process.env.GENERATION_MAX_QUEUE = "2";
    expect((await generate(a1, orgA, 2)).status).toBe(200);
    const full = await generate(b1, orgB);
    expect(full.status).toBe(429);
    expect(full.body.code).toBe("generation_queue_full");
    expect(Number(full.headers.get("retry-after"))).toBeGreaterThan(0);
    await settle();
    expect((await generate(b1, orgB)).status).toBe(200);
  });

  it("org A's load doesn't consume org B's cap", async () => {
    process.env.GENERATION_MAX_PENDING_PER_ORG = "2";
    expect((await generate(a1, orgA, 2)).status).toBe(200);
    expect((await generate(a2, orgA)).status).toBe(429);
    expect((await generate(b1, orgB, 2)).status).toBe(200);
  });
});

describe("campaign generate", () => {
  it("answers 429 before calling the concept model when the suggestions won't fit", async () => {
    process.env.GENERATION_MAX_PENDING_PER_ORG = "2";
    const [campaign] = await db
      .insert(campaignsTable)
      .values({ organizationId: orgA, createdById: a1.id, name: "Cap test", brief: "A brief" })
      .returning();
    const res = await post(a1, orgA, `/campaigns/${campaign.id}/generate`, {});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("generation_busy");
    expect(res.headers.get("retry-after")).not.toBeNull();
    await db.delete(campaignsTable).where(eq(campaignsTable.id, campaign.id));
  });
});

describe("request rate limit", () => {
  it("per-org limit answers 429 with Retry-After for plan and generate", async () => {
    process.env.GENERATION_RATE_LIMIT_PER_ORG = "3";
    // Invalid bodies still count: the limiter sits in front of validation.
    expect((await post(a1, orgA, "/image-generation/plan", {})).status).toBe(400);
    expect((await post(a2, orgA, "/image-generation/generate", {})).status).toBe(400);
    expect((await post(a1, orgA, "/image-generation/plan", {})).status).toBe(400);
    const limited = await post(a2, orgA, "/image-generation/generate", {});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("generation_rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.body.retryAfterSeconds).toBe(Number(limited.headers.get("retry-after")));
    // Another org is unaffected.
    expect((await post(b1, orgB, "/image-generation/plan", {})).status).toBe(400);
  });

  it("per-user limit applies to that user only", async () => {
    process.env.GENERATION_RATE_LIMIT_PER_USER = "1";
    expect((await post(a1, orgA, "/image-generation/plan", {})).status).toBe(400);
    expect((await post(a1, orgA, "/image-generation/plan", {})).status).toBe(429);
    expect((await post(a2, orgA, "/image-generation/plan", {})).status).toBe(400);
  });

  it("a rejected request doesn't extend the wait", async () => {
    process.env.GENERATION_RATE_LIMIT_PER_USER = "1";
    process.env.GENERATION_RATE_WINDOW_SEC = "60";
    await post(a1, orgA, "/image-generation/plan", {});
    const first = await post(a1, orgA, "/image-generation/plan", {});
    const second = await post(a1, orgA, "/image-generation/plan", {});
    expect(Number(second.headers.get("retry-after"))).toBeLessThanOrEqual(Number(first.headers.get("retry-after")));
    delete process.env.GENERATION_RATE_WINDOW_SEC;
  });
});

describe("error handling", () => {
  it("stores a generic generation.error and logs the real one", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect((await generate(a1, orgA)).status).toBe(200);
    await waitFor(() => gates.length === 1);
    gates.shift()!.reject(new Error("401 Incorrect API key provided: sk-live-secret"));
    await waitFor(async () => (await statuses()).every((s) => s === "failed"));

    const [row] = await db.select().from(imageGenerationsTable).where(eq(imageGenerationsTable.status, "failed"));
    expect(row.error).toBe("Image generation failed. Please try again.");
    expect(row.error).not.toContain("sk-live-secret");
    const realErrors = logged.mock.calls.map((c) => (c[0] as { err?: Error }).err?.message);
    expect(realErrors).toContain("401 Incorrect API key provided: sk-live-secret");
  });

  it("answers 5xx with a generic body and keeps 4xx validation messages", async () => {
    keyLookup.fail = true;
    const res = await generate(a1, orgA);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(res.body.error).toBe("Image generation failed. Please try again.");

    keyLookup.fail = false;
    const bad = await post(a1, orgA, "/image-generation/generate", {
      prompt: "x",
      variantCount: 1,
      inputs: [{ kind: "upload", storageKey: "/objects/orgs/999/uploads/x", role: "style" }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Uploaded reference key is not valid for this organization.");
  });
});
