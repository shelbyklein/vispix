import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

// Hidden photos are invisible to connectors (#218): their bytes must not be
// served by the header-auth routes or by media grants, and list counts must
// not include them.
//
// EVIDENCE CLASS: real Postgres + the real photoLibrary file lookups and
// gateway routes over HTTP; the object-storage client is MOCKED (no bytes are
// read from a real bucket).
vi.hoisted(() => {
  process.env.GCS_ENDPOINT = "http://127.0.0.1:1";
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
});
vi.mock("@workspace/api-server/src/lib/objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-server/src/lib/objectStorage")>();
  return {
    ...actual,
    objectStorageClient: {
      bucket: () => ({
        file: (name: string) => ({
          exists: async () => [true],
          download: async () => [Buffer.from(`bytes:${name}`)],
          getMetadata: async () => [{ contentType: "image/jpeg" }],
        }),
      }),
    },
  };
});

import { db, pool, photosTable, photoCollectionsTable, photoAttributionTagsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDb } from "@workspace/api-server/src/lib/__tests__/testDb";
import {
  buildAcceptanceLibrary,
  type AcceptanceLibrary,
} from "@workspace/api-server/src/lib/__tests__/fixtures/acceptanceLibrary";
import { getOriginalFile, getThumbnailFile, listAlbums, listPeople, listUsageRights } from "../photoLibrary";
import { createGatewayApp } from "../gatewayApp";
import { credentialFingerprint, resolveMediaGrantKeys, signMediaGrant } from "../mediaGrants";

const TOKEN = `tvmcp_${"a".repeat(40)}`;
const keys = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "k".repeat(40) });

let L: AcceptanceLibrary;
let http: Server;
let base: string;
let hidden: number;
let visible: number;

function grant(id: number, rep: "original" | "thumbnail"): string {
  return signMediaGrant(
    {
      v: 1, aud: base, org: L.orgA, kind: "photo", id, rep,
      par: { type: "db", id: 11, fingerprint: credentialFingerprint(TOKEN) },
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    keys,
  );
}
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

beforeAll(async () => {
  await resetDb();
  L = await buildAcceptanceLibrary();
  hidden = L.photosA.find((p) => p.hidden)!.id;
  visible = L.photosA.find((p) => !p.hidden)!.id;
  for (const id of [hidden, visible]) {
    await db.update(photosTable).set({ storageKey: `/objects/orig-${id}`, thumbnailKey: `/objects/thumb-${id}` }).where(eq(photosTable.id, id));
  }
  http = createHttpServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  http.on("request", createGatewayApp({
    publicUrl: base,
    keys,
    async resolveCredential(candidate) {
      return candidate === TOKEN
        ? { organizationId: L.orgA, parent: { type: "db", id: 11, fingerprint: credentialFingerprint(candidate) } }
        : null;
    },
    async isGrantParentLive() {
      return true;
    },
    createMcpServer: (() => {
      throw new Error("unused");
    }) as never,
    getPhotoOriginal: getOriginalFile,
    getPhotoThumbnail: getThumbnailFile,
    getAssetOriginal: async () => null,
  }));
}, 120_000);

afterEach(async () => {
  await db.update(photosTable).set({ isHidden: false }).where(eq(photosTable.id, visible));
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await pool.end();
});

describe("hidden photos are not served to connectors", () => {
  it("serves a visible photo's original and thumbnail", async () => {
    const o = await fetch(`${base}/photo/${visible}/original`, auth);
    expect(o.status).toBe(200);
    expect(await o.text()).toContain(`orig-${visible}`);
    const t = await fetch(`${base}/photo/${visible}/thumbnail`, auth);
    expect(t.status).toBe(200);
    expect((await fetch(`${base}/media/${grant(visible, "original")}`)).status).toBe(200);
    expect((await fetch(`${base}/media/${grant(visible, "thumbnail")}`)).status).toBe(200);
  });

  it("returns 404 for a hidden photo on the header-auth routes", async () => {
    expect((await fetch(`${base}/photo/${hidden}/original`, auth)).status).toBe(404);
    expect((await fetch(`${base}/photo/${hidden}/thumbnail`, auth)).status).toBe(404);
  });

  it("returns 404 for a hidden photo via a media grant", async () => {
    expect((await fetch(`${base}/media/${grant(hidden, "original")}`)).status).toBe(404);
    expect((await fetch(`${base}/media/${grant(hidden, "thumbnail")}`)).status).toBe(404);
  });

  it("stops serving a grant minted while the photo was visible once it is hidden", async () => {
    const o = grant(visible, "original");
    const t = grant(visible, "thumbnail");
    expect((await fetch(`${base}/media/${o}`)).status).toBe(200);
    await db.update(photosTable).set({ isHidden: true }).where(eq(photosTable.id, visible));
    expect((await fetch(`${base}/media/${o}`)).status).toBe(404);
    expect((await fetch(`${base}/media/${t}`)).status).toBe(404);
    expect((await fetch(`${base}/photo/${visible}/original`, auth)).status).toBe(404);
    expect((await fetch(`${base}/photo/${visible}/thumbnail`, auth)).status).toBe(404);
  });
});

describe("list counts exclude hidden photos", () => {
  it("list_albums", async () => {
    const rows = await listAlbums(L.orgA);
    for (const r of rows) {
      expect(r.photoCount).toBe(L.photosA.filter((p) => p.albumId === r.id && !p.hidden).length);
    }
    expect(rows.reduce((n, r) => n + r.photoCount, 0)).toBe(L.photosA.filter((p) => !p.hidden).length);
  });

  it("list_people and list_usage_rights", async () => {
    // Make sure the hidden photo carries a person and a rights tag so the
    // exclusion is actually exercised.
    const person = (await listPeople(L.orgA))[0];
    const tag = (await listUsageRights(L.orgA))[0];
    await db.insert(photoCollectionsTable).values({ collectionId: person.id, photoId: hidden }).onConflictDoNothing();
    await db.insert(photoAttributionTagsTable).values({ tagId: tag.id, photoId: hidden }).onConflictDoNothing();
    const hiddenSpec = L.photosA.find((p) => p.id === hidden)!;
    const expectPeople = (name: string) => L.photosA.filter((p) => p.people.includes(name) && !p.hidden).length;
    const expectRights = (name: string) => L.photosA.filter((p) => p.rights.includes(name) && !p.hidden).length;
    expect(hiddenSpec.hidden).toBe(true);
    for (const r of await listPeople(L.orgA)) {
      expect(r.photoCount).toBe(expectPeople(r.name));
    }
    for (const r of await listUsageRights(L.orgA)) {
      expect(r.photoCount).toBe(expectRights(r.name));
    }
  });
});
