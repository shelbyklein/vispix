// Structured tool results (#214, MCP-01/02). Every read tool returns this
// envelope as `structuredContent` next to its readable text. The contract is
// documented in docs/MCP_TOOLS.md; the zod shapes here are the machine-readable
// source of truth (registered as each tool's `outputSchema`).
import { z } from "zod";
import type { IssuedMediaLink } from "./mediaGrants.js";

export const TOOL_SCHEMA_VERSION = "vispix-mcp-tools/1";

/** Largest thumbnail inlined as base64 (larger ones stay link-only). */
export const MAX_INLINE_THUMBNAIL_BYTES = 1_500_000;

export type ToolErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_cursor"
  | "cursor_mismatch"
  | "search_timeout"
  | "invalid_scope"
  | "unknown_filter_value";

/** A failure a caller can act on, carried through the library layer to the tool result. */
export class McpToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

const error = z
  .object({ code: z.string(), message: z.string() })
  .nullable()
  .describe("Set when status is not 'ok'. code is a stable machine-readable value.");

const mediaLink = z.object({
  kind: z.enum(["thumbnail", "original"]),
  url: z.string().describe("Fetch with GET. Gateway grants carry no connector credential."),
  mimeType: z.string(),
  filename: z.string().nullable(),
  fileSize: z.number().int().nullable().describe("Bytes, when known."),
  expiresAt: z.string().nullable().describe("ISO-8601 UTC expiry of the link; null only if unknown."),
  grant: z.enum(["gateway_media_grant", "signed_storage_url"]),
});
export type MediaLinkInfo = z.infer<typeof mediaLink>;

const match = z.object({
  type: z.enum(["exact", "keyword", "concept"]),
  fields: z.array(z.string()).optional().describe("exact/keyword: which fields matched."),
  similarity: z.number().optional(),
  qualityScore: z.number().nullable().optional(),
  score: z.number().optional(),
});

const photoItem = z.object({
  id: z.number().int(),
  filename: z.string().nullable(),
  albumTitle: z.string().nullable(),
  description: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  takenAt: z.string().nullable(),
  rating: z.object({ average: z.number().nullable(), count: z.number().int() }),
  quality: z.object({ score: z.number().nullable(), flaws: z.array(z.string()) }),
  rights: z.array(z.string()).describe("Usage-rights tags the photo is cleared for."),
  match: match.nullable().describe("Why it matched (search only)."),
  thumbnail: mediaLink.nullable(),
});
export type PhotoItem = z.infer<typeof photoItem>;

const photoDetail = photoItem.extend({
  fileSize: z.number().int().nullable(),
  original: mediaLink.nullable(),
});

const images = z.object({
  requested: z.boolean(),
  included: z.number().int(),
  omitted: z.number().int().describe("Candidates not inlined (past the cap, too large, or unavailable)."),
  maxImages: z.number().int(),
  maxBytesEach: z.number().int(),
});
export type ImagesInfo = z.infer<typeof images>;

const page = z.object({
  returned: z.number().int(),
  nextCursor: z.string().nullable().describe("Pass back as `cursor` for the next page; null when no more."),
  exhausted: z.boolean(),
  limited: z.boolean().describe("More exist but paging stopped at the depth cap."),
  total: z.number().int().nullable(),
});

const envelope = {
  schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
  error,
  notes: z.array(z.string()).describe("Human-readable caveats; the same text appears in the readable content."),
};

export const searchPhotosOutput = {
  ...envelope,
  status: z.enum(["ok", "unavailable", "invalid_request"]),
  results: z.array(photoItem),
  page,
  retrieval: z
    .object({ version: z.string(), mode: z.string(), embeddingModel: z.string().nullable(), ranking: z.string() })
    .nullable(),
  coverage: z.object({ notEmbedded: z.number().int() }).nullable(),
  degraded: z
    .object({ reason: z.string(), affects: z.enum(["query", "exclusions", "concept"]) })
    .nullable()
    .describe("Provider trouble. status 'unavailable' means nothing was ranked; it is not an empty result."),
  images,
};

export const getPhotoOutput = {
  ...envelope,
  status: z.enum(["ok", "not_found", "forbidden"]),
  photo: photoDetail.nullable(),
  images,
};

const albumItem = z.object({ id: z.number().int(), title: z.string(), photoCount: z.number().int() });
const personItem = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  photoCount: z.number().int(),
});
const rightsItem = z.object({ id: z.number().int(), name: z.string(), photoCount: z.number().int() });

const listEnvelope = { ...envelope, status: z.enum(["ok"]) };
export const listAlbumsOutput = { ...listEnvelope, items: z.array(albumItem), page };
export const listPeopleOutput = { ...listEnvelope, items: z.array(personItem), page };
export const listUsageRightsOutput = { ...listEnvelope, items: z.array(rightsItem), page };

const assetItem = z.object({
  id: z.number().int(),
  kind: z.enum(["brand", "reference"]),
  name: z.string(),
  variant: z.string().nullable(),
  notes: z.string().nullable(),
  projectName: z.string().nullable().describe("null = global asset, applies to all projects."),
  filename: z.string().nullable(),
  mimeType: z.string(),
  fileSize: z.number().int().nullable(),
  isPrimary: z.boolean(),
});
export type AssetItem = z.infer<typeof assetItem>;

export const listAssetsOutput = {
  ...envelope,
  status: z.enum(["ok", "invalid_request"]),
  items: z.array(assetItem),
  page,
};

export const getAssetOutput = {
  ...envelope,
  status: z.enum(["ok", "not_found"]),
  asset: assetItem.extend({ original: mediaLink.nullable() }).nullable(),
  images,
};

/** Pagination block for a complete, unpaginated list. */
export function completePage(returned: number) {
  return { returned, nextCursor: null, exhausted: true, limited: false, total: returned };
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Best-effort MIME type from a filename; storage metadata wins when available. */
export function mimeFromFilename(filename: string | null | undefined): string {
  const ext = filename?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return (ext && IMAGE_MIME_BY_EXT[ext]) || "application/octet-stream";
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Signed storage URLs (stdio server) live this long; see getPhotoDetail. */
export const SIGNED_URL_TTL_MS = 3600 * 1000;

export function toMediaLink(
  kind: "thumbnail" | "original",
  link: IssuedMediaLink | { url: string; expiresAt: Date; signedStorage: true },
  info: { mimeType: string; filename: string | null; fileSize?: number | null },
): MediaLinkInfo {
  return {
    kind,
    url: link.url,
    mimeType: info.mimeType,
    filename: info.filename,
    fileSize: info.fileSize ?? null,
    expiresAt: iso(link.expiresAt),
    grant: "signedStorage" in link ? "signed_storage_url" : "gateway_media_grant",
  };
}

/** Thumbnails are always JPEG (api-server thumbnailGeneration.ts). */
export function thumbnailFilename(id: number, filename: string | null): string {
  const stem = filename ? `thumb-${filename.replace(/\.[^./\\]+$/, "")}` : `photo-${id}-thumb`;
  return `${stem}.jpg`;
}
