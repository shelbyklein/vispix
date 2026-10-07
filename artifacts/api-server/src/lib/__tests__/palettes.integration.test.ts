import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
import type { SavedPalette } from "@workspace/api-zod/palette";
import app from "../../app";
import { db, pool, usersTable, designPalettesTable } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

type U = { id: number; authUserId: string };
let server: Server;
let base: string;
let platform: U;
let owner: U;
let member: U;

beforeAll(async () => {
  await resetDb();
  await db.delete(designPalettesTable);
  const org = await createOrganization({ name: "Palette Org" });
  platform = await createUser({ name: "platform", role: "admin" });
  owner = await createUser({ name: "owner" });
  member = await createUser({ name: "member" });
  await addOrganizationMember(org.id, platform.id, "member");
  await addOrganizationMember(org.id, owner.id, "owner");
  await addOrganizationMember(org.id, member.id, "member");
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

function req(as: U | null, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(as ? { "x-test-auth-user": as.authUserId } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const input = (over: Record<string, unknown> = {}) => ({
  name: "Sunset",
  swatches: ["#112233", "#AABBCC", "#ffffff"],
  roles: { background: "#112233", brand: "#AABBCC" },
  harmony: "triadic",
  ...over,
});

describe("saved palettes (#257)", () => {
  it("creates, lists newest-first by update, updates and deletes", async () => {
    const a = await req(platform, "POST", "/platform/palettes", input({ name: "A" }));
    expect(a.status).toBe(201);
    const pa = (await a.json()) as SavedPalette;
    expect(pa).toMatchObject({ name: "A", swatches: ["#112233", "#AABBCC", "#ffffff"], harmony: "triadic", roles: { background: "#112233", brand: "#AABBCC" } });
    expect(typeof pa.id).toBe("number");
    expect(new Date(pa.createdAt).toISOString()).toBe(pa.createdAt);
    expect(new Date(pa.updatedAt).toISOString()).toBe(pa.updatedAt);

    await new Promise((r) => setTimeout(r, 10));
    const b = (await (await req(platform, "POST", "/platform/palettes", input({ name: "B", harmony: null, roles: undefined }))).json()) as SavedPalette;
    expect(b.harmony).toBeNull();
    expect(b.roles).toEqual({});

    let list = (await (await req(platform, "GET", "/platform/palettes")).json()) as SavedPalette[];
    expect(list.map((p) => p.name)).toEqual(["B", "A"]);

    await new Promise((r) => setTimeout(r, 10));
    const put = await req(platform, "PUT", `/platform/palettes/${pa.id}`, input({ name: "A2", swatches: ["#000000"] }));
    expect(put.status).toBe(200);
    const upd = (await put.json()) as SavedPalette;
    expect(upd).toMatchObject({ id: pa.id, name: "A2", swatches: ["#000000"] });
    expect(upd.createdAt).toBe(pa.createdAt);
    expect(Date.parse(upd.updatedAt)).toBeGreaterThan(Date.parse(pa.updatedAt));

    list = (await (await req(platform, "GET", "/platform/palettes")).json()) as SavedPalette[];
    expect(list.map((p) => p.name)).toEqual(["A2", "B"]);

    expect((await req(platform, "DELETE", `/platform/palettes/${pa.id}`)).status).toBe(204);
    expect((await req(platform, "DELETE", `/platform/palettes/${b.id}`)).status).toBe(204);
    list = (await (await req(platform, "GET", "/platform/palettes")).json()) as SavedPalette[];
    expect(list).toEqual([]);
  });

  it("rejects invalid bodies with 400", async () => {
    const bad = [
      input({ swatches: ["#12345"] }),
      input({ swatches: ["red"] }),
      input({ name: "   " }),
      input({ swatches: [] }),
      input({ swatches: Array.from({ length: 11 }, () => "#000000") }),
      input({ roles: { sidebar: "#000000" } }),
      input({ roles: { brand: "nope" } }),
      input({ harmony: "pentadic" }),
    ];
    for (const body of bad) {
      expect((await req(platform, "POST", "/platform/palettes", body)).status).toBe(400);
    }
    const ok = (await (await req(platform, "POST", "/platform/palettes", input())).json()) as SavedPalette;
    expect((await req(platform, "PUT", `/platform/palettes/${ok.id}`, bad[0])).status).toBe(400);
    expect((await req(platform, "DELETE", `/platform/palettes/${ok.id}`)).status).toBe(204);
  });

  it("returns 404 for missing palettes", async () => {
    expect((await req(platform, "PUT", "/platform/palettes/999999", input())).status).toBe(404);
    expect((await req(platform, "DELETE", "/platform/palettes/999999")).status).toBe(404);
    expect((await req(platform, "PUT", "/platform/palettes/abc", input())).status).toBe(404);
  });

  it("is superadmin only", async () => {
    for (const who of [owner, member]) {
      expect((await req(who, "GET", "/platform/palettes")).status).toBe(403);
      expect((await req(who, "POST", "/platform/palettes", input())).status).toBe(403);
      expect((await req(who, "PUT", "/platform/palettes/1", input())).status).toBe(403);
      expect((await req(who, "DELETE", "/platform/palettes/1")).status).toBe(403);
    }
    expect((await req(null, "GET", "/platform/palettes")).status).toBe(401);
    expect((await req(null, "POST", "/platform/palettes", input())).status).toBe(401);
  });

  it("refuses to exceed the palette cap with 409", async () => {
    await db.insert(designPalettesTable).values(Array.from({ length: 200 }, (_, i) => ({ name: `p${i}`, swatches: ["#000000"] })));
    const res = await req(platform, "POST", "/platform/palettes", input());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/200/);
    await db.delete(designPalettesTable);
  });

  it("keeps palettes (author nulled) when their creator is deleted", async () => {
    const author = await createUser({ name: "author", role: "admin" });
    const [row] = await db.insert(designPalettesTable).values({ name: "kept", swatches: ["#000000"], createdByUserId: author.id }).returning();
    await db.delete(usersTable).where(eq(usersTable.id, author.id));
    const [after] = await db.select().from(designPalettesTable).where(eq(designPalettesTable.id, row.id));
    expect(after.createdByUserId).toBeNull();
    await db.delete(designPalettesTable);
  });
});
