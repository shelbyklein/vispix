// Data access for the asset-library MCP tools. Assets (brand marks and
// reference works) have no thumbnails or embeddings — retrieval is by
// kind/name/variant/project, and files are served straight from storage.
import { createHash } from "node:crypto";
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db, assetsTable, projectsTable } from "@workspace/db";
import { signObjectURL } from "@workspace/api-server/src/lib/objectStorage";
import { resolveObjectFile } from "./photoLibrary.js";
import { keyBelongsToOrg } from "@workspace/api-server/src/lib/storageKeys";
import { McpToolError, SIGNED_URL_TTL_MS } from "./structured.js";

export interface AssetSummary {
  id: number;
  kind: "brand" | "reference";
  name: string;
  variant: string | null;
  notes: string | null;
  projectName: string | null;
  storageKey: string;
  contentType: string;
  filename: string | null;
  fileSize: number | null;
  /** The designated primary logo for its scope (#206). */
  isPrimary: boolean;
}

function toSummary(row: { asset: typeof assetsTable.$inferSelect; projectName: string | null }): AssetSummary {
  return {
    id: row.asset.id,
    kind: row.asset.kind,
    name: row.asset.name,
    variant: row.asset.variant,
    notes: row.asset.notes,
    projectName: row.projectName,
    storageKey: row.asset.storageKey,
    contentType: row.asset.contentType,
    filename: row.asset.filename,
    fileSize: row.asset.fileSize,
    isPrimary: row.asset.isPrimary,
  };
}

export const MAX_ASSET_PAGE = 200;

interface AssetCursor {
  v: 1;
  /** Hash of the filters + scope the cursor was issued for. */
  h: string;
  k: [string, string, number];
}

function encodeAssetCursor(c: AssetCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeAssetCursor(raw: string, hash: string): AssetCursor {
  let c: AssetCursor;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as AssetCursor;
  } catch {
    throw new McpToolError("invalid_cursor", "The continuation cursor is malformed; restart the listing.");
  }
  const ok =
    c?.v === 1 &&
    typeof c.h === "string" &&
    Array.isArray(c.k) &&
    c.k.length === 3 &&
    (c.k[0] === "brand" || c.k[0] === "reference") &&
    typeof c.k[1] === "string" &&
    Number.isSafeInteger(c.k[2]);
  if (!ok) throw new McpToolError("invalid_cursor", "The continuation cursor is malformed; restart the listing.");
  if (c.h !== hash) {
    throw new McpToolError("cursor_mismatch", "The cursor belongs to a different listing or filter set; restart from the first page.");
  }
  return c;
}

export async function listAssets(options: {
  kind?: "brand" | "reference";
  project?: string;
  organizationId?: number;
  /** Exact (case-insensitive) asset name or original filename. */
  name?: string;
  filename?: string;
  /** Page size; omitted = everything (internal callers). The tool always sets it. */
  limit?: number;
  cursor?: string;
}): Promise<{
  assets: AssetSummary[];
  note?: string;
  page: { nextCursor: string | null; exhausted: boolean; total: number | null };
}> {
  const { kind, project, organizationId, name, filename, cursor } = options;
  const limit = options.limit != null ? Math.min(Math.max(Math.trunc(options.limit) || 1, 1), MAX_ASSET_PAGE) : null;
  const hash = createHash("sha256")
    .update(JSON.stringify([organizationId ?? null, kind ?? null, project?.trim().toLowerCase() ?? null, name?.trim().toLowerCase() ?? null, filename?.trim().toLowerCase() ?? null]))
    .digest("hex")
    .slice(0, 16);
  // Validate before any query so a bad cursor is a cheap, explicit error.
  const after = cursor ? decodeAssetCursor(cursor, hash) : null;

  // Project filter includes global assets (projectId null): an org-wide logo
  // is "the right one" for any project without its own. Both project lookups
  // are tenant-scoped (#228): another org's project names must never match or
  // appear in the "Available" hint.
  const inOrg = organizationId != null ? eq(projectsTable.organizationId, organizationId) : undefined;
  let projectId: number | null = null;
  if (project?.trim()) {
    const [match] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(ilike(projectsTable.name, project.trim()), inOrg));
    if (!match) {
      const projects = await db
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(inOrg)
        .orderBy(asc(projectsTable.name));
      return {
        assets: [],
        note: `No project named "${project}". Available: ${projects.map((p) => p.name).join(", ") || "(none)"}.`,
        page: { nextCursor: null, exhausted: true, total: 0 },
      };
    }
    projectId = match.id;
  }

  const rows = await db
    .select({ asset: assetsTable, projectName: projectsTable.name })
    .from(assetsTable)
    .leftJoin(projectsTable, eq(assetsTable.projectId, projectsTable.id))
    .where(
      and(
        kind ? eq(assetsTable.kind, kind) : undefined,
        projectId != null
          ? or(eq(assetsTable.projectId, projectId), isNull(assetsTable.projectId))
          : undefined,
        organizationId != null ? eq(assetsTable.organizationId, organizationId) : undefined,
        name?.trim() ? ilike(assetsTable.name, escapeLike(name.trim())) : undefined,
        filename?.trim() ? ilike(assetsTable.filename, escapeLike(filename.trim())) : undefined,
        after ? sql`(${assetsTable.kind}, ${assetsTable.name}, ${assetsTable.id}) > (${after.k[0]}, ${after.k[1]}, ${after.k[2]})` : undefined,
      ),
    )
    .orderBy(asc(assetsTable.kind), asc(assetsTable.name), asc(assetsTable.id))
    // One extra row tells us whether another page exists.
    .limit(limit != null ? limit + 1 : 100_000);

  const more = limit != null && rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1]?.asset;
  return {
    assets: pageRows.map(toSummary),
    page: {
      nextCursor: more && last ? encodeAssetCursor({ v: 1, h: hash, k: [last.kind, last.name, last.id] }) : null,
      exhausted: !more,
      total: null,
    },
  };
}

/** ILIKE pattern matching the text literally (no wildcards). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function getAssetDetail(
  id: number,
  organizationId?: number,
): Promise<{ asset: AssetSummary; fullResUrl: string | null; fullResExpiresAt: Date } | null> {
  const [row] = await db
    .select({ asset: assetsTable, projectName: projectsTable.name })
    .from(assetsTable)
    .leftJoin(projectsTable, eq(assetsTable.projectId, projectsTable.id))
    .where(
      and(
        eq(assetsTable.id, id),
        organizationId != null ? eq(assetsTable.organizationId, organizationId) : undefined,
      ),
    );
  if (!row) return null;

  let fullResUrl: string | null = null;
  if (row.asset.storageKey.startsWith("/objects/")) {
    try {
      const { bucketName, objectName } = resolveObjectFile(row.asset.storageKey);
      fullResUrl = await signObjectURL({ bucketName, objectName, method: "GET", ttlSec: 3600 });
    } catch {
      fullResUrl = null; // metadata still useful without a download link
    }
  }
  return { asset: toSummary(row), fullResUrl, fullResExpiresAt: new Date(Date.now() + SIGNED_URL_TTL_MS) };
}

/** Load an asset's original bytes for the HTTP gateway's download route. */
export async function getAssetFile(
  id: number,
  organizationId?: number,
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  const [row] = await db
    .select({ storageKey: assetsTable.storageKey, contentType: assetsTable.contentType, filename: assetsTable.filename, name: assetsTable.name })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, id),
        organizationId != null ? eq(assetsTable.organizationId, organizationId) : undefined,
      ),
    );
  if (!row?.storageKey?.startsWith("/objects/")) return null;
  // Never serve another org's object through this org's row (defense in depth).
  if (organizationId != null && !keyBelongsToOrg(row.storageKey, organizationId)) return null;
  try {
    const { file } = resolveObjectFile(row.storageKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buffer] = await file.download();
    return {
      buffer: buffer as Buffer,
      contentType: row.contentType || "application/octet-stream",
      filename: row.filename || `${row.name}-${id}`,
    };
  } catch {
    return null;
  }
}

// MCP image blocks support the common raster types; SVGs and PDFs are
// download-only. Assets have no thumbnails, so cap what we'll inline.
const INLINEABLE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_INLINE_BYTES = 1_500_000;

export async function loadAssetImage(
  asset: Pick<AssetSummary, "storageKey" | "contentType">,
): Promise<{ base64: string; mimeType: string } | null> {
  if (!INLINEABLE_TYPES.has(asset.contentType)) return null;
  if (!asset.storageKey.startsWith("/objects/")) return null;
  try {
    const { file } = resolveObjectFile(asset.storageKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [metadata] = await file.getMetadata().catch(() => [{ size: undefined }]);
    const size = metadata?.size != null ? Number(metadata.size) : null;
    if (size != null && size > MAX_INLINE_BYTES) return null;
    const [buffer] = await file.download();
    if ((buffer as Buffer).length > MAX_INLINE_BYTES) return null;
    return { base64: (buffer as Buffer).toString("base64"), mimeType: asset.contentType };
  } catch {
    return null;
  }
}
