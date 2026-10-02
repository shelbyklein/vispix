import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { getDefaultOrgId } from "../defaultOrg";
import { resetDb, createOrganization } from "./testDb";

describe("getDefaultOrgId", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("falls back to the lowest-id org when unpinned", async () => {
    const first = await createOrganization();
    await createOrganization();
    expect(await getDefaultOrgId({})).toBe(first.id);
  });

  it("returns null when there are no orgs and nothing is pinned", async () => {
    expect(await getDefaultOrgId({})).toBeNull();
  });

  it("pins by id, even when it is not the lowest-id org", async () => {
    await createOrganization();
    const second = await createOrganization();
    expect(await getDefaultOrgId({ DEFAULT_ORG_ID: String(second.id) })).toBe(second.id);
  });

  it("pins by slug", async () => {
    await createOrganization();
    const second = await createOrganization({ slug: "pinned-org" });
    expect(await getDefaultOrgId({ DEFAULT_ORG_SLUG: "pinned-org" })).toBe(second.id);
  });

  it("fails closed when the pin matches no org or is not an integer", async () => {
    await createOrganization();
    expect(await getDefaultOrgId({ DEFAULT_ORG_ID: "999999" })).toBeNull();
    expect(await getDefaultOrgId({ DEFAULT_ORG_SLUG: "nope" })).toBeNull();
    expect(await getDefaultOrgId({ DEFAULT_ORG_ID: "abc" })).toBeNull();
  });
});
