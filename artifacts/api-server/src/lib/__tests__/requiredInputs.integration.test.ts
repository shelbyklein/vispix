import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Required inputs (#215): the plan marks what a design needs and whether the
// library can supply it; Create records acknowledged gaps; Campaigns refuse to
// render a concept whose required inputs can't be grounded. No provider is
// contacted: the planner / concept LLM call, photo retrieval and runGeneration
// are all stubbed.
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

const llm = vi.hoisted(() => ({
  planner: { summary: "A poster", clarifyingQuestions: [] as string[], heroPhotoQuery: null as string | null, brandAssetQuery: null as string | null, suggestedFormat: null as string | null },
  concepts: [] as { title: string; prompt: string; format: string; heroPhotoQuery: string | null; useLogo: boolean }[],
  photoIds: [] as number[],
}));
vi.mock("openai", () => {
  class OpenAI {
    chat = {
      completions: {
        create: async (args: { response_format: { json_schema: { name: string } } }) => ({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  args.response_format.json_schema.name === "generation_plan" ? llm.planner : { concepts: llm.concepts },
                ),
              },
            },
          ],
        }),
      },
    };
  }
  return { default: OpenAI };
});
vi.mock("../aiProviders", async (o) => ({
  ...(await o<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => ({ apiKey: "k", baseURL: null }),
}));
vi.mock("../photoRetrieval", async (o) => ({
  ...(await o<typeof import("../photoRetrieval")>()),
  retrievePhotos: async () => ({ status: "ok", items: llm.photoIds.map((photoId) => ({ photoId })), total: llm.photoIds.length }),
}));

type RunArgs = { sessionId: number; inputs: { kind: string; refId: number; role: string }[]; format?: string; requestedFormat?: string; acknowledgedMissing?: string[] };
const runs: RunArgs[] = [];
vi.mock("../imageGeneration/orchestrate", async (o) => ({
  ...(await o<typeof import("../imageGeneration/orchestrate")>()),
  runGeneration: async (args: RunArgs) => {
    runs.push(args);
    return { sessionId: args.sessionId ?? 1, generations: [] };
  },
}));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, assetsTable, campaignsTable } from "@workspace/db";
import { planGeneration } from "../imageGeneration/plan";
import { generateCampaignSuggestions, generateCampaignConcept } from "../imageGeneration/campaignSuggestions";
import { resetDb, createUser, createOrganization, addOrganizationMember, createAlbum, createPhoto } from "./testDb";

let server: Server;
let baseUrl: string;
let owner: { id: number; authUserId: string };
let orgId: number;

async function addAsset(name: string, values: Partial<typeof assetsTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(assetsTable)
    .values({ organizationId: orgId, kind: "brand", name, storageKey: `/objects/orgs/${orgId}/uploads/${name}`, contentType: "image/png", createdById: owner.id, ...values })
    .returning();
  return row;
}

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "x-test-auth-user": owner.authUserId, "x-organization-id": String(orgId), "content-type": "application/json" },
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
  runs.length = 0;
  llm.planner = { summary: "A poster", clarifyingQuestions: [], heroPhotoQuery: null, brandAssetQuery: null, suggestedFormat: null };
  llm.concepts = [];
  llm.photoIds = [];
  const org = await createOrganization({ name: "USA Archery", slug: "usa-archery" });
  orgId = org.id;
  owner = await createUser({ name: "Olivia Owner" });
  await addOrganizationMember(orgId, owner.id, "owner");
});

describe("plan required inputs (TT-VPX-FIDELITY-02)", () => {
  it("has none when the planner proposes no photo or logo", async () => {
    const plan = await planGeneration(orgId, "Abstract gradient", []);
    expect(plan.requiredInputs).toEqual([]);
  });

  it("marks a hero photo found when the library has a candidate", async () => {
    const album = await createAlbum(owner.id, "A", orgId);
    const photo = await createPhoto(album.id, owner.id, { organizationId: orgId });
    llm.photoIds = [photo.id];
    llm.planner.heroPhotoQuery = "archer celebrating";
    const plan = await planGeneration(orgId, "Win poster", []);
    expect(plan.requiredInputs).toEqual([{ role: "hero_photo", slot: "Hero photo", status: "found", message: "" }]);
  });

  it("marks a hero photo missing, with a fixed message, when nothing matches", async () => {
    llm.planner.heroPhotoQuery = "archer celebrating";
    const plan = await planGeneration(orgId, "Win poster", []);
    expect(plan.requiredInputs).toEqual([
      { role: "hero_photo", slot: "Hero photo", status: "missing", message: "This design calls for a photo, but no matching photo was found in your library." },
    ]);
  });

  it("marks the primary logo found when one is designated", async () => {
    await addAsset("USA Archery Logo", { isPrimary: true, variant: "primary" });
    llm.planner.brandAssetQuery = "primary logo";
    const plan = await planGeneration(orgId, "Poster with our logo", []);
    expect(plan.requiredInputs).toEqual([{ role: "exact_asset", slot: "Primary logo", status: "found", message: "" }]);
  });

  it("marks the primary logo missing when none is marked in Assets", async () => {
    llm.planner.brandAssetQuery = "primary logo";
    const plan = await planGeneration(orgId, "Poster with our logo", []);
    expect(plan.requiredInputs).toEqual([
      { role: "exact_asset", slot: "Primary logo", status: "missing", message: "This design asks for your primary logo, but none is marked in Assets." },
    ]);
  });

  it("marks a logo ambiguous when only low-confidence candidates exist", async () => {
    await addAsset("Apparel Team Shirt");
    llm.planner.brandAssetQuery = "gator cup logo";
    const plan = await planGeneration(orgId, "Gator Cup poster", []);
    expect(plan.requiredInputs).toHaveLength(1);
    expect(plan.requiredInputs[0]).toMatchObject({ role: "exact_asset", slot: "Logo", status: "ambiguous" });
    expect(plan.requiredInputs[0].message).toMatch(/none is a confident match/);
  });

  it("requires a logo the request names even when the planner proposed no query", async () => {
    const plan = await planGeneration(orgId, "Poster with our logo in the corner", []);
    expect(plan.requiredInputs.map((r) => [r.role, r.status])).toEqual([["exact_asset", "missing"]]);
    // ...unless the person already attached something that is the logo.
    const attached = await planGeneration(orgId, "Poster with our logo in the corner", ["logo.png"]);
    expect(attached.requiredInputs).toEqual([]);
  });
});

describe("generate acknowledgedMissing (TT-VPX-FIDELITY-02)", () => {
  const base = { prompt: "Poster", variantCount: 1, inputs: [] };

  it("rejects an unknown role", async () => {
    const res = await post("/image-generation/generate", { ...base, acknowledgedMissing: ["style"] });
    expect(res.status).toBe(400);
    expect((await post("/image-generation/generate", { ...base, acknowledgedMissing: "exact_asset" })).status).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("passes valid roles on to the generation, de-duplicated", async () => {
    const res = await post("/image-generation/generate", { ...base, acknowledgedMissing: ["exact_asset", "hero_photo", "exact_asset"] });
    expect(res.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0].acknowledgedMissing?.slice().sort()).toEqual(["exact_asset", "hero_photo"]);
  });

  it("passes nothing acknowledged when the field is omitted", async () => {
    expect((await post("/image-generation/generate", base)).status).toBe(200);
    expect(runs[0].acknowledgedMissing ?? []).toEqual([]);
  });
});

describe("generate requiredInputs enforcement (server-side 409)", () => {
  const base = { prompt: "Poster", variantCount: 1, inputs: [] as unknown[] };
  const missingLogo = { role: "exact_asset", slot: "Primary logo", status: "missing", message: "No logo." };
  const foundPhoto = { role: "hero_photo", slot: "Hero photo", status: "found", message: "" };

  it("refuses with 409 input_required when missing and unacknowledged", async () => {
    const res = await post("/image-generation/generate", { ...base, requiredInputs: [foundPhoto, missingLogo] });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { code: string; error: string; missing: unknown[] };
    expect(data.code).toBe("input_required");
    expect(data.error).toBe("A required input is missing");
    expect(data.missing).toEqual([missingLogo]);
    expect(runs).toHaveLength(0);
  });

  it("also refuses an ambiguous entry", async () => {
    const res = await post("/image-generation/generate", { ...base, requiredInputs: [{ ...missingLogo, status: "ambiguous" }] });
    expect(res.status).toBe(409);
    expect(runs).toHaveLength(0);
  });

  it("allows it when the role is acknowledged", async () => {
    const res = await post("/image-generation/generate", { ...base, requiredInputs: [missingLogo], acknowledgedMissing: ["exact_asset"] });
    expect(res.status).toBe(200);
    expect(runs).toHaveLength(1);
  });

  it("allows it when an input of that role is attached", async () => {
    const res = await post("/image-generation/generate", {
      ...base,
      inputs: [{ kind: "asset", refId: 1, role: "exact_asset" }],
      requiredInputs: [missingLogo],
    });
    expect(res.status).toBe(200);
    expect(runs).toHaveLength(1);
  });

  it("behaves as before when requiredInputs is omitted", async () => {
    expect((await post("/image-generation/generate", base)).status).toBe(200);
  });

  it("rejects malformed requiredInputs with 400", async () => {
    for (const bad of [
      "nope",
      [{ ...missingLogo, role: "style" }],
      [{ ...missingLogo, status: "weird" }],
      [{ ...missingLogo, slot: "x".repeat(500) }],
      [missingLogo, missingLogo, missingLogo, missingLogo, missingLogo],
    ]) {
      expect((await post("/image-generation/generate", { ...base, requiredInputs: bad })).status).toBe(400);
    }
    expect(runs).toHaveLength(0);
  });
});

describe("campaign concepts with required inputs (TT-VPX-FIDELITY-03)", () => {
  async function campaign() {
    const [row] = await db.insert(campaignsTable).values({ organizationId: orgId, createdById: owner.id, name: "Spring Open", brief: "Brief" }).returning();
    return row;
  }

  it("returns needs_input and renders nothing for a concept whose logo can't be grounded", async () => {
    llm.concepts = [
      { title: "Hero", prompt: "Archer", format: "1:1", heroPhotoQuery: null, useLogo: true },
      { title: "Plain", prompt: "Gradient", format: "1:1", heroPhotoQuery: null, useLogo: false },
    ];
    const result = await generateCampaignSuggestions(await campaign(), owner.id, 3);
    expect(result.concepts.map((c) => [c.title, c.status])).toEqual([["Hero", "needs_input"], ["Plain", "generated"]]);
    expect(result.concepts[0].missing).toEqual([
      expect.objectContaining({ role: "exact_asset", status: "missing", message: "This design asks for your primary logo, but none is marked in Assets." }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].inputs).toEqual([]);
  });

  it("returns needs_input for a concept whose hero photo isn't in the library", async () => {
    llm.concepts = [{ title: "Hero", prompt: "Archer", format: "1:1", heroPhotoQuery: "archer at full draw", useLogo: false }];
    const result = await generateCampaignSuggestions(await campaign(), owner.id, 3);
    expect(result.concepts[0]).toMatchObject({ status: "needs_input", missing: [expect.objectContaining({ role: "hero_photo", status: "missing" })] });
    expect(runs).toHaveLength(0);
  });

  it("generates a grounded concept", async () => {
    const album = await createAlbum(owner.id, "A", orgId);
    const photo = await createPhoto(album.id, owner.id, { organizationId: orgId });
    llm.photoIds = [photo.id];
    llm.concepts = [{ title: "Hero", prompt: "Archer", format: "1:1", heroPhotoQuery: "archer", useLogo: false }];
    const result = await generateCampaignSuggestions(await campaign(), owner.id, 3);
    expect(result.concepts[0]).toMatchObject({ status: "generated" });
    expect(runs[0].inputs.map((i) => [i.kind, i.refId, i.role])).toEqual([["photo", photo.id, "hero_photo"]]);
  });

  it("generates an acknowledged concept without the missing input and records the acknowledgement", async () => {
    const concept = { title: "Hero", prompt: "Archer", format: "1:1", heroPhotoQuery: null, useLogo: true };
    const result = await generateCampaignConcept(await campaign(), owner.id, concept, ["exact_asset"]);
    expect(result.concepts[0]).toMatchObject({ title: "Hero", status: "generated" });
    expect(runs).toHaveLength(1);
    expect(runs[0].inputs).toEqual([]);
    expect(runs[0].acknowledgedMissing).toEqual(["exact_asset"]);
  });

  it("still needs input when the acknowledgement doesn't cover the missing role", async () => {
    const concept = { title: "Hero", prompt: "Archer", format: "1:1", heroPhotoQuery: "archer", useLogo: true };
    const result = await generateCampaignConcept(await campaign(), owner.id, concept, ["hero_photo"]);
    expect(result.concepts[0].status).toBe("needs_input");
    expect(result.concepts[0].missing?.map((m) => m.role)).toEqual(["exact_asset"]);
    expect(runs).toHaveLength(0);
  });

  it("serves the continue path over HTTP, validating the roles", async () => {
    const c = await campaign();
    const concept = { title: "Hero", prompt: "Archer", format: "1:1", heroPhotoQuery: null, useLogo: true };
    expect((await post(`/campaigns/${c.id}/generate-concept`, { concept, acknowledgedMissing: ["bogus"] })).status).toBe(400);
    const ok = await post(`/campaigns/${c.id}/generate-concept`, { concept, acknowledgedMissing: ["exact_asset"] });
    expect(ok.status).toBe(200);
    expect(runs[0].acknowledgedMissing).toEqual(["exact_asset"]);
  });

  it("renders an unsupported concept format on the nearest canvas and passes the requested one", async () => {
    llm.concepts = [
      { title: "Wide", prompt: "Banner", format: "16:9", heroPhotoQuery: null, useLogo: false },
      { title: "Tall", prompt: "Story", format: "9:16", heroPhotoQuery: null, useLogo: false },
      { title: "Square", prompt: "Post", format: "1:1", heroPhotoQuery: null, useLogo: false },
    ];
    await generateCampaignSuggestions(await campaign(), owner.id, 3);
    expect(runs.map((r) => [r.format, r.requestedFormat])).toEqual([["3:2", "16:9"], ["2:3", "9:16"], ["1:1", "1:1"]]);
  });
});
