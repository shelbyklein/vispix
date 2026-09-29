import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, pool, assetsTable } from "@workspace/db";
import {
  resetDb,
  createUser,
  createOrganization,
  createProject,
} from "@workspace/api-server/src/lib/__tests__/testDb";
import { listAssets } from "../assetLibrary";

// list_assets resolves its `project` argument by name (#228): a connector token
// for one org must never match, or list in its "Available" hint, another org's
// projects.
let orgA: number;
let orgB: number;

beforeEach(async () => {
  await resetDb();
  const user = await createUser();
  orgA = (await createOrganization({ name: "Org A" })).id;
  orgB = (await createOrganization({ name: "Org B" })).id;
  await createProject(user.id, "Spring Open", orgA);
  const secret = await createProject(user.id, "Secret Sponsor Launch", orgB);
  await db.insert(assetsTable).values({
    organizationId: orgB,
    projectId: secret.id,
    kind: "brand",
    name: "Sponsor Logo",
    storageKey: `/objects/orgs/${orgB}/uploads/sponsor`,
    contentType: "image/png",
    createdById: user.id,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("list_assets project lookup is tenant-scoped (#228)", () => {
  it("never lists another org's project names in the hint", async () => {
    const { assets, note } = await listAssets({ project: "Nonexistent", organizationId: orgA });
    expect(assets).toEqual([]);
    expect(note).toContain("Spring Open");
    expect(note).not.toContain("Secret Sponsor Launch");
  });

  it("does not match another org's project by name", async () => {
    const { assets, note } = await listAssets({ project: "secret sponsor launch", organizationId: orgA });
    expect(assets).toEqual([]);
    expect(note).toMatch(/No project named/);
    expect(note).not.toContain("Secret Sponsor Launch");
  });

  it("does not let a wildcard project name reach another org's projects", async () => {
    const { note } = await listAssets({ project: "%Sponsor%", organizationId: orgA });
    expect(note).toMatch(/No project named/);
    expect(note).not.toContain("Secret Sponsor Launch");
  });

  it("still resolves the caller's own projects", async () => {
    const { assets, note } = await listAssets({ project: "secret sponsor launch", organizationId: orgB });
    expect(note).toBeUndefined();
    expect(assets.map((a) => a.name)).toEqual(["Sponsor Logo"]);
    expect(assets[0].projectName).toBe("Secret Sponsor Launch");
  });
});
