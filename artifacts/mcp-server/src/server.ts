import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RetrievalError } from "@workspace/api-server/src/lib/photoRetrieval";
import {
  searchPhotos,
  getPhotoDetail,
  listAlbums,
  listPeople,
  listUsageRights,
  loadThumbnailImage,
  type PhotoSummary,
} from "./photoLibrary.js";
import { listAssets, getAssetDetail, loadAssetImage, MAX_ASSET_PAGE, type AssetSummary } from "./assetLibrary.js";
import type { IssuedMediaLink, MediaLinkIssuer } from "./mediaGrants.js";
import {
  MAX_INLINE_THUMBNAIL_BYTES,
  McpToolError,
  TOOL_SCHEMA_VERSION,
  completePage,
  getAssetOutput,
  getPhotoOutput,
  listAlbumsOutput,
  listAssetsOutput,
  listPeopleOutput,
  listUsageRightsOutput,
  mimeFromFilename,
  searchPhotosOutput,
  thumbnailFilename,
  toMediaLink,
  type AssetItem,
  type ImagesInfo,
  type MediaLinkInfo,
  type PhotoItem,
} from "./structured.js";

// Caps on inline images (includeImages): base64 is the bulk of a payload, and a
// model judging fit rarely needs more than a screenful. Both the count and the
// bytes are bounded; anything past a bound stays reachable by thumbnail link.
const MAX_INLINE_IMAGES = 10;
const MAX_INLINE_TOTAL_BYTES = 6_000_000;

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

// One tool result can mix prose, inline images, and typed download links.
// resource_link is the spec's typed pointer: clients that understand it can
// render a download card or fetch lazily; others still see the URL in the text.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string };

// Media links are one-object grants (#204) that expire; say when, in UTC.
function expiryLabel(link: { expiresAt: Date }): string {
  return `expires ${link.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

// A fetchable thumbnail link for a photo (#174). Thumbnails are always JPEG
// (see api-server thumbnailGeneration.ts), so we declare `mimeType` and a `.jpg`
// name: the mimeType lets clients that gate on content type render the URL as an
// inline preview instead of a bare link, and matching the name to the actual
// JPEG bytes avoids a `.webp`-named-but-JPEG mismatch inherited from the original.
function thumbnailLink(link: IssuedMediaLink, id: number, filename: string | null): ContentBlock {
  return {
    type: "resource_link",
    uri: link.url,
    name: thumbnailFilename(id, filename),
    description: `Thumbnail of photo #${id} (link ${expiryLabel(link)})`,
    mimeType: "image/jpeg",
  };
}

const NO_IMAGES: ImagesInfo = { requested: false, included: 0, omitted: 0, maxImages: 0, maxBytesEach: MAX_INLINE_THUMBNAIL_BYTES };

/** The failures a caller can act on, as a stable code + message. */
function actionableError(err: unknown): { code: string; message: string } | null {
  if (err instanceof McpToolError || err instanceof RetrievalError) return { code: err.code, message: err.message };
  return null;
}

export interface ServerOptions {
  /**
   * Issues the HTTP gateway's media links (#204): expiring, single-object
   * grants that carry no connector credential. When set, get_photo/get_asset
   * return gateway download links instead of signed storage URLs — signed URLs
   * point at the local storage endpoint, which remote clients can't reach — and
   * photo results also link a thumbnail for lightweight previews. Unset for the
   * local stdio server, which returns ~1h signed storage URLs.
   */
  mediaLinks?: MediaLinkIssuer;
  /**
   * The organization this session is scoped to (issue #113, Phase 5): the HTTP
   * gateway sets it from the authenticating token so every tool only sees that
   * org's library. Undefined for the local stdio server (single-tenant, global).
   */
  organizationId?: number;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "vispix",
    version: "1.0.0",
  });

  const thumbnailInfo = (p: Pick<PhotoSummary, "id" | "filename" | "thumbnailKey">): MediaLinkInfo | null =>
    options.mediaLinks && p.thumbnailKey
      ? toMediaLink("thumbnail", options.mediaLinks.photo(p.id, "thumbnail"), {
          mimeType: "image/jpeg",
          filename: thumbnailFilename(p.id, p.filename),
        })
      : null;

  const photoItem = (p: PhotoSummary): PhotoItem => ({
    id: p.id,
    filename: p.filename,
    albumTitle: p.albumTitle,
    description: p.aiDescription,
    width: p.width,
    height: p.height,
    takenAt: p.takenAt,
    rating: { average: p.averageRating, count: p.ratingCount },
    quality: { score: p.aiScore, flaws: p.aiFlaws },
    rights: p.rights,
    rightsStatus: p.rights.length > 0 ? ("recorded" as const) : ("not_recorded" as const),
    match: p.match ?? null,
    thumbnail: thumbnailInfo(p),
  });

  /**
   * Inline thumbnails, bounded in count and bytes. Returns the image blocks
   * and an account of what was (not) included.
   */
  async function inlineThumbnails(
    photos: PhotoSummary[],
    requested: boolean,
    maxImages: number,
    label: boolean,
  ): Promise<{ blocks: ContentBlock[]; info: ImagesInfo }> {
    const cap = Math.min(maxImages, MAX_INLINE_IMAGES);
    const blocks: ContentBlock[] = [];
    let included = 0;
    let bytes = 0;
    if (requested) {
      for (const p of photos.slice(0, cap)) {
        if (bytes >= MAX_INLINE_TOTAL_BYTES) break;
        const img = await loadThumbnailImage(p.thumbnailKey);
        if (!img) continue;
        bytes += img.base64.length;
        if (label) blocks.push(textBlock(`photo #${p.id}:`));
        blocks.push({ type: "image", data: img.base64, mimeType: img.mimeType });
        included++;
      }
    }
    const info: ImagesInfo = {
      requested,
      included,
      omitted: requested ? photos.length - included : 0,
      maxImages: cap,
      maxBytesEach: MAX_INLINE_THUMBNAIL_BYTES,
    };
    if (requested && photos.length > included && photos.length > 1) {
      blocks.push(textBlock(`(thumbnails shown for ${included} of ${photos.length}; use get_photo for the rest)`));
    }
    return { blocks, info };
  }

  const emptyPage = { returned: 0, nextCursor: null, exhausted: true, limited: false, total: null };

  server.registerTool(
    "search_photos",
    {
      title: "Search photos semantically",
      description:
        "Find photos in the Vispix photo library that match a natural-language description " +
        "(e.g. 'person celebrating a win', 'close-up of hands at work'). Results are ranked " +
        "by semantic similarity and include inline thumbnails so you can judge visual fit. " +
        "Use one focused concept per call; make multiple calls for multiple concepts. " +
        "Look up a photo by exact filename or id with mode 'combined' (query 'IMG_0042.jpg' or '#123'); " +
        "page through more results by passing the previous response's page.nextCursor as cursor. " +
        "Structured output: see docs/MCP_TOOLS.md.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the desired imagery, or an exact filename / photo id with mode 'combined' or 'keyword'"),
        count: z.number().int().min(1).max(50).default(8).describe("Page size: how many results to return"),
        mode: z
          .enum(["concept", "combined", "keyword"])
          .default("concept")
          .describe("concept = semantic ranking (default); combined = exact filename/id matches first, then semantic; keyword = exact matches, then literal substring matches"),
        cursor: z.string().optional().describe("page.nextCursor from the previous page of the same query and filters"),
        exclude: z.string().optional().describe("Concept to steer away from (e.g. 'crowds', 'indoor range')"),
        minRating: z.number().min(1).max(5).optional().describe("Only photos with at least this average star rating"),
        minQuality: z.number().min(0).max(10).optional().describe("Only photos with at least this AI quality score (0-10; e.g. 7 for hero-shot candidates)"),
        rightsTag: z.string().optional().describe("Only photos with this usage-rights tag recorded (see list_usage_rights)"),
        person: z.string().optional().describe("Only photos tagged to this person (see list_people)"),
        includeImages: z.boolean().default(true).describe("Inline thumbnail images in the response"),
        maxImages: z.number().int().min(1).max(MAX_INLINE_IMAGES).default(MAX_INLINE_IMAGES).describe("Cap on inline images (also bounded by total bytes)"),
      },
      outputSchema: searchPhotosOutput,
    },
    async ({ query, count, mode, cursor, exclude, minRating, minQuality, rightsTag, person, includeImages, maxImages }, extra) => {
      let r;
      try {
        r = await searchPhotos({ query, count, mode, cursor, exclude, minRating, minQuality, rightsTag, person, organizationId: options.organizationId, signal: extra.signal });
      } catch (err) {
        const error = actionableError(err);
        if (!error) throw err;
        return {
          isError: true,
          content: [textBlock(`${error.message} (${error.code})`)],
          structuredContent: {
            schemaVersion: TOOL_SCHEMA_VERSION,
            status: "invalid_request" as const,
            results: [],
            page: emptyPage,
            retrieval: null,
            coverage: null,
            degraded: null,
            images: NO_IMAGES,
            error,
            notes: [],
          },
        };
      }
      const { results, note } = r;
      const structured = (images: ImagesInfo) => ({
        schemaVersion: TOOL_SCHEMA_VERSION,
        status: r.status,
        results: results.map(photoItem),
        page: { returned: results.length, ...r.page },
        retrieval: r.retrieval,
        coverage: r.coverage,
        degraded: r.degraded,
        images,
        error: r.error,
        notes: note ? [note] : [],
      });

      if (results.length === 0) {
        const text = note ?? `No photos matched "${query}".`;
        return { content: [textBlock(r.page.nextCursor ? `${text}\nnext page cursor: ${r.page.nextCursor}` : text)], structuredContent: structured(NO_IMAGES) };
      }

      const lines = results.map((p, i) => {
        const bits = [
          `${i + 1}. photo #${p.id}`,
          p.match?.type === "exact" && "EXACT match",
          p.filename && `file: ${p.filename}`,
          p.albumTitle && `album: ${p.albumTitle}`,
          p.width && p.height && `${p.width}x${p.height}`,
          p.averageRating != null && `rating: ${p.averageRating.toFixed(1)}/5 (${p.ratingCount})`,
          p.aiScore != null && `quality: ${p.aiScore.toFixed(1)}/10${p.aiFlaws.length > 0 ? ` (flaws: ${p.aiFlaws.join(", ")})` : ""}`,
          p.rights.length > 0 ? `rights recorded: ${p.rights.join(", ")}` : "rights: not recorded",
        ].filter(Boolean);
        const desc = p.aiDescription ? `\n   ${p.aiDescription.slice(0, 300)}` : "";
        return bits.join(" | ") + desc;
      });

      const footer = [note, r.page.nextCursor && `next page cursor: ${r.page.nextCursor}`].filter(Boolean).join("\n");
      const content: ContentBlock[] = [textBlock(`${results.length} photos for "${query}":\n\n${lines.join("\n")}${footer ? `\n\n${footer}` : ""}`)];

      // Over HTTP every result also carries a fetchable thumbnail URL, so
      // clients can display/embed previews without the base64 (or fetch the
      // ones past the inline cap). Stdio callers already get inline pixels
      // and couldn't reach gateway URLs anyway.
      if (options.mediaLinks) {
        for (const p of results) {
          if (!p.thumbnailKey) continue;
          content.push(thumbnailLink(options.mediaLinks.photo(p.id, "thumbnail"), p.id, p.filename));
        }
      }

      const { blocks, info } = await inlineThumbnails(results, includeImages, maxImages, true);
      content.push(...blocks);
      return { content, structuredContent: structured(info) };
    },
  );

  server.registerTool(
    "get_photo",
    {
      title: "Get one photo in full detail",
      description:
        "Fetch a single photo by id: full metadata, its thumbnail image, and a time-limited link " +
        "to download the full-resolution file. status is 'not_found' for any id you can't see " +
        "(outside your library, or hidden).",
      inputSchema: {
        id: z.number().int().describe("Photo id (from search_photos results)"),
        includeImages: z.boolean().default(true).describe("Inline the thumbnail image in the response"),
      },
      outputSchema: getPhotoOutput,
    },
    async ({ id, includeImages }) => {
      const failure = (status: "not_found" | "forbidden", message: string) => ({
        isError: true,
        content: [textBlock(message)],
        structuredContent: {
          schemaVersion: TOOL_SCHEMA_VERSION,
          status,
          photo: null,
          images: NO_IMAGES,
          error: { code: status, message },
          notes: [],
        },
      });
      const detail = await getPhotoDetail(id, options.organizationId);
      if (!detail) return failure("not_found", `Photo #${id} not found.`);
      // Same visibility rule as search and the web app (#218): connectors never
      // see hidden photos, and a hidden id reads exactly like a missing one.
      if (detail.hidden) return failure("not_found", `Photo #${id} not found.`);
      const { photo } = detail;
      const grant = options.mediaLinks?.photo(photo.id, "original");
      const fullResUrl = grant ? grant.url : detail.fullResUrl;
      const validity = grant ? expiryLabel(grant) : "valid ~1h";
      const lines = [
        `photo #${photo.id}`,
        photo.filename && `file: ${photo.filename}`,
        photo.albumTitle && `album: ${photo.albumTitle}`,
        photo.width && photo.height && `dimensions: ${photo.width}x${photo.height}`,
        photo.averageRating != null && `rating: ${photo.averageRating.toFixed(1)}/5 (${photo.ratingCount} ratings)`,
        photo.aiScore != null && `AI quality score: ${photo.aiScore.toFixed(1)}/10${photo.aiFlaws.length > 0 ? ` — flaws: ${photo.aiFlaws.join(", ")}` : ""}`,
        photo.rights.length > 0
          ? `usage rights recorded by the team: ${photo.rights.join(", ")} (not a legal clearance)`
          : "usage rights: not recorded (unknown) — check before publishing",
        photo.takenAt && `taken: ${photo.takenAt}`,
        photo.aiDescription && `description: ${photo.aiDescription}`,
        fullResUrl && `full-resolution download (${validity}): ${fullResUrl}`,
      ].filter(Boolean);

      const content: ContentBlock[] = [textBlock(lines.join("\n"))];
      if (fullResUrl) {
        content.push({
          type: "resource_link",
          uri: fullResUrl,
          name: photo.filename || `photo-${photo.id}`,
          description: `Full-resolution original (link ${validity})`,
          mimeType: detail.mimeType,
        });
      }
      if (options.mediaLinks && photo.thumbnailKey) {
        content.push(thumbnailLink(options.mediaLinks.photo(photo.id, "thumbnail"), photo.id, photo.filename));
      }
      const { blocks, info } = await inlineThumbnails([photo], includeImages, 1, false);
      content.push(...blocks);

      const original: MediaLinkInfo | null = fullResUrl
        ? toMediaLink("original", grant ?? { url: fullResUrl, expiresAt: detail.fullResExpiresAt, signedStorage: true }, {
            mimeType: detail.mimeType,
            filename: photo.filename,
            fileSize: detail.fileSize,
          })
        : null;
      return {
        content,
        structuredContent: {
          schemaVersion: TOOL_SCHEMA_VERSION,
          status: "ok" as const,
          photo: { ...photoItem(photo), fileSize: detail.fileSize, original },
          images: info,
          error: null,
          notes: [],
        },
      };
    },
  );

  // The three small enumerations return the whole (org-scoped) list in one page;
  // `page` is still present so every tool shares one envelope.
  const listEnvelope = (items: unknown[]) => ({
    schemaVersion: TOOL_SCHEMA_VERSION,
    status: "ok" as const,
    page: completePage(items.length),
    error: null,
    notes: [],
  });

  server.registerTool(
    "list_albums",
    {
      title: "List albums",
      description: "List the photo library's albums with photo counts, to scope or describe searches.",
      inputSchema: {},
      outputSchema: listAlbumsOutput,
    },
    async () => {
      const albums = await listAlbums(options.organizationId);
      const lines = albums.map((a) => `#${a.id} ${a.title} — ${a.photoCount} photos`);
      return {
        content: [textBlock(lines.join("\n") || "No albums.")],
        structuredContent: { ...listEnvelope(albums), items: albums },
      };
    },
  );

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description:
        "List the people photos can be tagged to, with tagged-photo counts. Pass a name " +
        "as search_photos' person to restrict results to that person's photos.",
      inputSchema: {},
      outputSchema: listPeopleOutput,
    },
    async () => {
      const people = await listPeople(options.organizationId);
      const lines = people.map(
        (p) => `${p.name} — ${p.photoCount} photo${p.photoCount !== 1 ? "s" : ""}${p.description ? ` (${p.description})` : ""}`,
      );
      return {
        content: [textBlock(lines.join("\n") || "No people defined yet.")],
        structuredContent: { ...listEnvelope(people), items: people },
      };
    },
  );

  server.registerTool(
    "list_usage_rights",
    {
      title: "List usage-rights tags",
      description:
        "List the usage-rights tags your team can record on photos (e.g. web, print, social media). " +
        "A recorded tag is the team's own record, not a legal clearance; photos with no tag are 'not recorded' (unknown). " +
        "Pass a tag name as search_photos' rightsTag to restrict results to photos with that tag recorded.",
      inputSchema: {},
      outputSchema: listUsageRightsOutput,
    },
    async () => {
      const tags = await listUsageRights(options.organizationId);
      const lines = tags.map((t) => `${t.name} — ${t.photoCount} photos cleared`);
      return {
        content: [textBlock(lines.join("\n") || "No usage-rights tags defined.")],
        structuredContent: { ...listEnvelope(tags), items: tags },
      };
    },
  );

  function describeAsset(a: AssetSummary, index?: number): string {
    const bits = [
      `${index != null ? `${index + 1}. ` : ""}asset #${a.id}`,
      a.isPrimary && "PRIMARY LOGO (designated)",
      `kind: ${a.kind}`,
      `name: ${a.name}`,
      a.variant && `variant: ${a.variant}`,
      a.projectName ? `project: ${a.projectName}` : "project: (global — applies to all projects)",
      a.filename && `file: ${a.filename}`,
      a.contentType,
    ].filter(Boolean);
    const notes = a.notes ? `\n   ${a.notes.slice(0, 300)}` : "";
    return bits.join(" | ") + notes;
  }

  const assetItem = (a: AssetSummary): AssetItem => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    variant: a.variant,
    notes: a.notes,
    projectName: a.projectName,
    filename: a.filename,
    mimeType: a.contentType,
    fileSize: a.fileSize,
    isPrimary: a.isPrimary,
  });

  server.registerTool(
    "list_assets",
    {
      title: "List brand assets and reference works",
      description:
        "List the asset library: kind 'brand' is logos/marks to embed in a deliverable (pick the right " +
        "variant, e.g. primary vs white vs icon-only); kind 'reference' is past works to study so new " +
        "output matches the established style. Filter by project to get that project's assets plus the " +
        "global ones, or look one up by exact name / filename. Pages with cursor. " +
        "Use get_asset for a preview image and download link.",
      inputSchema: {
        kind: z.enum(["brand", "reference"]).optional().describe("Only this kind of asset"),
        project: z.string().optional().describe("Only assets for this project (by name) plus global assets"),
        name: z.string().optional().describe("Exact asset name (case-insensitive)"),
        filename: z.string().optional().describe("Exact original filename (case-insensitive)"),
        limit: z.number().int().min(1).max(MAX_ASSET_PAGE).default(100).describe("Page size"),
        cursor: z.string().optional().describe("page.nextCursor from the previous page of the same filters"),
      },
      outputSchema: listAssetsOutput,
    },
    async ({ kind, project, name, filename, limit, cursor }) => {
      let r;
      try {
        r = await listAssets({ kind, project, name, filename, limit, cursor, organizationId: options.organizationId });
      } catch (err) {
        const error = actionableError(err);
        if (!error) throw err;
        return {
          isError: true,
          content: [textBlock(`${error.message} (${error.code})`)],
          structuredContent: { schemaVersion: TOOL_SCHEMA_VERSION, status: "invalid_request" as const, items: [], page: emptyPage, error, notes: [] },
        };
      }
      const { assets, note, page } = r;
      const structuredContent = {
        schemaVersion: TOOL_SCHEMA_VERSION,
        status: "ok" as const,
        items: assets.map(assetItem),
        page: { returned: assets.length, nextCursor: page.nextCursor, exhausted: page.exhausted, limited: false, total: page.total },
        error: null,
        notes: note ? [note] : [],
      };
      if (assets.length === 0) {
        return { content: [textBlock(note ?? "The asset library is empty so far.")], structuredContent };
      }
      const lines = assets.map((a, i) => describeAsset(a, i));
      const more = page.nextCursor ? `\n\nnext page cursor: ${page.nextCursor}` : "";
      return { content: [textBlock(`${assets.length} assets:\n\n${lines.join("\n")}${more}`)], structuredContent };
    },
  );

  server.registerTool(
    "get_asset",
    {
      title: "Get one asset with preview and download link",
      description:
        "Fetch a single asset by id: metadata, an inline preview when the file is a raster image, and a " +
        "download link for the original file (use it to pull a logo into a deliverable at full quality — " +
        "SVGs and PDFs are download-only, no inline preview).",
      inputSchema: {
        id: z.number().int().describe("Asset id (from list_assets results)"),
        includeImages: z.boolean().default(true).describe("Inline a preview image when the file is a small raster image"),
      },
      outputSchema: getAssetOutput,
    },
    async ({ id, includeImages }) => {
      const detail = await getAssetDetail(id, options.organizationId);
      if (!detail) {
        const message = `Asset #${id} not found.`;
        return {
          isError: true,
          content: [textBlock(message)],
          structuredContent: {
            schemaVersion: TOOL_SCHEMA_VERSION,
            status: "not_found" as const,
            asset: null,
            images: NO_IMAGES,
            error: { code: "not_found", message },
            notes: [],
          },
        };
      }
      const { asset } = detail;
      const grant = options.mediaLinks?.asset(asset.id);
      const downloadUrl = grant ? grant.url : detail.fullResUrl;
      const validity = grant ? expiryLabel(grant) : "valid ~1h";
      const lines = [
        describeAsset(asset),
        asset.fileSize != null && `size: ${asset.fileSize} bytes`,
        downloadUrl && `original download (${validity}): ${downloadUrl}`,
      ].filter(Boolean) as string[];

      const content: ContentBlock[] = [textBlock(lines.join("\n"))];
      if (downloadUrl) {
        content.push({
          type: "resource_link",
          uri: downloadUrl,
          name: asset.filename || asset.name,
          description: `Original file (link ${validity})`,
          ...(asset.contentType ? { mimeType: asset.contentType } : {}),
        });
      }
      const img = includeImages ? await loadAssetImage(asset) : null;
      if (img) content.push({ type: "image", data: img.base64, mimeType: img.mimeType });

      const expiresAt = grant?.expiresAt ?? detail.fullResExpiresAt;
      const original: MediaLinkInfo | null = downloadUrl
        ? {
            kind: "original",
            url: downloadUrl,
            mimeType: asset.contentType || mimeFromFilename(asset.filename),
            filename: asset.filename,
            fileSize: asset.fileSize,
            expiresAt: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
            grant: grant ? "gateway_media_grant" : "signed_storage_url",
          }
        : null;
      return {
        content,
        structuredContent: {
          schemaVersion: TOOL_SCHEMA_VERSION,
          status: "ok" as const,
          asset: { ...assetItem(asset), original },
          images: { requested: includeImages, included: img ? 1 : 0, omitted: includeImages && !img ? 1 : 0, maxImages: 1, maxBytesEach: 1_500_000 },
          error: null,
          notes: [],
        },
      };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
