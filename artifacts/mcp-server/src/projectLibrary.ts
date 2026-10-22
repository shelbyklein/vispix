// Project reads share the connector's org boundary and never expose hidden photos.
import { createHash } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { db, projectsTable, projectPhotosTable, photosTable } from "@workspace/db";
import { buildSummaries, resolveLocalOrganizationId } from "./photoLibrary.js";
import { McpToolError } from "./structured.js";

export const MAX_PROJECT_PAGE = 200;

async function scope(organizationId?: number): Promise<number> {
  const id = organizationId ?? await resolveLocalOrganizationId();
  if (id == null) throw new McpToolError("invalid_scope", "Projects need an organization: set VISPIX_MCP_ORGANIZATION_ID for the local server.");
  return id;
}

// Keyset cursors are bound to the operation, organization, project and filters.
function cursorHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function decodeCursor(raw: string | undefined, hash: string): number | undefined {
  if (!raw) return undefined;
  let c;
  try { c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch {
    throw new McpToolError("invalid_cursor", "Malformed project cursor; restart the listing.");
  }
  if (c?.v !== 1 || typeof c.h !== "string" || !Number.isSafeInteger(c.id) || c.id < 1) {
    throw new McpToolError("invalid_cursor", "Malformed project cursor; restart the listing.");
  }
  if (c.h !== hash) throw new McpToolError("cursor_mismatch", "This cursor belongs to a different project listing or organization; restart the listing.");
  return c.id;
}

function page(returned: number, more: boolean, hash: string, lastId?: number) {
  return {
    returned,
    nextCursor: more && lastId != null ? Buffer.from(JSON.stringify({ v: 1, h: hash, id: lastId })).toString("base64url") : null,
    exhausted: !more, limited: false, total: null,
  };
}

function summary(p: typeof projectsTable.$inferSelect, photoCount: number) {
  return { id: p.id, name: p.name, description: p.description, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), photoCount };
}

export async function listProjects(options: { organizationId?: number; name?: string; limit: number; cursor?: string }) {
  const orgId = await scope(options.organizationId);
  const name = options.name?.trim().toLowerCase() || null;
  const hash = cursorHash(["projects", orgId, name]);
  const after = decodeCursor(options.cursor, hash);
  const rows = await db.select({ project: projectsTable, photoCount: count(photosTable.id) })
    .from(projectsTable)
    .leftJoin(projectPhotosTable, eq(projectPhotosTable.projectId, projectsTable.id))
    .leftJoin(photosTable, and(eq(photosTable.id, projectPhotosTable.photoId), eq(photosTable.organizationId, orgId), eq(photosTable.isHidden, false)))
    .where(and(eq(projectsTable.organizationId, orgId), name ? sql`lower(${projectsTable.name}) = ${name}` : undefined, after ? sql`${projectsTable.id} > ${after}` : undefined))
    .groupBy(projectsTable.id).orderBy(asc(projectsTable.id)).limit(options.limit + 1);
  const selected = rows.slice(0, options.limit);
  return { items: selected.map(r => summary(r.project, Number(r.photoCount))), page: page(selected.length, rows.length > options.limit, hash, selected.at(-1)?.project.id) };
}

export async function getProject(options: { id: number; organizationId?: number; limit: number; cursor?: string }) {
  const orgId = await scope(options.organizationId);
  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, options.id), eq(projectsTable.organizationId, orgId)));
  if (!project) throw new McpToolError("not_found", `Project #${options.id} not found.`);
  const hash = cursorHash(["project-photos", orgId, options.id]);
  const after = decodeCursor(options.cursor, hash);
  const visible = and(eq(projectPhotosTable.projectId, options.id), eq(photosTable.organizationId, orgId), eq(photosTable.isHidden, false));
  const [totals, rows] = await Promise.all([
    db.select({ total: count() }).from(projectPhotosTable).innerJoin(photosTable, eq(photosTable.id, projectPhotosTable.photoId)).where(visible),
    db.select({ id: photosTable.id }).from(projectPhotosTable).innerJoin(photosTable, eq(photosTable.id, projectPhotosTable.photoId))
      .where(and(visible, after ? sql`${photosTable.id} > ${after}` : undefined)).orderBy(asc(photosTable.id)).limit(options.limit + 1),
  ]);
  const ids = rows.slice(0, options.limit).map(r => r.id);
  const photos = await buildSummaries(ids);
  return { project: summary(project, Number(totals[0].total)), photos, page: { ...page(photos.length, rows.length > options.limit, hash, ids.at(-1)), total: Number(totals[0].total) } };
}
