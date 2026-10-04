import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Photo Graph request rate limit and the depth-2 fan-out cap.
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
import { db, pool, photosTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";
import { resetGraphRateLimit } from "../graphRateLimit";

let server: Server;
let base: string;
let orgA: number;
let admin: { id: number; authUserId: string };
let other: { id: number; authUserId: string };
let seed: number;

const clearEnv = () => {
  delete process.env.GRAPH_RATE_LIMIT_PER_USER;
  delete process.env.GRAPH_RATE_LIMIT_PER_ORG;
  delete process.env.GRAPH_RATE_WINDOW_SEC;
};

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Limits A" })).id;
  admin = await createUser({ name: "Admin" });
  other = await createUser({ name: "Other" });
  await addOrganizationMember(orgA, admin.id, "admin");
  await addOrganizationMember(orgA, other.id, "member");
  const album = await createAlbum(admin.id, "Crowd", orgA);
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    const p = await createPhoto(album.id, admin.id, { organizationId: orgA });
    await db.update(photosTable).set({ filename: `c${i}.jpg`, takenAt: new Date(t0 + i * 1000) }).where(eq(photosTable.id, p.id));
    if (i === 0) seed = p.id;
  }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
});

afterAll(async () => {
  clearEnv();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(() => {
  resetGraphRateLimit();
  clearEnv();
});

const get = (qs = "", as = admin) =>
  fetch(`${base}/photos/${seed}/graph${qs}`, { headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgA) } });

describe("graph rate limit", () => {
  it("answers 429 with Retry-After past the per-user limit, then resets", async () => {
    process.env.GRAPH_RATE_LIMIT_PER_USER = "3";
    process.env.GRAPH_RATE_WINDOW_SEC = "1";
    for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200);
    const blocked = await get();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await blocked.json()) as { code: string }).code).toBe("graph_rate_limited");
    // Another user in the same org is not affected by the per-user limit.
    expect((await get("", other)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await get()).status).toBe(200);
  });

  it("also limits per organization", async () => {
    process.env.GRAPH_RATE_LIMIT_PER_ORG = "2";
    expect((await get()).status).toBe(200);
    expect((await get("", other)).status).toBe(200);
    const r = await get("", other);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("has generous defaults", async () => {
    for (let i = 0; i < 10; i++) expect((await get("?threads=event")).status).toBe(200);
  });
});

describe("depth-2 fan-out cap", () => {
  it("caps perThread at 6 when depth=2 but not at depth 1", async () => {
    type G = { edges: { source: number; target: number }[] };
    const one = (await (await get("?threads=event&perThread=12&depth=1&limit=150")).json()) as G;
    const two = (await (await get("?threads=event&perThread=12&depth=2&limit=150")).json()) as G;
    const fromSeed = (g: G) => g.edges.filter((e) => e.source === seed || e.target === seed).length;
    expect(fromSeed(one)).toBe(11);
    expect(fromSeed(two)).toBe(6);
  });
});
