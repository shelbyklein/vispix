import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerOptions } from "./server.js";
import { safeObjectHeaders } from "@workspace/api-server/src/lib/storageKeys";
import {
  createMediaLinkIssuer,
  verifyMediaGrant,
  type GrantParent,
  type MediaGrantClaims,
  type MediaGrantKeys,
} from "./mediaGrants.js";

export interface MediaFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

/** A connector credential that authenticated a request. */
export interface ResolvedCredential {
  organizationId: number;
  parent: GrantParent;
}

// Everything that touches the database or storage is injected, so the routes
// can be exercised in tests without either (see httpServer.ts for the real
// wiring).
export interface GatewayDeps {
  /** Public origin of this gateway (MCP_PUBLIC_URL); media links need it. */
  publicUrl?: string;
  keys: MediaGrantKeys;
  now?: () => number;
  resolveCredential(candidate: string): Promise<ResolvedCredential | null>;
  /** Is the credential that minted this grant still valid for its org? */
  isGrantParentLive(claims: MediaGrantClaims): Promise<boolean>;
  createMcpServer(options: ServerOptions): McpServer;
  getPhotoOriginal(id: number, organizationId?: number): Promise<MediaFile | null>;
  getPhotoThumbnail(id: number, organizationId?: number): Promise<MediaFile | null>;
  getAssetOriginal(id: number, organizationId?: number): Promise<MediaFile | null>;
}

type AuthedRequest = Request & { mcpOrgId?: number; mcpParent?: GrantParent };

function safeName(filename: string): string {
  return filename.replace(/[^\w .-]+/g, "");
}

// Thumbnails are always JPEG (api-server thumbnailGeneration.ts), so serve an
// authoritative image/jpeg + .jpg name — the correct-Content-Type guarantee
// behind the resource_link previews (#174), independent of whatever the stored
// object's GCS metadata happens to say.
function sendThumbnail(res: Response, file: MediaFile): void {
  const jpgName = safeName(file.filename.replace(/\.[^./\\]+$/, "")) + ".jpg";
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Content-Disposition", `inline; filename="${jpgName}"`);
  res.setHeader("Content-Security-Policy", safeObjectHeaders("image/jpeg")["Content-Security-Policy"]);
  res.send(file.buffer);
}

// Originals carry a stored, partly client-declared type: only raster images
// are served inline; anything else (SVG, PDF, fonts, mislabelled files) is an
// attachment, and everything is sandboxed.
function sendOriginal(res: Response, file: MediaFile): void {
  const safe = safeObjectHeaders(file.contentType);
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `${safe["Content-Disposition"] ? "attachment" : "inline"}; filename="${safeName(file.filename)}"`);
  res.setHeader("Content-Security-Policy", safe["Content-Security-Policy"]);
  res.send(file.buffer);
}

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(value ?? "", 10);
  return Number.isInteger(id) ? id : null;
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const now = deps.now ?? Date.now;
  const publicUrl = deps.publicUrl?.replace(/\/$/, "");

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Unauthenticated liveness probe (no library data).
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Media grants (#204): the grant is the whole authorization, so this route
  // sits before connector auth. Failures never echo the grant back.
  app.get("/media/:grant", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!publicUrl) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const grant = Array.isArray(req.params.grant) ? req.params.grant[0] : req.params.grant;
    const verified = verifyMediaGrant(grant ?? "", deps.keys, publicUrl, now());
    if (!verified.ok) {
      if (verified.reason === "expired") {
        res.status(410).json({ error: "Media link expired; call get_photo or get_asset again for a fresh link" });
      } else {
        res.status(403).json({ error: "Invalid media link" });
      }
      return;
    }
    const { claims } = verified;
    if (!(await deps.isGrantParentLive(claims))) {
      res.status(403).json({ error: "Invalid media link" });
      return;
    }
    if (claims.kind === "photo" && claims.rep === "thumbnail") {
      const file = await deps.getPhotoThumbnail(claims.id, claims.org);
      if (!file) {
        res.status(404).json({ error: "Thumbnail not found" });
        return;
      }
      sendThumbnail(res, file);
      return;
    }
    const file = claims.kind === "photo"
      ? await deps.getPhotoOriginal(claims.id, claims.org)
      : await deps.getAssetOriginal(claims.id, claims.org);
    if (!file) {
      res.status(404).json({ error: claims.kind === "photo" ? "Photo not found" : "Asset not found" });
      return;
    }
    sendOriginal(res, file);
  });

  // Connector auth: either `Authorization: Bearer <token>`, or the token as the
  // first path segment (`/<token>/mcp`). The URL form exists because claude.ai's
  // and ChatGPT's connector UIs only accept a URL — no header field. Over HTTPS
  // the path is encrypted in transit; treat that URL itself as a secret.
  app.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    void (async () => {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        const resolved = await deps.resolveCredential(header.slice("Bearer ".length));
        if (resolved) {
          req.mcpOrgId = resolved.organizationId;
          req.mcpParent = resolved.parent;
          next();
          return;
        }
      }
      const segments = req.path.split("/").filter(Boolean);
      if (segments.length > 0) {
        let candidate: string | null = null;
        try {
          candidate = decodeURIComponent(segments[0]);
        } catch {
          candidate = null;
        }
        const resolved = candidate ? await deps.resolveCredential(candidate) : null;
        if (resolved) {
          const rest = req.url.replace(`/${segments[0]}`, "") || "/";
          // Token-in-path is only for the MCP endpoint itself. Media links that
          // carried the connector token are retired (#204): they were a
          // reusable credential, so they are not served even for a valid token.
          if (!/^\/mcp\/?(\?|$)/.test(rest)) {
            res.status(410).json({
              error: "Links containing a connector token are retired; call get_photo or get_asset again for a fresh media link",
            });
            return;
          }
          req.mcpOrgId = resolved.organizationId;
          req.mcpParent = resolved.parent;
          req.url = rest;
          next();
          return;
        }
      }
      res.status(401).json({ error: "Unauthorized" });
    })().catch(next);
  });

  // Stateless streamable HTTP: a fresh server+transport pair per request.
  // Tools-only usage needs no session affinity, and statelessness survives
  // process restarts without breaking connected clients.
  app.post("/mcp", async (req: AuthedRequest, res: Response) => {
    // Media links are disposable per-object grants tied to this request's org
    // and credential; the credential itself never appears in them.
    const mediaLinks = publicUrl && req.mcpOrgId != null && req.mcpParent
      ? createMediaLinkIssuer({ publicUrl, organizationId: req.mcpOrgId, parent: req.mcpParent, keys: deps.keys, nowMs: now() })
      : undefined;
    // Every tool is scoped to the token's org (#113 Phase 5).
    const server = deps.createMcpServer({ mediaLinks, organizationId: req.mcpOrgId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal server error" },
        });
      }
      console.error(`[${randomUUID().slice(0, 8)}] MCP request failed:`, err instanceof Error ? err.message : "unknown error");
    }
  });

  // Stateless mode has no sessions to GET/DELETE.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed: stateless transport (POST only)" },
    });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Header-authenticated media for clients that fetch with their own
  // `Authorization: Bearer` header. No credential rides in these URLs, and the
  // token-in-path form of them is refused above.
  app.get("/photo/:id/original", async (req: AuthedRequest, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid photo id" });
      return;
    }
    const file = await deps.getPhotoOriginal(id, req.mcpOrgId);
    if (!file) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    sendOriginal(res, file);
  });

  app.get("/photo/:id/thumbnail", async (req: AuthedRequest, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid photo id" });
      return;
    }
    const file = await deps.getPhotoThumbnail(id, req.mcpOrgId);
    if (!file) {
      res.status(404).json({ error: "Thumbnail not found" });
      return;
    }
    sendThumbnail(res, file);
  });

  app.get("/asset/:id/original", async (req: AuthedRequest, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid asset id" });
      return;
    }
    const file = await deps.getAssetOriginal(id, req.mcpOrgId);
    if (!file) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    sendOriginal(res, file);
  });

  // Last-resort handler: generic body, and never log the URL (it may carry a
  // connector token or a media grant).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${randomUUID().slice(0, 8)}] MCP gateway error:`, err instanceof Error ? err.message : "unknown error");
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
