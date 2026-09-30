import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Readable } from "node:stream";

// Storage hardening (private advisories GHSA-7m6g-qrmr-w2v8, GHSA-m962-7g6v-rff3).
// Auth is mocked as in the org isolation suite; object storage is replaced by
// an in-memory fake so tests can see which keys routes touch and what they serve.
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const touchedKeys: string[] = [];
const uploadUrlArgs: unknown[][] = [];
const stored = new Map<string, { contentType: string; body: Buffer; size?: number }>();
const deletedKeys: string[] = [];

vi.mock("../objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../objectStorage")>();
  class FakeObjectStorageService {
    getPrivateObjectDir() {
      return "/bucket/private";
    }
    async getObjectEntityUploadURL(...args: unknown[]) {
      uploadUrlArgs.push(args);
      return `https://storage.googleapis.com/bucket/private/orgs/${args[0]}/uploads/fixed-uuid?X-Goog-Signature=x`;
    }
    normalizeObjectEntityPath(raw: string) {
      return new URL(raw).pathname.replace("/bucket/private/", "/objects/");
    }
    async getObjectEntityFile(key: string) {
      touchedKeys.push(key);
      const obj = stored.get(key) ?? { contentType: "image/png", body: PNG };
      return {
        getMetadata: async () => [{ contentType: obj.contentType, size: String(obj.size ?? obj.body.length) }],
        createReadStream: () => Readable.from([obj.body]),
        delete: async () => {
          deletedKeys.push(key);
        },
      };
    }
    async downloadObject(file: { getMetadata: () => Promise<[{ contentType: string }]> }) {
      const [meta] = await file.getMetadata();
      const key = touchedKeys[touchedKeys.length - 1];
      return new Response(new Uint8Array(stored.get(key)?.body ?? PNG), {
        headers: { "Content-Type": meta.contentType, "Cache-Control": "private, max-age=3600" },
      });
    }
    async deleteObjectEntity(key: string) {
      deletedKeys.push(key);
    }
    async searchPublicObject() {
      return null;
    }
  }
  return { ...actual, ObjectStorageService: FakeObjectStorageService };
});
// Background work after a photo registers — not under test here.
vi.mock("../aiPhotoAnalysis", async (o) => ({ ...(await o<typeof import("../aiPhotoAnalysis")>()), runAndRecordPhotoAnalysis: async () => {} }));
vi.mock("../imageOptimization", async (o) => ({ ...(await o<typeof import("../imageOptimization")>()), optimizeOriginalImage: async () => {} }));
vi.mock("../thumbnailGeneration", async (o) => ({ ...(await o<typeof import("../thumbnailGeneration")>()), generateAndStoreThumbnail: async () => {} }));
vi.mock("../contentHash", async (o) => ({ ...(await o<typeof import("../contentHash")>()), computeAndStoreContentHash: async () => {} }));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, photosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";
import { deletePhotoStorageObjects } from "../photoHelpers";
import { deleteOrganizationCascade } from "../platformDeletion";

let server: Server;
let baseUrl: string;
let userA: { id: number; authUserId: string };
let userB: { id: number; authUserId: string };
let orgA: number;
let orgB: number;
let albumB: number;

beforeAll(async () => {
  await resetDb();
  const a = await createOrganization({ name: "Org A", slug: "hard-org-a" });
  const b = await createOrganization({ name: "Org B", slug: "hard-org-b" });
  orgA = a.id;
  orgB = b.id;
  userA = await createUser({ name: "Alice" });
  userB = await createUser({ name: "Bob" });
  await addOrganizationMember(orgA, userA.id, "owner");
  await addOrganizationMember(orgB, userB.id, "owner");
  albumB = (await createAlbum(userB.id, "B album", orgB)).id;
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

beforeEach(() => {
  touchedKeys.length = 0;
  uploadUrlArgs.length = 0;
  deletedKeys.length = 0;
  stored.clear();
  delete process.env.SIGN_UPLOAD_LENGTH_RANGE;
});

async function call(as: { authUserId: string }, org: number, path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = { "x-test-auth-user": as.authUserId, "x-organization-id": String(org) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const aKey = () => `/objects/orgs/${orgA}/uploads/11111111-2222-3333-4444-555555555555`;
const bKey = () => `/objects/orgs/${orgB}/uploads/66666666-7777-8888-9999-000000000000`;

describe("registration only accepts this organization's upload keys (GHSA-7m6g-qrmr-w2v8)", () => {
  it("rejects a photo pointing at another org's object without touching storage", async () => {
    const res = await call(userB, orgB, `/api/albums/${albumB}/photos`, "POST", { url: `/api/storage${aKey()}`, storageKey: aKey() });
    expect(res.status).toBe(400);
    expect(touchedKeys).not.toContain(aKey());
  });

  it.each([
    ["legacy unprefixed key", "/objects/uploads/abc"],
    ["thumbnail key", "/objects/thumbnails/abc"],
    ["traversal", `/objects/orgs/${0}/uploads/../../orgs/1/uploads/x`],
  ])("rejects a photo registered with a %s", async (_label, key) => {
    const k = key.replace("orgs/0/", `orgs/${orgB}/`);
    const res = await call(userB, orgB, `/api/albums/${albumB}/photos`, "POST", { url: "/x", storageKey: k });
    expect(res.status).toBe(400);
    expect(touchedKeys).not.toContain(k);
  });

  it("still registers a photo uploaded to this org", async () => {
    const res = await call(userB, orgB, `/api/albums/${albumB}/photos`, "POST", { url: `/api/storage${bKey()}`, storageKey: bKey(), filesize: 12 });
    expect(res.status).toBe(201);
    expect(touchedKeys).toContain(bKey());
  });

  it("rejects an asset pointing at another org's object, accepts its own", async () => {
    const bad = await call(userB, orgB, "/api/assets", "POST", { kind: "brand", name: "Logo", storageKey: aKey(), contentType: "image/png" });
    expect(bad.status).toBe(400);
    const ok = await call(userB, orgB, "/api/assets", "POST", { kind: "brand", name: "Logo", storageKey: bKey(), contentType: "image/png" });
    expect(ok.status).toBe(201);
  });

  it("rejects an org logo pointing at another org's object, accepts its own", async () => {
    const bad = await call(userB, orgB, "/api/organizations/current", "PATCH", { logoKey: aKey() });
    expect(bad.status).toBe(400);
    const ok = await call(userB, orgB, "/api/organizations/current", "PATCH", { logoKey: bKey() });
    expect(ok.status).toBe(200);
  });
});

describe("upload URLs only for real image/font types, bound to that type (GHSA-m962-7g6v-rff3)", () => {
  it.each(["text/html", "text/html;x=woff", "application/xhtml+xml", "image/svg+xml;charset=utf-8", "application/octet-stream"])(
    "refuses to mint an upload URL for %s",
    async (contentType) => {
      const res = await call(userB, orgB, "/api/storage/uploads/request-url", "POST", { name: "page.html", size: 10, contentType });
      expect(res.status).toBe(400);
      expect(uploadUrlArgs).toHaveLength(0);
    },
  );

  it.each([
    ["photo.jpg", "image/jpeg"],
    ["logo.svg", "image/svg+xml"],
    ["brand.woff2", "font/woff2"],
    ["brand.ttf", "application/octet-stream"],
  ])("mints an upload URL for %s (%s) and signs its content type", async (name, contentType) => {
    const res = await call(userB, orgB, "/api/storage/uploads/request-url", "POST", { name, size: 10, contentType });
    expect(res.status).toBe(200);
    expect(uploadUrlArgs.at(-1)).toEqual([orgB, contentType, undefined]);
  });
});

describe("upload size (audit #8)", () => {
  const MB = 1024 * 1024;

  it("refuses to mint an upload URL for a declared size over the limit", async () => {
    const res = await call(userB, orgB, "/api/storage/uploads/request-url", "POST", { name: "huge.jpg", size: 100 * MB + 1, contentType: "image/jpeg" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("file_too_large");
    expect(uploadUrlArgs).toHaveLength(0);
  });

  it("without size signing, returns only the signed content type as upload headers", async () => {
    const res = await call(userB, orgB, "/api/storage/uploads/request-url", "POST", { name: "p.jpg", size: 5000, contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { uploadHeaders: Record<string, string> }).uploadHeaders).toEqual({ "Content-Type": "image/jpeg" });
    expect(uploadUrlArgs.at(-1)).toEqual([orgB, "image/jpeg", undefined]);
  });

  it("with size signing, binds the declared size and tells the client to send it", async () => {
    process.env.SIGN_UPLOAD_LENGTH_RANGE = "true";
    const res = await call(userB, orgB, "/api/storage/uploads/request-url", "POST", { name: "p.jpg", size: 5000, contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { uploadHeaders: Record<string, string> }).uploadHeaders).toEqual({ "Content-Type": "image/jpeg", "x-goog-content-length-range": "0,5000" });
    expect(uploadUrlArgs.at(-1)).toEqual([orgB, "image/jpeg", 5000]);
  });

  it("records the stored object's real size, not the declared one", async () => {
    stored.set(bKey(), { contentType: "image/png", body: PNG, size: 4321 });
    const res = await call(userB, orgB, `/api/albums/${albumB}/photos`, "POST", { url: `/api/storage${bKey()}`, storageKey: bKey(), filesize: 1 });
    expect(res.status).toBe(201);
    const [row] = await db.select({ filesize: photosTable.filesize }).from(photosTable).where(eq(photosTable.id, ((await res.json()) as { id: number }).id));
    expect(row.filesize).toBe(4321);
  });

  it("rejects (and removes) an uploaded photo over the limit, whatever was declared", async () => {
    stored.set(bKey(), { contentType: "image/png", body: PNG, size: 100 * MB + 1 });
    const res = await call(userB, orgB, `/api/albums/${albumB}/photos`, "POST", { url: `/api/storage${bKey()}`, storageKey: bKey(), filesize: 10 });
    expect(res.status).toBe(413);
    expect(deletedKeys).toContain(bKey());
  });

  it("applies the storage quota to the real size", async () => {
    // Org C (free, 2 GB) is 100 bytes under its cap; the upload claims 1 byte but is 5,000.
    const c = await createOrganization({ name: "Org C", slug: "hard-org-c" });
    await addOrganizationMember(c.id, userB.id, "owner");
    const albumC = (await createAlbum(userB.id, "C album", c.id)).id;
    await createPhoto(albumC, userB.id, { organizationId: c.id, filesize: 2 * 1024 * MB - 100 });
    const cKey = `/objects/orgs/${c.id}/uploads/12121212-3434-5656-7878-909090909090`;
    stored.set(cKey, { contentType: "image/png", body: PNG, size: 5000 });
    const res = await call(userB, c.id, `/api/albums/${albumC}/photos`, "POST", { url: `/api/storage${cKey}`, storageKey: cKey, filesize: 1 });
    expect(res.status).toBe(402);
  });

  it("records an asset's real size and rejects one over the limit", async () => {
    stored.set(bKey(), { contentType: "image/png", body: PNG, size: 777 });
    const ok = await call(userB, orgB, "/api/assets", "POST", { kind: "brand", name: "Mark", storageKey: bKey(), contentType: "image/png", fileSize: 1 });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { fileSize: number }).fileSize).toBe(777);
    stored.set(bKey(), { contentType: "image/png", body: PNG, size: 100 * MB + 1 });
    const big = await call(userB, orgB, "/api/assets", "POST", { kind: "brand", name: "Huge", storageKey: bKey(), contentType: "image/png" });
    expect(big.status).toBe(413);
  });
});

describe("irreversible storage operations stay inside the row's org", () => {
  it("photo object deletion skips another org's keys", async () => {
    await deletePhotoStorageObjects({ id: 1, organizationId: orgB, storageKey: aKey(), thumbnailKey: `/objects/orgs/${orgB}/thumbnails/t.jpg` });
    expect(deletedKeys).toEqual([`/objects/orgs/${orgB}/thumbnails/t.jpg`]);
  });

  it("still deletes legacy unprefixed keys", async () => {
    await deletePhotoStorageObjects({ id: 2, organizationId: orgB, storageKey: "/objects/uploads/legacy", thumbnailKey: null });
    expect(deletedKeys).toEqual(["/objects/uploads/legacy"]);
  });

  it("an org purge never unlinks another org's object", async () => {
    const d = await createOrganization({ name: "Org D", slug: "hard-org-d" });
    const owner = await createUser({ name: "Dee" });
    await addOrganizationMember(d.id, owner.id, "owner");
    const albumD = (await createAlbum(owner.id, "D album", d.id)).id;
    const own = `/objects/orgs/${d.id}/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const p1 = await createPhoto(albumD, owner.id, { organizationId: d.id });
    const p2 = await createPhoto(albumD, owner.id, { organizationId: d.id });
    // A row registered before upload keys were org-checked, pointing at org A's object.
    await db.update(photosTable).set({ storageKey: own }).where(eq(photosTable.id, p1.id));
    await db.update(photosTable).set({ storageKey: aKey() }).where(eq(photosTable.id, p2.id));
    await deleteOrganizationCascade(d.id);
    expect(deletedKeys).toContain(own);
    expect(deletedKeys).not.toContain(aKey());
  });
});

describe("stored objects are served without running as a page (GHSA-m962-7g6v-rff3)", () => {
  it("serves an HTML object as a sandboxed attachment, privately cached", async () => {
    stored.set(bKey(), { contentType: "text/html", body: Buffer.from("<script>alert(1)</script>") });
    const res = await call(userB, orgB, `/api/storage${bKey()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
  });

  it("serves SVG as an attachment too (still usable in <img>)", async () => {
    stored.set(bKey(), { contentType: "image/svg+xml", body: Buffer.from("<svg/>") });
    const res = await call(userB, orgB, `/api/storage${bKey()}`);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("keeps raster images inline", async () => {
    const res = await call(userB, orgB, `/api/storage${bKey()}`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition") ?? "inline").toMatch(/^inline/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});
