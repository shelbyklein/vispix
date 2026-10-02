import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, organizationMembersTable, usersTable } from "@workspace/db";
import { createMcpToken, deleteMcpToken, isMcpTokenLive, verifyMcpToken } from "../mcpTokens";
import { resetDb, createOrganization, createUser, addOrganizationMember } from "./testDb";

// The MCP gateway's media grants (#204) carry the minting token's id + the
// first 16 hex of its SHA-256; isMcpTokenLive is the per-fetch revocation check.
function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

afterAll(async () => {
  await pool.end();
});

describe("isMcpTokenLive (media-grant parent revocation)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is live only for the same token id, org, and credential fingerprint", async () => {
    const orgA = await createOrganization();
    const orgB = await createOrganization();
    const creatorA = await createUser();
    const creatorB = await createUser();
    await addOrganizationMember(orgA.id, creatorA.id);
    await addOrganizationMember(orgB.id, creatorB.id);
    const { token, item } = await createMcpToken("connector", orgA.id, creatorA.id);
    const other = await createMcpToken("other", orgB.id, creatorB.id);

    expect(await verifyMcpToken(token, Date.now())).toEqual({ id: item.id, organizationId: orgA.id });
    expect(await isMcpTokenLive(item.id, orgA.id, fingerprint(token))).toBe(true);
    // Wrong org, wrong credential for this id, unknown id.
    expect(await isMcpTokenLive(item.id, orgB.id, fingerprint(token))).toBe(false);
    expect(await isMcpTokenLive(item.id, orgA.id, fingerprint(other.token))).toBe(false);
    expect(await isMcpTokenLive(item.id + 1000, orgA.id, fingerprint(token))).toBe(false);
  });

  it("stops being live as soon as the token is revoked", async () => {
    const org = await createOrganization();
    const creator = await createUser();
    await addOrganizationMember(org.id, creator.id);
    const { token, item } = await createMcpToken("connector", org.id, creator.id);
    expect(await isMcpTokenLive(item.id, org.id, fingerprint(token))).toBe(true);
    expect(await deleteMcpToken(item.id, org.id)).toBe(true);
    expect(await isMcpTokenLive(item.id, org.id, fingerprint(token))).toBe(false);
  });
});

describe("MCP tokens follow their creator's org membership", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is rejected once the creator is removed from the org", async () => {
    const org = await createOrganization();
    const creator = await createUser();
    await addOrganizationMember(org.id, creator.id);
    const { token, item } = await createMcpToken("connector", org.id, creator.id);
    expect(await verifyMcpToken(token, Date.now())).toEqual({ id: item.id, organizationId: org.id });

    await db.delete(organizationMembersTable).where(eq(organizationMembersTable.userId, creator.id));
    expect(await verifyMcpToken(token, Date.now())).toBeNull();
    expect(await isMcpTokenLive(item.id, org.id, fingerprint(token))).toBe(false);
  });

  it("is rejected once the creator user is deleted", async () => {
    const org = await createOrganization();
    const creator = await createUser();
    await addOrganizationMember(org.id, creator.id);
    const { token, item } = await createMcpToken("connector", org.id, creator.id);
    expect(await verifyMcpToken(token, Date.now())).not.toBeNull();

    await db.delete(usersTable).where(eq(usersTable.id, creator.id));
    expect(await verifyMcpToken(token, Date.now())).toBeNull();
    expect(await isMcpTokenLive(item.id, org.id, fingerprint(token))).toBe(false);
  });

  it("only rejects the removed creator's tokens", async () => {
    const org = await createOrganization();
    const a = await createUser();
    const b = await createUser();
    await addOrganizationMember(org.id, a.id);
    await addOrganizationMember(org.id, b.id);
    const tokA = await createMcpToken("a", org.id, a.id);
    const tokB = await createMcpToken("b", org.id, b.id);
    await db.delete(organizationMembersTable).where(eq(organizationMembersTable.userId, a.id));
    expect(await verifyMcpToken(tokA.token, Date.now())).toBeNull();
    expect(await verifyMcpToken(tokB.token, Date.now())).toEqual({ id: tokB.item.id, organizationId: org.id });
  });
});
