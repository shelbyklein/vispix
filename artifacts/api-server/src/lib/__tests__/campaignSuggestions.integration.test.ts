import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Campaign suggestions record which brief revision they came from (#216). The
// real generateCampaignSuggestions + runGeneration run against the test DB; only
// the provider boundary is stubbed: concept planning returns two fixed
// concepts, and the image call never settles, so rows stay "pending" and no
// provider is contacted.
vi.mock("openai", () => {
  class OpenAI {
    chat = {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  concepts: [
                    { title: "Hero", prompt: "Archer at full draw", format: "1:1", heroPhotoQuery: null, useLogo: false },
                    { title: "Banner", prompt: "Event banner", format: "3:2", heroPhotoQuery: null, useLogo: false },
                  ],
                }),
              },
            },
          ],
        }),
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

import { eq } from "drizzle-orm";
import { db, pool, campaignsTable, imageGenerationsTable } from "@workspace/db";
import { generateCampaignSuggestions } from "../imageGeneration/campaignSuggestions";
import { resetDb, createUser, createOrganization } from "./testDb";

describe("campaign suggestion provenance (TT-VPX-BRIEF-04)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("stores the campaign, brief revision and request id on every generation row", async () => {
    const org = await createOrganization();
    const user = await createUser();
    const [campaign] = await db
      .insert(campaignsTable)
      .values({ organizationId: org.id, createdById: user.id, name: "Spring Open", brief: "Brief v3", briefRevision: 3 })
      .returning();

    const result = await generateCampaignSuggestions(campaign, user.id, 3, { requestId: "req-provenance-01" });
    expect(result.generations).toHaveLength(2);

    const rows = await db.select().from(imageGenerationsTable).where(eq(imageGenerationsTable.sessionId, result.sessionId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.settings).toMatchObject({
        campaignId: campaign.id,
        campaignBriefRevision: 3,
        campaignRequestId: "req-provenance-01",
        variantCount: 1,
      });
    }
    // Core settings still win over provenance extras.
    expect(rows.map((r) => (r.settings as { format: string }).format).sort()).toEqual(["1:1", "3:2"]);
  });
});
