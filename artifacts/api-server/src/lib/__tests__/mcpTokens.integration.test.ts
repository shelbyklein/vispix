import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { createMcpToken, deleteMcpToken, isMcpTokenLive, verifyMcpToken } from "../mcpTokens";
import { resetDb, createOrganization } from "./testDb";

// The MCP gateway's media grants (#204) carry the minting token's id + the
// first 16 hex of its SHA-256; isMcpTokenLive is the per-fetch revocation check.
function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

describe("isMcpTokenLive (media-grant parent revocation)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("is live only for the same token id, org, and credential fingerprint", async () => {
    const orgA = await createOrganization();
    const orgB = await createOrganization();
    const { token, item } = await createMcpToken("connector", orgA.id, null);
    const other = await createMcpToken("other", orgB.id, null);

    expect(await verifyMcpToken(token, Date.now())).toEqual({ id: item.id, organizationId: orgA.id });
    expect(await isMcpTokenLive(item.id, orgA.id, fingerprint(token))).toBe(true);
    // Wrong org, wrong credential for this id, unknown id.
    expect(await isMcpTokenLive(item.id, orgB.id, fingerprint(token))).toBe(false);
    expect(await isMcpTokenLive(item.id, orgA.id, fingerprint(other.token))).toBe(false);
    expect(await isMcpTokenLive(item.id + 1000, orgA.id, fingerprint(token))).toBe(false);
  });

  it("stops being live as soon as the token is revoked", async () => {
    const org = await createOrganization();
    const { token, item } = await createMcpToken("connector", org.id, null);
    expect(await isMcpTokenLive(item.id, org.id, fingerprint(token))).toBe(true);
    expect(await deleteMcpToken(item.id, org.id)).toBe(true);
    expect(await isMcpTokenLive(item.id, org.id, fingerprint(token))).toBe(false);
  });
});
