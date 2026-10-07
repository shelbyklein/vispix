import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Brand-asset management end to end (#206): designating the primary logo.
// Auth is mocked as in the org isolation suite.
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
import { db, pool, assetsTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

let server: Server;
let baseUrl: string;
let owner: { id: number; authUserId: string };
let member: { id: number; authUserId: string };
let orgId: number;
const A: Record<string, number> = {};

async function addAsset(key: string, values: Partial<typeof assetsTable.$inferInsert>) {
  const [row] = await db
    .insert(assetsTable)
    .values({ organizationId: orgId, kind: "brand", name: key, storageKey: `/objects/orgs/${orgId}/uploads/${key}`, contentType: "image/png", createdById: member.id, ...values })
    .returning();
  A[key] = row.id;
}

async function patch(id: number, body: unknown, as = owner) {
  return fetch(`${baseUrl}/api/assets/${id}`, {
    method: "PATCH",
    headers: { "x-test-auth-user": as.authUserId, "x-organization-id": String(orgId), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

beforeEach(async () => {
  await resetDb();
  const org = await createOrganization({ name: "USA Archery", slug: "usa-archery" });
  orgId = org.id;
  owner = await createUser({ name: "Olivia Owner" });
  member = await createUser({ name: "Milo Member" });
  await addOrganizationMember(orgId, owner.id, "owner");
  await addOrganizationMember(orgId, member.id, "member");
  await addAsset("achievement-badge-gold", { name: "Achievement Badge — Gold", variant: "award" });
  await addAsset("apparel-shirt", { name: "Apparel — Team Shirt" });
  await addAsset("event-logo", { name: "Event Logo — Gator Cup", variant: "event" });
  await addAsset("usa-primary", { name: "USA Archery Logo", variant: "primary" });
  await addAsset("usa-white", { name: "USA Archery Logo", variant: "white" });
  await addAsset("style-ref", { name: "2025 poster", kind: "reference" });
});

describe("designating the primary logo (TT-VPX-BRAND-03)", () => {
  it("lets owners set and replace it, one per scope, and refuses members", async () => {
    expect((await patch(A["usa-primary"], { isPrimary: true }, member)).status).toBe(403);
    const set = await patch(A["usa-primary"], { isPrimary: true });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { isPrimary: boolean }).isPrimary).toBe(true);
    // Replacing moves the designation.
    expect((await patch(A["usa-white"], { isPrimary: true })).status).toBe(200);
    const primaries = (await db.select().from(assetsTable)).filter((a) => a.isPrimary).map((a) => a.id);
    expect(primaries).toEqual([A["usa-white"]]);
  });

  it("only allows brand image assets", async () => {
    expect((await patch(A["style-ref"], { isPrimary: true })).status).toBe(400);
  });

  it("drops the designation when the asset moves to another scope", async () => {
    await patch(A["usa-primary"], { isPrimary: true });
    const [project] = await db.execute<{ id: number }>(
      // Minimal project row for the move.
      (await import("drizzle-orm")).sql`insert into projects (organization_id, name, created_by) values (${orgId}, 'Nationals', ${owner.id}) returning id`,
    ).then((r) => r.rows);
    expect((await patch(A["usa-primary"], { projectId: project.id }, member)).status).toBe(200);
    const [row] = (await db.select().from(assetsTable)).filter((a) => a.id === A["usa-primary"]);
    expect(row.isPrimary).toBe(false);
  });
});
