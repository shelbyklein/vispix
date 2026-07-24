import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { asc } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { getOriginalFile, getThumbnailFile } from "./photoLibrary.js";
import { getAssetFile } from "./assetLibrary.js";
import { verifyMcpToken } from "@workspace/api-server/src/lib/mcpTokens";

function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startHttpServer(): Promise<void> {
  // Admin-managed DB tokens are the primary auth; MCP_AUTH_TOKEN is an
  // optional break-glass/bootstrap token (e.g. before any DB token exists).
  const envToken = process.env.MCP_AUTH_TOKEN && process.env.MCP_AUTH_TOKEN.length >= 24
    ? process.env.MCP_AUTH_TOKEN
    : null;

  // The break-glass env token isn't tied to an org; scope it to the default
  // (lowest-id) org so it still only exposes one tenant's library.
  async function defaultOrgId(): Promise<number | null> {
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).orderBy(asc(organizationsTable.id)).limit(1);
    return org?.id ?? null;
  }

  // Resolve a candidate token to the org it grants access to (#113 Phase 5), or
  // null when the token is invalid.
  async function resolveTokenOrg(candidate: string): Promise<number | null> {
    if (envToken && tokenMatches(candidate, envToken)) return defaultOrgId();
    const verified = await verifyMcpToken(candidate, Date.now());
    return verified ? verified.organizationId : null;
  }

  const port = Number(process.env.MCP_HTTP_PORT) || 8086;
  // Public base for download links returned by get_photo, e.g.
  // https://mcp.vispix.dev — token prefix is appended here.
  const publicUrl = process.env.MCP_PUBLIC_URL?.replace(/\/$/, "");

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Unauthenticated liveness probe (no library data).
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Auth: either `Authorization: Bearer <token>`, or the token as the first
  // path segment (`/<token>/mcp`). The URL form exists because claude.ai's
  // custom-connector UI only accepts a URL — no header field. Over HTTPS the
  // path is encrypted in transit; treat the URL itself as a secret.
  app.use((req: Request & { mcpToken?: string; mcpOrgId?: number }, res: Response, next: NextFunction) => {
    void (async () => {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        const candidate = header.slice("Bearer ".length);
        const orgId = await resolveTokenOrg(candidate);
        if (orgId != null) {
          req.mcpToken = candidate;
          req.mcpOrgId = orgId;
          next();
          return;
        }
      }
      const segments = req.path.split("/").filter(Boolean);
      if (segments.length > 0) {
        const candidate = decodeURIComponent(segments[0]);
        const orgId = await resolveTokenOrg(candidate);
        if (orgId != null) {
          // Strip the token segment from the path the router sees; keep the
          // raw token so get_photo download links can embed it (openable URLs).
          req.mcpToken = candidate;
          req.mcpOrgId = orgId;
          req.url = req.url.replace(`/${segments[0]}`, "") || "/";
          next();
          return;
        }
      }
      res.status(401).json({ error: "Unauthorized" });
    })();
  });

  // Stateless streamable HTTP: a fresh server+transport pair per request.
  // Tools-only usage needs no session affinity, and statelessness survives
  // process restarts without breaking connected clients.
  app.post("/mcp", async (req: Request & { mcpToken?: string; mcpOrgId?: number }, res: Response) => {
    // Download links carry the same token that authenticated this request, so
    // they're openable by the caller (the storage-signed URLs are local-only).
    const externalDownloadBase = publicUrl && req.mcpToken ? `${publicUrl}/${req.mcpToken}` : undefined;
    // Every tool is scoped to the token's org (#113 Phase 5).
    const server = createServer({ externalDownloadBase, organizationId: req.mcpOrgId });
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
      console.error(`[${randomUUID().slice(0, 8)}] MCP request failed:`, err);
    }
  });

  // Stateless mode has no sessions to GET/DELETE.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed: stateless transport (POST only)" },
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed: stateless transport (POST only)" },
    });
  });

  // Authenticated full-resolution download — what get_photo's link points at
  // when MCP_PUBLIC_URL is set.
  app.get("/photo/:id/original", async (req: Request & { mcpOrgId?: number }, res: Response) => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid photo id" });
      return;
    }
    const file = await getOriginalFile(id, req.mcpOrgId);
    if (!file) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/[^\w .-]+/g, "")}"`);
    res.send(file.buffer);
  });

  // Authenticated thumbnail — the lightweight preview linked from
  // search_photos / get_photo results, so clients can embed or display a
  // small image without downloading the full-resolution original.
  app.get("/photo/:id/thumbnail", async (req: Request & { mcpOrgId?: number }, res: Response) => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid photo id" });
      return;
    }
    const file = await getThumbnailFile(id, req.mcpOrgId);
    if (!file) {
      res.status(404).json({ error: "Thumbnail not found" });
      return;
    }
    // Thumbnails are always JPEG (api-server thumbnailGeneration.ts), so serve an
    // authoritative image/jpeg + .jpg name — this is the correct-Content-Type
    // guarantee behind the resource_link previews (#174), independent of whatever
    // the stored object's GCS metadata happens to say.
    const jpgName = file.filename.replace(/\.[^./\\]+$/, "").replace(/[^\w .-]+/g, "") + ".jpg";
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${jpgName}"`);
    res.send(file.buffer);
  });

  // Authenticated asset download — what get_asset's link points at when
  // MCP_PUBLIC_URL is set.
  app.get("/asset/:id/original", async (req: Request & { mcpOrgId?: number }, res: Response) => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid asset id" });
      return;
    }
    const file = await getAssetFile(id, req.mcpOrgId);
    if (!file) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${file.filename.replace(/[^\w .-]+/g, "")}"`);
    res.send(file.buffer);
  });

  await new Promise<void>((resolve) => {
    app.listen(port, () => resolve());
  });
  console.error(`Vispix MCP HTTP server listening on :${port} (public URL: ${publicUrl ?? "unset"})`);
}
