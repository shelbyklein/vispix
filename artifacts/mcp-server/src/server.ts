import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchPhotos,
  getPhotoDetail,
  listAlbums,
  listPeople,
  listUsageRights,
  loadThumbnailImage,
} from "./photoLibrary.js";
import { listAssets, getAssetDetail, loadAssetImage, type AssetSummary } from "./assetLibrary.js";

// Cap on inline thumbnails per search response: base64 images are the bulk of
// the payload, and a model judging fit rarely needs more than a screenful.
const MAX_INLINE_IMAGES = 10;

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

// A fetchable thumbnail link for a photo (#174). Thumbnails are always JPEG
// (see api-server thumbnailGeneration.ts), so we declare `mimeType` and a `.jpg`
// name: the mimeType lets clients that gate on content type render the URL as an
// inline preview instead of a bare link, and matching the name to the actual
// JPEG bytes avoids a `.webp`-named-but-JPEG mismatch inherited from the original.
function thumbnailLink(base: string, id: number, filename: string | null): ContentBlock {
  const stem = filename ? `thumb-${filename.replace(/\.[^./\\]+$/, "")}` : `photo-${id}-thumb`;
  return {
    type: "resource_link",
    uri: `${base}/photo/${id}/thumbnail`,
    name: `${stem}.jpg`,
    description: `Thumbnail of photo #${id}`,
    mimeType: "image/jpeg",
  };
}

export interface ServerOptions {
  /**
   * Base URL of the HTTP gateway (including any auth prefix). When set,
   * get_photo returns `<base>/photo/<id>/original` download links instead of
   * signed storage URLs — signed URLs point at the local storage endpoint,
   * which remote clients can't reach — and photo results also link
   * `<base>/photo/<id>/thumbnail` for lightweight previews.
   */
  externalDownloadBase?: string;
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

  server.registerTool(
    "search_photos",
    {
      title: "Search photos semantically",
      description:
        "Find photos in the Vispix photo library that match a natural-language description " +
        "(e.g. 'person celebrating a win', 'close-up of hands at work'). Results are ranked " +
        "by semantic similarity and include inline thumbnails so you can judge visual fit. " +
        "Use one focused concept per call; make multiple calls for multiple concepts.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the desired imagery"),
        count: z.number().int().min(1).max(50).default(8).describe("How many results to return"),
        exclude: z.string().optional().describe("Concept to steer away from (e.g. 'crowds', 'indoor range')"),
        minRating: z.number().min(1).max(5).optional().describe("Only photos with at least this average star rating"),
        minQuality: z.number().min(0).max(10).optional().describe("Only photos with at least this AI quality score (0-10; e.g. 7 for hero-shot candidates)"),
        rightsTag: z.string().optional().describe("Only photos cleared for this usage-rights tag (see list_usage_rights)"),
        person: z.string().optional().describe("Only photos tagged to this person (see list_people)"),
        includeImages: z.boolean().default(true).describe("Inline thumbnail images in the response"),
      },
    },
    async ({ query, count, exclude, minRating, minQuality, rightsTag, person, includeImages }) => {
      const { results, note } = await searchPhotos({ query, count, exclude, minRating, minQuality, rightsTag, person, organizationId: options.organizationId });
      if (results.length === 0) {
        return { content: [textBlock(note ?? `No photos matched "${query}".`)] };
      }

      const lines = results.map((p, i) => {
        const bits = [
          `${i + 1}. photo #${p.id}`,
          p.filename && `file: ${p.filename}`,
          p.albumTitle && `album: ${p.albumTitle}`,
          p.width && p.height && `${p.width}x${p.height}`,
          p.averageRating != null && `rating: ${p.averageRating.toFixed(1)}/5 (${p.ratingCount})`,
          p.aiScore != null && `quality: ${p.aiScore.toFixed(1)}/10${p.aiFlaws.length > 0 ? ` (flaws: ${p.aiFlaws.join(", ")})` : ""}`,
          p.rights.length > 0 && `rights: ${p.rights.join(", ")}`,
        ].filter(Boolean);
        const desc = p.aiDescription ? `\n   ${p.aiDescription.slice(0, 300)}` : "";
        return bits.join(" | ") + desc;
      });

      const content: ContentBlock[] = [textBlock(`${results.length} photos for "${query}":\n\n${lines.join("\n")}${note ? `\n\n${note}` : ""}`)];

      // Over HTTP every result also carries a fetchable thumbnail URL, so
      // clients can display/embed previews without the base64 (or fetch the
      // ones past the inline cap). Stdio callers already get inline pixels
      // and couldn't reach gateway URLs anyway.
      if (options.externalDownloadBase) {
        for (const p of results) {
          if (!p.thumbnailKey) continue;
          content.push(thumbnailLink(options.externalDownloadBase, p.id, p.filename));
        }
      }

      if (includeImages) {
        const withImages = results.slice(0, MAX_INLINE_IMAGES);
        for (const p of withImages) {
          const img = await loadThumbnailImage(p.thumbnailKey);
          if (img) {
            content.push(textBlock(`photo #${p.id}:`));
            content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
          }
        }
        if (results.length > withImages.length) {
          content.push(textBlock(`(thumbnails shown for the first ${withImages.length}; use get_photo for the rest)`));
        }
      }

      return { content };
    },
  );

  server.registerTool(
    "get_photo",
    {
      title: "Get one photo in full detail",
      description:
        "Fetch a single photo by id: full metadata, its thumbnail image, and a time-limited signed URL " +
        "to download the full-resolution file.",
      inputSchema: {
        id: z.number().int().describe("Photo id (from search_photos results)"),
      },
    },
    async ({ id }) => {
      const detail = await getPhotoDetail(id, options.organizationId);
      if (!detail) {
        return { content: [textBlock(`Photo #${id} not found.`)], isError: true };
      }
      const { photo } = detail;
      const fullResUrl = options.externalDownloadBase
        ? `${options.externalDownloadBase}/photo/${photo.id}/original`
        : detail.fullResUrl;
      const lines = [
        `photo #${photo.id}`,
        photo.filename && `file: ${photo.filename}`,
        photo.albumTitle && `album: ${photo.albumTitle}`,
        photo.width && photo.height && `dimensions: ${photo.width}x${photo.height}`,
        photo.averageRating != null && `rating: ${photo.averageRating.toFixed(1)}/5 (${photo.ratingCount} ratings)`,
        photo.aiScore != null && `AI quality score: ${photo.aiScore.toFixed(1)}/10${photo.aiFlaws.length > 0 ? ` — flaws: ${photo.aiFlaws.join(", ")}` : ""}`,
        photo.rights.length > 0 ? `usage rights: ${photo.rights.join(", ")}` : "usage rights: none recorded",
        photo.takenAt && `taken: ${photo.takenAt}`,
        photo.aiDescription && `description: ${photo.aiDescription}`,
        fullResUrl && `full-resolution download (valid ~1h): ${fullResUrl}`,
      ].filter(Boolean);

      const content: ContentBlock[] = [textBlock(lines.join("\n"))];
      if (fullResUrl) {
        content.push({
          type: "resource_link",
          uri: fullResUrl,
          name: photo.filename || `photo-${photo.id}`,
          description: "Full-resolution original (link valid ~1h)",
        });
      }
      if (options.externalDownloadBase && photo.thumbnailKey) {
        content.push(thumbnailLink(options.externalDownloadBase, photo.id, photo.filename));
      }
      const img = await loadThumbnailImage(photo.thumbnailKey);
      if (img) content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
      return { content };
    },
  );

  server.registerTool(
    "list_albums",
    {
      title: "List albums",
      description: "List the photo library's albums with photo counts, to scope or describe searches.",
      inputSchema: {},
    },
    async () => {
      const albums = await listAlbums(options.organizationId);
      const lines = albums.map((a) => `#${a.id} ${a.title} — ${a.photoCount} photos`);
      return { content: [textBlock(lines.join("\n") || "No albums.")] };
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
    },
    async () => {
      const people = await listPeople(options.organizationId);
      const lines = people.map(
        (p) => `${p.name} — ${p.photoCount} photo${p.photoCount !== 1 ? "s" : ""}${p.description ? ` (${p.description})` : ""}`,
      );
      return { content: [textBlock(lines.join("\n") || "No people defined yet.")] };
    },
  );

  server.registerTool(
    "list_usage_rights",
    {
      title: "List usage-rights tags",
      description:
        "List the attribution / usage-rights tags photos can be cleared for (e.g. web, print, " +
        "social media). Pass a tag name as search_photos' rightsTag to restrict results to cleared photos.",
      inputSchema: {},
    },
    async () => {
      const tags = await listUsageRights(options.organizationId);
      const lines = tags.map((t) => `${t.name} — ${t.photoCount} photos cleared`);
      return { content: [textBlock(lines.join("\n") || "No usage-rights tags defined.")] };
    },
  );

  function describeAsset(a: AssetSummary, index?: number): string {
    const bits = [
      `${index != null ? `${index + 1}. ` : ""}asset #${a.id}`,
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

  server.registerTool(
    "list_assets",
    {
      title: "List brand assets and reference works",
      description:
        "List the asset library: kind 'brand' is logos/marks to embed in a deliverable (pick the right " +
        "variant, e.g. primary vs white vs icon-only); kind 'reference' is past works to study so new " +
        "output matches the established style. Filter by project to get that project's assets plus the " +
        "global ones. Use get_asset for a preview image and download link.",
      inputSchema: {
        kind: z.enum(["brand", "reference"]).optional().describe("Only this kind of asset"),
        project: z.string().optional().describe("Only assets for this project (by name) plus global assets"),
      },
    },
    async ({ kind, project }) => {
      const { assets, note } = await listAssets({ kind, project, organizationId: options.organizationId });
      if (assets.length === 0) {
        return { content: [textBlock(note ?? "The asset library is empty so far.")] };
      }
      const lines = assets.map((a, i) => describeAsset(a, i));
      return { content: [textBlock(`${assets.length} assets:\n\n${lines.join("\n")}`)] };
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
      },
    },
    async ({ id }) => {
      const detail = await getAssetDetail(id, options.organizationId);
      if (!detail) {
        return { content: [textBlock(`Asset #${id} not found.`)], isError: true };
      }
      const { asset } = detail;
      const downloadUrl = options.externalDownloadBase
        ? `${options.externalDownloadBase}/asset/${asset.id}/original`
        : detail.fullResUrl;
      const lines = [
        describeAsset(asset),
        asset.fileSize != null && `size: ${asset.fileSize} bytes`,
        downloadUrl && `original download (valid ~1h): ${downloadUrl}`,
      ].filter(Boolean) as string[];

      const content: ContentBlock[] = [textBlock(lines.join("\n"))];
      if (downloadUrl) {
        content.push({
          type: "resource_link",
          uri: downloadUrl,
          name: asset.filename || asset.name,
          description: "Original file (link valid ~1h)",
          ...(asset.contentType ? { mimeType: asset.contentType } : {}),
        });
      }
      const img = await loadAssetImage(asset);
      if (img) content.push({ type: "image", data: img.base64, mimeType: img.mimeType });
      return { content };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
