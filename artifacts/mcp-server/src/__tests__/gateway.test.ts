import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The tool layer's database/storage libraries are replaced with an in-memory
// library of two orgs, so these tests drive the real gateway routes and the
// real MCP tool handlers over HTTP without Postgres or GCS.
const PHOTOS = {
  100: { org: 1, filename: "shot one.webp", contentType: "image/webp", original: "P100-original", thumb: "P100-thumb" },
  101: { org: 1, filename: "shot two.jpg", contentType: "image/jpeg", original: "P101-original", thumb: "P101-thumb" },
  200: { org: 2, filename: "other org.jpg", contentType: "image/jpeg", original: "P200-original", thumb: "P200-thumb" },
} as const;
const ASSETS = { 300: { org: 1, filename: "logo.svg", contentType: "image/svg+xml", original: "<svg/>" } } as const;
type PhotoId = keyof typeof PHOTOS;

function summary(id: PhotoId) {
  return {
    id, filename: PHOTOS[id].filename, albumTitle: "Album", aiDescription: null, width: 10, height: 10,
    averageRating: null, ratingCount: 0, rights: [], thumbnailKey: `/objects/t-${id}`, takenAt: null, aiScore: null, aiFlaws: [],
  };
}

vi.mock("../photoLibrary.js", () => ({
  searchPhotos: async ({ organizationId }: { organizationId?: number }) => ({
    results: (Object.keys(PHOTOS).map(Number) as PhotoId[]).filter((id) => PHOTOS[id].org === organizationId).map(summary),
  }),
  getPhotoDetail: async (id: number, organizationId?: number) => {
    const p = PHOTOS[id as PhotoId];
    return p && p.org === organizationId ? { photo: summary(id as PhotoId), fullResUrl: "http://storage.local/signed" } : null;
  },
  listAlbums: async () => [],
  listPeople: async () => [],
  listUsageRights: async () => [],
  loadThumbnailImage: async () => null,
}));
vi.mock("../assetLibrary.js", () => ({
  listAssets: async () => ({ assets: [] }),
  getAssetDetail: async (id: number, organizationId?: number) => {
    const a = ASSETS[id as keyof typeof ASSETS];
    return a && a.org === organizationId
      ? {
          asset: { id, kind: "brand", name: "Logo", variant: null, notes: null, projectName: null, storageKey: "/objects/a", contentType: a.contentType, filename: a.filename, fileSize: 6 },
          fullResUrl: "http://storage.local/signed-asset",
        }
      : null;
  },
  loadAssetImage: async () => null,
}));

const { createServer } = await import("../server.js");
const { createGatewayApp } = await import("../gatewayApp.js");
const { credentialFingerprint, resolveMediaGrantKeys, signMediaGrant, MEDIA_GRANT_TTL_SECONDS } = await import("../mediaGrants.js");
type Keys = ReturnType<typeof resolveMediaGrantKeys>;

const TOKEN_A = `tvmcp_${"a".repeat(40)}`; // org 1, db id 11
const TOKEN_B = `tvmcp_${"b".repeat(40)}`; // org 2, db id 22
const T0 = Date.parse("2026-09-29T00:00:00Z");

let nowMs = T0;
let liveTokens: Map<number, { org: number; raw: string }>;
let failFiles = false;
let keys: Keys;
let http: Server;
let base: string;
const logged: string[] = [];

function fileFor(id: number, org: number | undefined, rep: "original" | "thumb", table: "photo" | "asset") {
  if (failFiles) throw new Error("storage unavailable");
  const row = table === "photo" ? PHOTOS[id as PhotoId] : ASSETS[id as keyof typeof ASSETS];
  if (!row || row.org !== org) return null;
  const body = rep === "thumb" && "thumb" in row ? row.thumb : row.original;
  return { buffer: Buffer.from(body), contentType: row.contentType, filename: row.filename };
}

async function startGateway(gatewayKeys: Keys): Promise<void> {
  http = createHttpServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const app = createGatewayApp({
    publicUrl: base,
    keys: gatewayKeys,
    now: () => nowMs,
    async resolveCredential(candidate) {
      for (const [id, t] of liveTokens) {
        if (t.raw === candidate) return { organizationId: t.org, parent: { type: "db", id, fingerprint: credentialFingerprint(candidate) } };
      }
      return null;
    },
    async isGrantParentLive(claims) {
      if (claims.par.type !== "db") return false;
      const t = liveTokens.get(claims.par.id);
      return !!t && t.org === claims.org && credentialFingerprint(t.raw) === claims.par.fingerprint;
    },
    createMcpServer: createServer,
    getPhotoOriginal: async (id, org) => fileFor(id, org, "original", "photo"),
    getPhotoThumbnail: async (id, org) => fileFor(id, org, "thumb", "photo"),
    getAssetOriginal: async (id, org) => fileFor(id, org, "original", "asset"),
  });
  http.on("request", app);
}

async function stopGateway(): Promise<void> {
  await new Promise<void>((resolve) => http.close(() => resolve()));
}

async function connect(auth: "url" | "header", token: string): Promise<Client> {
  const client = new Client({ name: "gateway-test", version: "1.0.0" });
  const transport = auth === "url"
    ? new StreamableHTTPClientTransport(new URL(`${base}/${token}/mcp`))
    : new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

type Block = { type: string; text?: string; uri?: string; name?: string; description?: string; mimeType?: string };

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Block[]> {
  const result = await client.callTool({ name, arguments: args });
  return result.content as Block[];
}

function links(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.type === "resource_link");
}

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

beforeEach(async () => {
  nowMs = T0;
  failFiles = false;
  liveTokens = new Map([[11, { org: 1, raw: TOKEN_A }], [22, { org: 2, raw: TOKEN_B }]]);
  keys = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "k".repeat(40) });
  await startGateway(keys);
});

afterEach(stopGateway);

afterAll(() => {
  // Nothing the gateway logged may carry a connector credential or a grant.
  for (const line of logged) {
    expect(line).not.toContain(TOKEN_A);
    expect(line).not.toContain(TOKEN_B);
    expect(line).not.toContain("/media/");
  }
  vi.restoreAllMocks();
});

describe.each(["url", "header"] as const)("%s-authenticated connector", (auth) => {
  it("keeps connector auth working and returns credential-free, expiring photo links", async () => {
    const client = await connect(auth, TOKEN_A);
    const blocks = await callTool(client, "get_photo", { id: 100 });
    await client.close();

    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    expect(text).toContain("full-resolution download (expires 2026-09-29T01:00:00Z)");
    const [original, thumbnail] = links(blocks);
    for (const link of [original, thumbnail]) {
      expect(link.uri?.startsWith(`${base}/media/`)).toBe(true);
      expect(link.uri).not.toContain(TOKEN_A);
      expect(link.description).toContain("expires 2026-09-29T01:00:00Z");
    }
    expect(JSON.stringify(blocks)).not.toContain(TOKEN_A);

    const res = await fetch(original.uri!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("P100-original");
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="shot one.webp"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const thumb = await fetch(thumbnail.uri!);
    expect(thumb.status).toBe(200);
    expect(await thumb.text()).toBe("P100-thumb");
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(thumb.headers.get("content-disposition")).toBe('inline; filename="shot one.jpg"');
  });

  it("gives search results per-photo thumbnail grants and asset downloads a grant", async () => {
    const client = await connect(auth, TOKEN_A);
    const search = links(await callTool(client, "search_photos", { query: "anything", includeImages: false }));
    const asset = links(await callTool(client, "get_asset", { id: 300 }));
    await client.close();

    expect(search).toHaveLength(2);
    const bodies = await Promise.all(search.map(async (l) => (await fetch(l.uri!)).text()));
    expect(bodies.sort()).toEqual(["P100-thumb", "P101-thumb"]);

    expect(asset).toHaveLength(1);
    expect(asset[0].uri).not.toContain(TOKEN_A);
    const res = await fetch(asset[0].uri!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    // Non-raster originals are downloads, never pages on the gateway origin.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="logo.svg"');
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("<svg/>");
  });
});

describe("hostile media requests", () => {
  async function photoLinks(token = TOKEN_A, id = 100): Promise<{ original: string; thumbnail: string }> {
    const client = await connect("header", token);
    const [original, thumbnail] = links(await callTool(client, "get_photo", { id }));
    await client.close();
    return { original: original.uri!, thumbnail: thumbnail.uri! };
  }

  function grantOf(url: string): string {
    return url.slice(url.indexOf("/media/") + "/media/".length);
  }

  function reencode(url: string, edit: (c: Record<string, unknown>) => Record<string, unknown>): string {
    const [payload, sig] = grantOf(url).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return `${base}/media/${Buffer.from(JSON.stringify(edit(claims))).toString("base64url")}.${sig}`;
  }

  it("rejects a grant altered to open another object, representation or org", async () => {
    const { original } = await photoLinks();
    for (const edit of [
      (c: Record<string, unknown>) => ({ ...c, id: 101 }),
      (c: Record<string, unknown>) => ({ ...c, rep: "thumbnail" }),
      (c: Record<string, unknown>) => ({ ...c, org: 2, id: 200 }),
      (c: Record<string, unknown>) => ({ ...c, kind: "asset", id: 300 }),
    ]) {
      const res = await fetch(reencode(original, edit));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("P1");
    }
    expect((await fetch(original.slice(0, -3))).status).toBe(403);
  });

  it("expires links at their stated time", async () => {
    const { original } = await photoLinks();
    nowMs = T0 + (MEDIA_GRANT_TTL_SECONDS - 1) * 1000;
    expect((await fetch(original)).status).toBe(200);
    nowMs = T0 + MEDIA_GRANT_TTL_SECONDS * 1000;
    const res = await fetch(original);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toContain("expired");
  });

  it("kills outstanding links when the parent connector token is revoked", async () => {
    const { original, thumbnail } = await photoLinks();
    expect((await fetch(original)).status).toBe(200);
    liveTokens.delete(11);
    expect((await fetch(original)).status).toBe(403);
    expect((await fetch(thumbnail)).status).toBe(403);
  });

  it("does not let one org's credential mint access to another org's media", async () => {
    // A correctly signed grant naming org 2 but minted under org 1's token.
    const forged = signMediaGrant(
      { v: 1, aud: base, org: 2, kind: "photo", id: 200, rep: "original", par: { type: "db", id: 11, fingerprint: credentialFingerprint(TOKEN_A) }, exp: Math.floor(T0 / 1000) + 600 },
      keys,
    );
    expect((await fetch(`${base}/media/${forged}`)).status).toBe(403);
    // Org 1's own grant for org 2's photo id finds nothing.
    const crossId = signMediaGrant(
      { v: 1, aud: base, org: 1, kind: "photo", id: 200, rep: "original", par: { type: "db", id: 11, fingerprint: credentialFingerprint(TOKEN_A) }, exp: Math.floor(T0 / 1000) + 600 },
      keys,
    );
    expect((await fetch(`${base}/media/${crossId}`)).status).toBe(404);
    // And the tools never hand out an org-2 object to an org-1 client.
    const client = await connect("header", TOKEN_A);
    const blocks = await callTool(client, "get_photo", { id: 200 });
    await client.close();
    expect(links(blocks)).toHaveLength(0);
  });

  it("rejects a grant minted by another deployment", async () => {
    const devGrant = signMediaGrant(
      { v: 1, aud: "https://mcp-dev.example.test", org: 1, kind: "photo", id: 100, rep: "original", par: { type: "db", id: 11, fingerprint: credentialFingerprint(TOKEN_A) }, exp: Math.floor(T0 / 1000) + 600 },
      keys,
    );
    expect((await fetch(`${base}/media/${devGrant}`)).status).toBe(403);
  });

  it("never accepts a grant as an MCP credential", async () => {
    const grant = grantOf((await photoLinks()).original);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(`${base}/${grant}/mcp`, { method: "POST", headers, body })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${grant}` }, body })).status).toBe(401);
    expect((await fetch(`${base}/media/${grant}`, { method: "POST", headers, body })).status).toBe(401);
  });

  it("retires token-in-path media URLs without echoing the token", async () => {
    for (const path of ["photo/100/original", "photo/100/thumbnail", "asset/300/original"]) {
      const res = await fetch(`${base}/${TOKEN_A}/${path}`);
      expect(res.status).toBe(410);
      expect(await res.text()).not.toContain(TOKEN_A);
    }
    // Header-authenticated media stays available (no credential in the URL),
    // org-scoped, with the same content types as grants.
    const bearer = { headers: { authorization: `Bearer ${TOKEN_A}` } };
    for (const [path, body, type] of [
      ["photo/100/original", "P100-original", "image/webp"],
      ["photo/100/thumbnail", "P100-thumb", "image/jpeg"],
      ["asset/300/original", "<svg/>", "image/svg+xml"],
    ] as const) {
      const res = await fetch(`${base}/${path}`, bearer);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(await res.text()).toBe(body);
    }
    expect((await fetch(`${base}/photo/200/original`, bearer)).status).toBe(404);
    expect((await fetch(`${base}/photo/100/original`)).status).toBe(401);
  });

  it("answers storage failures generically and logs neither grant nor token", async () => {
    const { original } = await photoLinks();
    failFiles = true;
    const res = await fetch(original);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(grantOf(original));
    expect(logged.some((l) => l.includes("storage unavailable"))).toBe(true);
    expect(logged.some((l) => l.includes(grantOf(original)))).toBe(false);
  });
});

describe("signing-key rollover at the gateway", () => {
  it("serves links from the previous key while it is configured, then refuses them", async () => {
    const { original } = await (async () => {
      const client = await connect("header", TOKEN_A);
      const [o] = links(await callTool(client, "get_photo", { id: 100 }));
      await client.close();
      return { original: o.uri! };
    })();
    const path = original.slice(base.length);

    await stopGateway();
    await startGateway(resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "n".repeat(40), MCP_MEDIA_SIGNING_KEY_PREVIOUS: "k".repeat(40) }));
    // Same audience requires the same origin; re-sign the old grant's claims for the new port.
    const [payload] = path.slice("/media/".length).split(".");
    const claims = { ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), aud: base };
    const oldKeyGrant = signMediaGrant(claims, resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "k".repeat(40) }));
    expect((await fetch(`${base}/media/${oldKeyGrant}`)).status).toBe(200);

    await stopGateway();
    await startGateway(resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "n".repeat(40) }));
    const reAud = signMediaGrant({ ...claims, aud: base }, resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "k".repeat(40) }));
    expect((await fetch(`${base}/media/${reAud}`)).status).toBe(403);
  });
});
