import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Usage-rights tag names are unique per organization (migration 0037), not
// globally: two orgs can both have "Sponsor OK", one org can't have "Social"
// and "social", and another org's names never block, collide or leak.
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

import type { Server } from "node:http";
import app from "../../app";
import { pool } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

let server: Server;
let baseUrl: string;
let a: { user: { authUserId: string }; org: number };
let b: { user: { authUserId: string }; org: number };

beforeAll(async () => {
  await resetDb();
  const orgA = await createOrganization({ name: "Tags A" });
  const orgB = await createOrganization({ name: "Tags B" });
  const ua = await createUser();
  const ub = await createUser();
  await addOrganizationMember(orgA.id, ua.id, "owner");
  await addOrganizationMember(orgB.id, ub.id, "owner");
  a = { user: ua, org: orgA.id };
  b = { user: ub, org: orgB.id };
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

async function call(as: { user: { authUserId: string }; org: number }, path: string, method: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-auth-user": as.user.authUserId, "x-organization-id": String(as.org), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { id?: number; name?: string; error?: string } | null };
}

describe("usage-rights tag names are unique per organization", () => {
  it("lets two organizations use the same name", async () => {
    const first = await call(a, "/attribution-tags", "POST", { name: "Sponsor OK" });
    const second = await call(b, "/attribution-tags", "POST", { name: "Sponsor OK" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body?.id).not.toBe(first.body?.id);
    const listA = await call(a, "/attribution-tags", "GET");
    expect(listA.status).toBe(200);
  });

  it("refuses a duplicate within one organization, ignoring case, with a clean 409", async () => {
    expect((await call(a, "/attribution-tags", "POST", { name: "Sponsor OK" })).status).toBe(409);
    const variant = await call(a, "/attribution-tags", "POST", { name: "sponsor ok" });
    expect(variant.status).toBe(409);
    expect(variant.body?.error).toBe("A tag with that name already exists");
  });

  it("refuses renaming onto another tag of the same org (any case), allows another org's name", async () => {
    const social = await call(a, "/attribution-tags", "POST", { name: "Social" });
    const world = await call(a, "/attribution-tags", "POST", { name: "World Archery" });
    expect((await call(a, `/attribution-tags/${world.body!.id}`, "PATCH", { name: "SOCIAL" })).status).toBe(409);
    // Org B's only tag is "Sponsor OK"; renaming it to org A's "Social" is fine.
    const bTags = await fetch(`${baseUrl}/attribution-tags`, { headers: { "x-test-auth-user": b.user.authUserId, "x-organization-id": String(b.org) } }).then((r) => r.json() as Promise<{ id: number; name: string }[]>);
    expect((await call(b, `/attribution-tags/${bTags[0].id}`, "PATCH", { name: "Social" })).status).toBe(200);
    // Changing a tag's own case is not a conflict.
    expect((await call(a, `/attribution-tags/${social.body!.id}`, "PATCH", { name: "social" })).status).toBe(200);
  });

  it("never lists another organization's tags", async () => {
    const listB = await fetch(`${baseUrl}/attribution-tags`, { headers: { "x-test-auth-user": b.user.authUserId, "x-organization-id": String(b.org) } }).then((r) => r.json() as Promise<{ name: string }[]>);
    expect(listB.map((t) => t.name)).toEqual(["Social"]);
  });
});
