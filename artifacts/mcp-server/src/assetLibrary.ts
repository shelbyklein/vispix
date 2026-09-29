// Data access for the asset-library MCP tools. Assets (brand marks and
// reference works) have no thumbnails or embeddings — retrieval is by
// kind/name/variant/project, and files are served straight from storage.
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { db, assetsTable, projectsTable } from "@workspace/db";
import { signObjectURL } from "@workspace/api-server/src/lib/objectStorage";
import { resolveObjectFile } from "./photoLibrary.js";
import { keyBelongsToOrg } from "@workspace/api-server/src/lib/storageKeys";

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

export async function listAssets(options: {
  kind?: "brand" | "reference";
  project?: string;
  organizationId?: number;
}): Promise<{ assets: AssetSummary[]; note?: string }> {
  const { kind, project, organizationId } = options;

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
      ),
    )
    .orderBy(asc(assetsTable.kind), asc(assetsTable.name));

  return { assets: rows.map(toSummary) };
}

export async function getAssetDetail(
  id: number,
  organizationId?: number,
): Promise<{ asset: AssetSummary; fullResUrl: string | null } | null> {
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
  return { asset: toSummary(row), fullResUrl };
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
