import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Persisted needs_input concepts (#215 polish): the concepts a Generate run held
// back for a missing logo/photo survive a reload because the server stores them
// on the campaign. Real routes + generator run against the test DB; only auth
// and the provider boundary (concept planner, image call) are stubbed.
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

let planned: unknown[] = [];
vi.mock("openai", () => {
  class OpenAI {
    chat = {
      completions: {
        create: async () => ({ choices: [{ message: { content: JSON.stringify({ concepts: planned }) } }] }),
      },
    };
    responses = { create: () => new Promise(() => {}) };
  }
  return { default: OpenAI };
});

vi.mock("../aiProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiProviders")>()),
  getOpenAIKeyForOrg: async () => ({ apiKey: "test-key", baseURL: null }),
}));

import type { Server } from "node:http";
import app from "../../app";
import { db, pool, campaignsTable } from "@workspace/db";
import { resetGenerationLimits } from "../imageGeneration/limits";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

let server: Server;
let baseUrl: string;
let user: { id: number; authUserId: string };
let orgId: number;
let campaignId: number;

const withLogo = (title: string) => ({ title, prompt: `${title} ad`, format: "1:1", heroPhotoQuery: null, useLogo: true });
const graphic = (title: string) => ({ title, prompt: `${title} ad`, format: "3:2", heroPhotoQuery: null, useLogo: false });

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
  resetGenerationLimits();
  const org = await createOrganization();
  user = (await createUser()) as typeof user;
  orgId = org.id;
  await addOrganizationMember(org.id, user.id, "owner");
  const [c] = await db
    .insert(campaignsTable)
    .values({ organizationId: orgId, createdById: user.id, name: "Spring Open", brief: "Brief" })
    .returning();
  campaignId = c.id;
});

async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "x-test-auth-user": user.authUserId, "x-organization-id": String(orgId) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

interface Held {
  title: string;
  missing: { role: string; message: string }[];
  resume: { prompt: string };
}

async function held(): Promise<Held[]> {
  const res = await api(`/api/campaigns/${campaignId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { needsInputConcepts: Held[] }).needsInputConcepts;
}

describe("campaign needs-input concepts persist server-side", () => {
  it("is empty before any run", async () => {
    expect(await held()).toEqual([]);
  });

  it("generate stores held concepts, and a fresh GET (reload) returns them", async () => {
    planned = [withLogo("Logo banner"), graphic("Plain poster")];
    const res = await api(`/api/campaigns/${campaignId}/generate`, "POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { concepts: { title: string; status: string }[] };
    expect(body.concepts.map((c) => c.status)).toEqual(["needs_input", "generated"]);

    const stored = await held();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Logo banner");
    expect(stored[0].missing[0].role).toBe("exact_asset");
    expect(stored[0].resume.prompt).toBe("Logo banner ad");
  });

  it("is replaced by the next generate run (and cleared when nothing is held)", async () => {
    planned = [withLogo("First"), withLogo("Second")];
    await api(`/api/campaigns/${campaignId}/generate`, "POST", {});
    expect((await held()).map((h) => h.title)).toEqual(["First", "Second"]);

    planned = [withLogo("Third")];
    await api(`/api/campaigns/${campaignId}/generate`, "POST", {});
    expect((await held()).map((h) => h.title)).toEqual(["Third"]);

    planned = [graphic("Only graphic")];
    await api(`/api/campaigns/${campaignId}/generate`, "POST", {});
    expect(await held()).toEqual([]);
  });

  it("generate-concept removes the entry once it is generated, keeping the others", async () => {
    planned = [withLogo("First"), withLogo("Second")];
    await api(`/api/campaigns/${campaignId}/generate`, "POST", {});
    const first = (await held())[0];

    const res = await api(`/api/campaigns/${campaignId}/generate-concept`, "POST", {
      concept: first.resume,
      acknowledgedMissing: ["exact_asset"],
    });
    expect(res.status).toBe(200);
    expect((await held()).map((h) => h.title)).toEqual(["Second"]);
  });

  it("generate-concept without acknowledging keeps the entry (still blocked), no duplicate", async () => {
    planned = [withLogo("First")];
    await api(`/api/campaigns/${campaignId}/generate`, "POST", {});
    const first = (await held())[0];
    const res = await api(`/api/campaigns/${campaignId}/generate-concept`, "POST", { concept: first.resume, acknowledgedMissing: [] });
    expect(res.status).toBe(200);
    expect((await held()).map((h) => h.title)).toEqual(["First"]);
  });
});
