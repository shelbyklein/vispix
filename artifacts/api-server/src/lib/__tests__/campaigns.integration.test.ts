import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Campaign brief/generate ordering (#216). Better Auth is mocked so a request
// authenticates as the user whose authUserId it sends (as in the org isolation
// suite), and the suggestion generator is mocked so no AI provider is called:
// the tests only observe WHICH brief generation was started from, and how often.
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

interface PlannerCall {
  brief: string;
  briefRevision: number | undefined;
  requestId: string | undefined;
}
const plannerCalls: PlannerCall[] = [];
let plannerGate: Promise<void> | null = null;
let plannerFailure: Error | null = null;

vi.mock("../imageGeneration/campaignSuggestions", () => ({
  generateCampaignSuggestions: async (
    campaign: { brief: string; briefRevision?: number },
    _userId: number,
    _count: number,
    context?: { requestId?: string },
  ) => {
    plannerCalls.push({ brief: campaign.brief, briefRevision: campaign.briefRevision, requestId: context?.requestId });
    if (plannerGate) await plannerGate;
    if (plannerFailure) throw plannerFailure;
    return { sessionId: 1, generations: [], concepts: [{ title: "Concept" }] };
  },
}));

import type { Server } from "node:http";
import app from "../../app";
import { pool } from "@workspace/db";
import { resetDb, createUser, createOrganization, addOrganizationMember } from "./testDb";

let server: Server;
let baseUrl: string;

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

let user: { authUserId: string };
let orgId: number;

async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "x-test-auth-user": user.authUserId, "x-organization-id": String(orgId) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function createCampaign(brief = "Original brief: spring open, March 3"): Promise<{ id: number; brief: string }> {
  const res = await api("/api/campaigns", "POST", { name: "Spring Open", brief });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: number; brief: string };
}

beforeEach(async () => {
  await resetDb();
  plannerCalls.length = 0;
  plannerGate = null;
  plannerFailure = null;
  const org = await createOrganization({ name: "Campaign Org", slug: "campaign-org" });
  const u = await createUser({ name: "Casey" });
  await addOrganizationMember(org.id, u.id, "owner");
  user = u;
  orgId = org.id;
});

describe("reproduction: the pre-#216 client sequence (TT-VPX-BRIEF-01)", () => {
  it("starts generation from the OLD brief when generate reaches the server before the delayed save", async () => {
    const campaign = await createCampaign();
    // The old page fired PATCH and POST /generate back to back without waiting;
    // when the PATCH is slower (network, DB), generate reads the stale brief.
    const generate = api(`/api/campaigns/${campaign.id}/generate`, "POST");
    await generate;
    const save = await api(`/api/campaigns/${campaign.id}`, "PATCH", { brief: "Edited brief: spring open moved to March 10" });
    expect(save.status).toBe(200);
    expect(plannerCalls.map((c) => c.brief)).toEqual(["Original brief: spring open, March 3"]);
  });

  it("still starts generation when the save fails", async () => {
    const campaign = await createCampaign();
    // An invalid (blank) brief fails the PATCH, but the old page called
    // generate regardless.
    const save = await api(`/api/campaigns/${campaign.id}`, "PATCH", { brief: "   " });
    expect(save.status).toBe(400);
    const generate = await api(`/api/campaigns/${campaign.id}/generate`, "POST");
    expect(generate.status).toBe(200);
    expect(plannerCalls).toHaveLength(1);
  });

  it("starts duplicate generations for a double click", async () => {
    const campaign = await createCampaign();
    const [a, b] = await Promise.all([
      api(`/api/campaigns/${campaign.id}/generate`, "POST"),
      api(`/api/campaigns/${campaign.id}/generate`, "POST"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(plannerCalls).toHaveLength(2);
  });
});

type CampaignJson = { id: number; brief: string; briefRevision: number };

describe("atomic save-and-generate (TT-VPX-BRIEF-02)", () => {
  it("saves the on-screen brief before generation starts and generates from it", async () => {
    const campaign = (await createCampaign()) as CampaignJson;
    expect(campaign.briefRevision).toBe(1);
    const res = await api(`/api/campaigns/${campaign.id}/generate`, "POST", {
      brief: "  Edited brief: spring open moved to March 10  ",
      expectedRevision: 1,
      requestId: "req-atomic-0001",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brief: string; briefRevision: number };
    expect(body).toMatchObject({ brief: "Edited brief: spring open moved to March 10", briefRevision: 2 });
    expect(plannerCalls).toEqual([{ brief: "Edited brief: spring open moved to March 10", briefRevision: 2, requestId: "req-atomic-0001" }]);
    const stored = (await (await api(`/api/campaigns/${campaign.id}`)).json()) as CampaignJson;
    expect(stored).toMatchObject({ brief: "Edited brief: spring open moved to March 10", briefRevision: 2 });
  });

  it("keeps the same revision when the brief is unchanged", async () => {
    const campaign = (await createCampaign()) as CampaignJson;
    const res = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: campaign.brief, expectedRevision: 1, requestId: "req-same-0001" });
    expect(res.status).toBe(200);
    expect(plannerCalls[0]).toMatchObject({ brief: campaign.brief, briefRevision: 1 });
  });

  it("starts no generation when the save is invalid, and leaves the stored brief alone", async () => {
    const campaign = await createCampaign();
    const res = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "   ", expectedRevision: 1, requestId: "req-blank-0001" });
    expect(res.status).toBe(400);
    expect(plannerCalls).toHaveLength(0);
    const stored = (await (await api(`/api/campaigns/${campaign.id}`)).json()) as CampaignJson;
    expect(stored).toMatchObject({ brief: campaign.brief, briefRevision: 1 });
  });

  it("does not return before the save lands: a slow generation still sees the saved brief", async () => {
    const campaign = await createCampaign();
    let release!: () => void;
    plannerGate = new Promise<void>((r) => (release = r));
    const pending = api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "Brief v2", expectedRevision: 1, requestId: "req-slow-0001" });
    await vi.waitFor(() => expect(plannerCalls).toHaveLength(1));
    // While generation is still running, the brief is already persisted.
    const mid = (await (await api(`/api/campaigns/${campaign.id}`)).json()) as CampaignJson;
    expect(mid).toMatchObject({ brief: "Brief v2", briefRevision: 2 });
    release();
    expect((await pending).status).toBe(200);
  });
});

describe("revision and duplicate safeguards (TT-VPX-BRIEF-03)", () => {
  it("refuses to generate from a stale revision and reports the newer brief", async () => {
    const campaign = await createCampaign();
    // Another tab saves first.
    const other = await api(`/api/campaigns/${campaign.id}`, "PATCH", { brief: "Other tab's brief", expectedRevision: 1 });
    expect(other.status).toBe(200);
    // This tab still thinks it edited revision 1.
    const res = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "My brief", expectedRevision: 1, requestId: "req-stale-0001" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflict: true, brief: "Other tab's brief", briefRevision: 2 });
    expect(plannerCalls).toHaveLength(0);
    const stored = (await (await api(`/api/campaigns/${campaign.id}`)).json()) as CampaignJson;
    expect(stored.brief).toBe("Other tab's brief");
  });

  it("refuses a stale PATCH instead of overwriting another tab's brief", async () => {
    const campaign = await createCampaign();
    expect((await api(`/api/campaigns/${campaign.id}`, "PATCH", { brief: "Tab A", expectedRevision: 1 })).status).toBe(200);
    const res = await api(`/api/campaigns/${campaign.id}`, "PATCH", { brief: "Tab B", expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflict: true, brief: "Tab A", briefRevision: 2 });
    // Explicitly submitting against the latest revision is allowed.
    const ok = await api(`/api/campaigns/${campaign.id}`, "PATCH", { brief: "Tab B", expectedRevision: 2 });
    expect(await ok.json()).toMatchObject({ brief: "Tab B", briefRevision: 3 });
  });

  it("starts one generation for a double click of the same request", async () => {
    const campaign = await createCampaign();
    const body = { brief: "Brief v2", expectedRevision: 1, requestId: "req-double-0001" };
    const [a, b] = await Promise.all([
      api(`/api/campaigns/${campaign.id}/generate`, "POST", body),
      api(`/api/campaigns/${campaign.id}/generate`, "POST", body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [(await a.json()) as { duplicate?: boolean }, (await b.json()) as { duplicate?: boolean }];
    expect(bodies.filter((x) => x.duplicate)).toHaveLength(1);
    expect(plannerCalls).toHaveLength(1);
  });

  it("starts one generation for a double click when the brief is unchanged (same revision)", async () => {
    const campaign = await createCampaign();
    // No brief change → the revision stays 1, so only the request-id claim can
    // tell the second click apart.
    const body = { brief: campaign.brief, expectedRevision: 1, requestId: "req-double-same" };
    const [a, b] = await Promise.all([
      api(`/api/campaigns/${campaign.id}/generate`, "POST", body),
      api(`/api/campaigns/${campaign.id}/generate`, "POST", body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(plannerCalls).toHaveLength(1);
    const retry = await api(`/api/campaigns/${campaign.id}/generate`, "POST", body);
    expect(await retry.json()).toMatchObject({ duplicate: true, briefRevision: 1 });
    expect(plannerCalls).toHaveLength(1);
  });

  it("does not repeat an accepted request on retry, but a new request generates again", async () => {
    const campaign = await createCampaign();
    const first = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "Brief v2", expectedRevision: 1, requestId: "req-retry-0001" });
    expect(first.status).toBe(200);
    const retry = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "Brief v2", expectedRevision: 1, requestId: "req-retry-0001" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ duplicate: true, briefRevision: 2 });
    expect(plannerCalls).toHaveLength(1);
    const again = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "Brief v2", expectedRevision: 2, requestId: "req-retry-0002" });
    expect(again.status).toBe(200);
    expect(plannerCalls).toHaveLength(2);
  });

  it("lets a failed request be retried with the same id", async () => {
    const campaign = await createCampaign();
    plannerFailure = Object.assign(new Error("No OpenAI API key configured"), { statusCode: 400 });
    const failed = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "Brief v2", expectedRevision: 1, requestId: "req-fail-0001" });
    expect(failed.status).toBe(400);
    plannerFailure = null;
    // The brief save stands (revision 2); the same request id is free again.
    const retry = await api(`/api/campaigns/${campaign.id}/generate`, "POST", { brief: "Brief v2", expectedRevision: 2, requestId: "req-fail-0001" });
    expect(retry.status).toBe(200);
    expect(plannerCalls).toHaveLength(2);
  });

  it("keeps campaigns org-scoped for save and generate", async () => {
    const campaign = await createCampaign();
    const otherOrg = await createOrganization({ name: "Other", slug: "other-org" });
    const outsider = await createUser({ name: "Olive" });
    await addOrganizationMember(otherOrg.id, outsider.id, "owner");
    const res = await fetch(`${baseUrl}/api/campaigns/${campaign.id}/generate`, {
      method: "POST",
      headers: { "x-test-auth-user": outsider.authUserId, "x-organization-id": String(otherOrg.id), "content-type": "application/json" },
      body: JSON.stringify({ brief: "Hijack", expectedRevision: 1, requestId: "req-outsider-01" }),
    });
    expect(res.status).toBe(404);
    expect(plannerCalls).toHaveLength(0);
  });
});
