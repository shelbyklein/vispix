import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.hoisted(() => {
  process.env.GCS_ENDPOINT = "http://127.0.0.1:1";
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
});
vi.mock("../photoLibrary.js", async (original) => ({
  ...await original<typeof import("../photoLibrary.js")>(),
  loadThumbnailImage: async () => ({ base64: "AAAA", mimeType: "image/jpeg" }),
}));

import { db, pool, projectPhotosTable } from "@workspace/db";
import { resetDb, createOrganization, createUser, createAlbum, createPhoto, createProject, addPhotoToProject } from "@workspace/api-server/src/lib/__tests__/testDb";
import { createServer } from "../server";
import { getProjectOutput, listProjectsOutput } from "../structured";

let client: Client;
let projectId: number;
let foreignId: number;
let emptyId: number;
let visibleIds: number[];
const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
const get = async (args: Record<string, unknown>) => z.object(getProjectOutput).parse((await call("get_project", args)).structuredContent);
const list = async (args: Record<string, unknown> = {}) => z.object(listProjectsOutput).parse((await call("list_projects", args)).structuredContent);

beforeAll(async () => {
  await resetDb();
  const a = await createOrganization();
  const b = await createOrganization();
  const user = await createUser();
  const album = await createAlbum(user.id, "A", a.id);
  const otherAlbum = await createAlbum(user.id, "B", b.id);
  const project = await createProject(user.id, "Poster 100%_", a.id);
  projectId = project.id;
  foreignId = (await createProject(user.id, "Private B", b.id)).id;
  emptyId = (await createProject(user.id, "Empty", a.id)).id;
  visibleIds = [];
  for (let i = 0; i < 5; i++) {
    const photo = await createPhoto(album.id, user.id, { organizationId: a.id });
    visibleIds.push(photo.id);
    await addPhotoToProject(project.id, photo.id);
  }
  const hidden = await createPhoto(album.id, user.id, { organizationId: a.id, isHidden: true });
  const foreign = await createPhoto(otherAlbum.id, user.id, { organizationId: b.id });
  await addPhotoToProject(project.id, hidden.id);
  // Even inconsistent cross-org associations must not leak a photo or count.
  await db.insert(projectPhotosTable).values({ projectId, photoId: foreign.id });
  client = new Client({ name: "project-tests", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer({ organizationId: a.id }).connect(serverTransport), client.connect(clientTransport)]);
}, 60_000);
afterAll(async () => { await client?.close(); await pool.end(); });

describe("project MCP reads over the SDK and real Postgres", () => {
  it("lists only this org's projects, counting visible photos, and pages without overlap", async () => {
    const first = await list({ limit: 1 });
    expect(first.items).toMatchObject([{ id: projectId, photoCount: 5 }]);
    expect(first.page.exhausted).toBe(false);
    const second = await list({ limit: 1, cursor: first.page.nextCursor });
    expect(second.items).toMatchObject([{ id: emptyId, photoCount: 0 }]);
    expect(second.page).toMatchObject({ exhausted: true, nextCursor: null });
    expect((await list({ name: "poster 100%_" })).items.map(p => p.id)).toEqual([projectId]);
    expect((await list({ name: "%" })).items).toEqual([]);
  });

  it("pages every visible shortlisted photo and returns current rights", async () => {
    const ids: number[] = [];
    let cursor: string | undefined;
    do {
      const out = await get({ id: projectId, limit: 2, cursor });
      expect(out.project?.photoCount).toBe(5);
      expect(out.images.requested).toBe(false);
      expect(out.photos.every(p => p.rightsStatus === "not_recorded")).toBe(true);
      ids.push(...out.photos.map(p => p.id));
      cursor = out.page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(visibleIds);
    const empty = await get({ id: emptyId });
    expect(empty).toMatchObject({ status: "ok", photos: [], page: { total: 0, exhausted: true } });
  });

  it("makes foreign and nonexistent projects indistinguishable", async () => {
    for (const id of [foreignId, 2_000_000_000]) {
      const result = await call("get_project", { id });
      expect(result.isError).toBe(true);
      expect(z.object(getProjectOutput).parse(result.structuredContent)).toMatchObject({ status: "not_found", project: null, photos: [] });
    }
  });

  it("rejects malformed and mismatched cursors", async () => {
    expect((await list({ cursor: "broken" })).error?.code).toBe("invalid_cursor");
    const projects = await list({ limit: 1 });
    expect((await list({ name: "Empty", cursor: projects.page.nextCursor })).error?.code).toBe("cursor_mismatch");
    const photos = await get({ id: projectId, limit: 1 });
    expect((await get({ id: emptyId, cursor: photos.page.nextCursor })).error?.code).toBe("cursor_mismatch");
    expect((await get({ id: projectId, cursor: projects.page.nextCursor })).error?.code).toBe("cursor_mismatch");
  });

  it("keeps inline images optional and bounded", async () => {
    const result = await call("get_project", { id: projectId, includeImages: true, maxImages: 2 });
    expect(result.content.filter(c => c.type === "image")).toHaveLength(2);
    expect(z.object(getProjectOutput).parse(result.structuredContent).images).toMatchObject({ included: 2, omitted: 3 });
  });
});
