import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

// #215 end to end through runGeneration: provider, key lookup and object storage
// are mocked (in-memory store); DB, composition and bookkeeping are real.
const fx = (name: string) => readFileSync(join(__dirname, "fixtures", "fidelity", name));

const provider = vi.hoisted(() => ({ image: Buffer.alloc(0), calls: [] as Array<{ brief: string; inputImages?: string[] }> }));
vi.mock("../imageGeneration/openaiImage", () => ({
  generateImage: async (args: { brief: string; inputImages?: string[] }) => {
    provider.calls.push({ brief: args.brief, inputImages: args.inputImages });
    return { buffer: provider.image, responseId: "resp", imageModel: "test-image-model" };
  },
}));
vi.mock("../aiProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => ({ apiKey: "test-key", baseURL: null }),
}));

const store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../objectStorage", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../objectStorage")>();
  class FakeStorage {
    async getObjectEntityFile(key: string) {
      const bytes = store.get(key);
      if (!bytes) throw new orig.ObjectNotFoundError();
      return { download: async () => [bytes], getMetadata: async () => [{ contentType: "image/png" }] };
    }
  }
  return {
    ...orig,
    ObjectStorageService: FakeStorage,
    getPrivateObjectDir: () => "/test-bucket/private",
    signObjectURL: async ({ objectName }: { objectName: string }) => `http://fake-storage.test/put/${encodeURIComponent(objectName)}`,
  };
});

import { eq } from "drizzle-orm";
import { db, pool, assetsTable, imageGenerationsTable, photosTable } from "@workspace/db";
import { runGeneration } from "../imageGeneration/orchestrate";
import { generationProvenance, visibleHeroPhotos } from "../imageGeneration/provenance";
import { loadGenerationView, redactInputs } from "../imageGeneration/redact";
import { resetGenerationLimits } from "../imageGeneration/limits";
import { resetDb, createUser, createOrganization, createAlbum, createPhoto } from "./testDb";

const realFetch = globalThis.fetch;
let orgId: number;
let userId: number;
let assetId: number;
const LOGO_KEY = "/objects/orgs/logo-asset";

beforeAll(async () => {
  await resetDb();
  orgId = (await createOrganization({ name: "Fidelity" })).id;
  userId = (await createUser({ name: "fid" })).id;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://fake-storage.test/put/")) {
      const objectName = decodeURIComponent(url.slice("http://fake-storage.test/put/".length));
      store.set(`/objects/${objectName.replace(/^private\//, "")}`, Buffer.from(init!.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    return realFetch(input, init);
  });
  store.set(LOGO_KEY, fx("logo.png"));
  const [asset] = await db
    .insert(assetsTable)
    .values({ organizationId: orgId, kind: "brand", name: "Test logo", storageKey: LOGO_KEY, contentType: "image/png" })
    .returning();
  assetId = asset.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});

beforeEach(() => {
  resetGenerationLimits();
  provider.calls.length = 0;
  provider.image = fx("output-with-placeholder.png");
});

async function settled(id: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select().from(imageGenerationsTable).where(eq(imageGenerationsTable.id, id));
    if (row.status !== "pending") return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("generation never settled");
}

const logoInput = { kind: "asset" as const, refId: 0, role: "exact_asset" as const };
async function generate(extra: Record<string, unknown> = {}) {
  const res = await runGeneration({
    organizationId: orgId,
    userId,
    prompt: "a poster",
    inputs: [{ ...logoInput, refId: assetId }],
    variantCount: 1,
    ...extra,
  });
  return settled(res.generations[0].id);
}

async function magentaCount(key: string) {
  const { data } = await sharp(store.get(key)!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200) n++;
  return n;
}

describe("exact logo composition", () => {
  it("asks the model for a placeholder, composites the original logo and records it", async () => {
    const row = await generate();
    expect(row.status).toBe("succeeded");

    const brief = provider.calls[0].brief;
    expect(brief).toContain("#FF00FF");
    expect(brief).toContain("200:120");
    expect(brief).toMatch(/do NOT draw/);

    expect(row.composition).toMatchObject({
      mode: "exact_logo",
      assetId,
      assetName: "Test logo",
      placement: "model_placeholder",
      layout: { x: 780, y: 840, width: 200, height: 120 },
    });
    expect(row.composition!.assetRevision).toMatch(/^\/objects\/orgs\/logo-asset#[0-9a-f]{12}$/);

    // Base keeps the placeholder; the final image has none.
    expect(row.baseStorageKey).toBeTruthy();
    expect(row.baseStorageKey).not.toBe(row.storageKey);
    expect(await magentaCount(row.baseStorageKey!)).toBeGreaterThan(20000);
    expect(await magentaCount(row.storageKey!)).toBe(0);

    expect(row.provenance).toMatchObject({ model: "test-image-model" });
    expect(row.formatResolution).toEqual({ requested: "1:1", rendered: "1:1", supported: true });
    expect(row.photoTreatment).toBeNull();
  });

  it("falls back to the default corner when the model left no placeholder", async () => {
    provider.image = fx("output-without-placeholder.png");
    const row = await generate();
    expect(row.status).toBe("succeeded");
    expect(row.composition!.placement).toBe("default_corner");
    expect(row.composition!.layout.x + row.composition!.layout.width).toBeGreaterThan(900);
  });

  it("rejects an unreadable logo file up front, before any provider call", async () => {
    store.set(LOGO_KEY, Buffer.from("not an image"));
    try {
      await expect(generate()).rejects.toMatchObject({ statusCode: 400 });
      expect(provider.calls).toHaveLength(0);
    } finally {
      store.set(LOGO_KEY, fx("logo.png"));
    }
  });

  it("fails the generation when compositing fails (never succeeds without the logo)", async () => {
    provider.image = Buffer.from("the model returned garbage");
    const row = await generate();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Image generation failed. Please try again.");
    expect(row.storageKey).toBeNull();
    expect(row.composition).toBeNull();
  });

  it("records extra exact assets as not composited", async () => {
    const [second] = await db
      .insert(assetsTable)
      .values({ organizationId: orgId, kind: "brand", name: "Second logo", storageKey: LOGO_KEY, contentType: "image/png" })
      .returning();
    const res = await runGeneration({
      organizationId: orgId,
      userId,
      prompt: "two logos",
      inputs: [
        { kind: "asset", refId: assetId, role: "exact_asset" },
        { kind: "asset", refId: second.id, role: "exact_asset" },
      ],
      variantCount: 1,
    });
    const row = await settled(res.generations[0].id);
    expect(row.composition!.assetId).toBe(assetId);
    expect((row.settings as { notComposited?: string[] }).notComposited).toEqual(["Second logo"]);
  });
});

describe("revisions", () => {
  it("regenerate from the base image and re-composite at the same layout", async () => {
    const parent = await generate();
    provider.calls.length = 0;
    const res = await runGeneration({
      organizationId: orgId,
      userId,
      prompt: "make the sky bluer",
      inputs: [],
      variantCount: 1,
      parentGenerationId: parent.id,
    });
    const child = await settled(res.generations[0].id);
    expect(child.status).toBe("succeeded");
    expect(child.parentGenerationId).toBe(parent.id);

    // The model was shown the BASE (magenta placeholder), not the composited logo.
    expect(provider.calls[0].brief).toContain("#FF00FF");
    expect(provider.calls[0].inputImages).toHaveLength(1);

    expect(child.composition!.layout).toEqual(parent.composition!.layout);
    expect(child.composition!.placement).toBe(parent.composition!.placement);
    expect(child.composition!.assetRevision).toBe(parent.composition!.assetRevision);
    expect(child.baseStorageKey).toBeTruthy();
    expect(child.baseStorageKey).not.toBe(parent.baseStorageKey);
    expect(await magentaCount(child.storageKey!)).toBe(0);
  });

  it("keeps the layout even if the model moved its placeholder", async () => {
    const parent = await generate();
    provider.image = fx("output-without-placeholder.png");
    const res = await runGeneration({ organizationId: orgId, userId, prompt: "tweak", inputs: [], variantCount: 1, parentGenerationId: parent.id });
    const child = await settled(res.generations[0].id);
    expect(child.composition!.layout).toEqual(parent.composition!.layout);
    expect(child.composition!.placement).toBe("model_placeholder");
  });

  it("a revision of a row without a base image falls back to its final image and no composition", async () => {
    provider.image = fx("output-without-placeholder.png");
    const res0 = await runGeneration({ organizationId: orgId, userId, prompt: "plain", inputs: [], variantCount: 1 });
    const plain = await settled(res0.generations[0].id);
    expect(plain.baseStorageKey).toBeNull();
    expect(plain.composition).toBeNull();
    const res = await runGeneration({ organizationId: orgId, userId, prompt: "again", inputs: [], variantCount: 1, parentGenerationId: plain.id });
    const child = await settled(res.generations[0].id);
    expect(child.status).toBe("succeeded");
    expect(child.composition).toBeNull();
  });
});

describe("format, photo treatment, grounding", () => {
  it("records requested vs rendered format and acknowledged inputs", async () => {
    provider.image = fx("output-without-placeholder.png");
    const res = await runGeneration({
      organizationId: orgId,
      userId,
      prompt: "story",
      inputs: [],
      variantCount: 1,
      format: "2:3",
      requestedFormat: "9:16",
      acknowledgedMissing: ["exact_asset"],
    });
    const row = await settled(res.generations[0].id);
    expect(row.formatResolution).toEqual({ requested: "9:16", rendered: "2:3", supported: false });
    expect(row.acknowledgedMissing).toEqual(["exact_asset"]);
    const f = generationProvenance(row, { canSeeHidden: false });
    expect(f.formatResolution).toEqual({ requested: "9:16", rendered: "2:3", supported: false });
    expect(f.grounding.acknowledgedMissing).toEqual(["exact_asset"]);
    expect(f.composition).toBeNull();
  });

  it("marks a hero photo as reinterpreted", async () => {
    provider.image = fx("output-without-placeholder.png");
    const album = await createAlbum(userId, "A", orgId);
    const photo = await createPhoto(album.id, userId, { organizationId: orgId });
    store.set("/objects/orgs/hero", fx("output-without-placeholder.png"));
    await db.update(photosTable).set({ storageKey: "/objects/orgs/hero" }).where(eq(photosTable.id, photo.id));
    const res = await runGeneration({
      organizationId: orgId,
      userId,
      prompt: "hero",
      inputs: [{ kind: "photo", refId: photo.id, role: "hero_photo" }],
      variantCount: 1,
    });
    const row = await settled(res.generations[0].id);
    expect(row.status).toBe("succeeded");
    expect(row.photoTreatment).toBe("reinterpreted");
    expect(generationProvenance(row, { canSeeHidden: true }).photoTreatment).toBe("reinterpreted");
  });
});

describe("provenance redaction", () => {
  it("members get no storage keys and no links to hidden photos", async () => {
    const album = await createAlbum(userId, "H", orgId);
    const hidden = await createPhoto(album.id, userId, { organizationId: orgId, isHidden: true });
    const visible = await createPhoto(album.id, userId, { organizationId: orgId });
    const row = await generate();
    const withPhotos = {
      ...row,
      inputs: [
        { kind: "photo" as const, refId: hidden.id, storageKey: "/objects/secret-hidden", role: "hero_photo" as const, name: "secret.jpg" },
        { kind: "photo" as const, refId: visible.id, storageKey: "/objects/ok", role: "hero_photo" as const, name: "ok.jpg" },
      ],
    };
    const view = await loadGenerationView(orgId, false, [withPhotos]);
    const links = visibleHeroPhotos(withPhotos.inputs, view);
    expect(links).toEqual([{ photoId: visible.id, name: "ok.jpg" }]);
    expect(JSON.stringify(redactInputs(withPhotos.inputs, view))).not.toContain("secret");

    const member = generationProvenance(withPhotos, { canSeeHidden: false });
    expect(JSON.stringify(member)).not.toContain("/objects/");
    expect(JSON.stringify(member)).not.toContain("secret");
    expect(member.composition!.assetRevision).toMatch(/^[0-9a-f]{12}$/);

    const manager = generationProvenance(withPhotos, { canSeeHidden: true });
    expect(manager.composition!.assetRevision).toMatch(/^\/objects\/orgs\/logo-asset#[0-9a-f]{12}$/);
    const managerLinks = visibleHeroPhotos(withPhotos.inputs, await loadGenerationView(orgId, true, [withPhotos]));
    expect(managerLinks.map((l) => l.photoId)).toEqual([hidden.id, visible.id]);
  });
});
