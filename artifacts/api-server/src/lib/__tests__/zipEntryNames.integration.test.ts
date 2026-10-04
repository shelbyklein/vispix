import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Readable } from "node:stream";

// Zip entry names built from user-controlled photo filenames must be safe for
// naive extractors, unique, and must never collide with the manifest.
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
import { db, pool, photosTable, projectPhotosTable, projectsTable } from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";
import { safeZipEntryName } from "../zipEntryName";

let server: Server;
let base: string;
let orgA: number;
let admin: { id: number; authUserId: string };
let projectId: number;

const NAMES = [
  "a/../../x.jpg",
  "..\\..\\y.png",
  "usage-rights.json",
  "bad\u0001\u0007name\n.jpg",
  `${"L".repeat(400)}.jpeg`,
  "dup.jpg",
  "dup.jpg",
  "../../../etc/passwd",
  "/abs/path/z.jpg",
  "...",
];

beforeAll(async () => {
  await resetDb();
  orgA = (await createOrganization({ name: "Zip A" })).id;
  admin = await createUser({ name: "Admin" });
  await addOrganizationMember(orgA, admin.id, "admin");
  const album = await createAlbum(admin.id, "Zips", orgA);
  const [project] = await db.insert(projectsTable).values({ organizationId: orgA, createdById: admin.id, name: "Zip project" }).returning();
  projectId = project.id;
  for (const name of NAMES) {
    const p = await createPhoto(album.id, admin.id, { organizationId: orgA });
    await db.update(photosTable).set({ filename: name, storageKey: `/objects/orgs/${orgA}/uploads/${p.id}` }).where(eq(photosTable.id, p.id));
    await db.insert(projectPhotosTable).values({ projectId, photoId: p.id });
  }
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockImplementation(
    async () => ({ createReadStream: () => Readable.from([Buffer.from("img")]) }) as never,
  );
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

// Entry names from the zip's central directory.
function centralNames(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const n = buf.readUInt16LE(i + 28);
      const m = buf.readUInt16LE(i + 30);
      const k = buf.readUInt16LE(i + 32);
      out.push(buf.subarray(i + 46, i + 46 + n).toString("utf8"));
      i += 45 + n + m + k;
    }
  }
  return out;
}

describe("project zip entry names", () => {
  it("are safe, unique, and never collide with the manifest", async () => {
    const res = await fetch(`${base}/projects/${projectId}/download`, {
      headers: { "x-test-auth-user": admin.authUserId, "x-organization-id": String(orgA) },
    });
    expect(res.status).toBe(200);
    const names = centralNames(Buffer.from(await res.arrayBuffer()));
    expect(names).toHaveLength(NAMES.length + 1);
    expect(names.filter((n) => n === "usage-rights.json")).toHaveLength(1);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const n of names) {
      expect(n).not.toMatch(/[\\/]/);
      expect(n).not.toContain("..");
      expect(n).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(n.startsWith(".")).toBe(false);
      expect(n.length).toBeLessThanOrEqual(150);
      expect(n.length).toBeGreaterThan(0);
    }
    expect(names).toContain("x.jpg");
    expect(names).toContain("y.png");
    expect(names.find((n) => n.endsWith(".jpeg"))).toBeTruthy();
  });
});

describe("safeZipEntryName", () => {
  it("falls back to photo-<id>.<ext> for names with nothing usable", () => {
    expect(safeZipEntryName("..", 7)).toBe("photo-7.jpg");
    expect(safeZipEntryName(null, 8)).toBe("photo-8.jpg");
    expect(safeZipEntryName("///", 9)).toBe("photo-9.jpg");
  });
  it("keeps the extension when truncating", () => {
    const n = safeZipEntryName(`${"a".repeat(500)}.png`, 1);
    expect(n.endsWith(".png")).toBe(true);
    expect(n.length).toBeLessThanOrEqual(150);
  });
});
