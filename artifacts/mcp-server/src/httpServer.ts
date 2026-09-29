import { timingSafeEqual } from "node:crypto";
import { asc } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { createServer } from "./server.js";
import { getOriginalFile, getThumbnailFile } from "./photoLibrary.js";
import { getAssetFile } from "./assetLibrary.js";
import { createGatewayApp, type ResolvedCredential } from "./gatewayApp.js";
import { credentialFingerprint, resolveMediaGrantKeys } from "./mediaGrants.js";
import { isMcpTokenLive, verifyMcpToken } from "@workspace/api-server/src/lib/mcpTokens";

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
  const envFingerprint = envToken ? credentialFingerprint(envToken) : null;

  // The break-glass env token isn't tied to an org; scope it to the default
  // (lowest-id) org so it still only exposes one tenant's library.
  async function defaultOrgId(): Promise<number | null> {
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).orderBy(asc(organizationsTable.id)).limit(1);
    return org?.id ?? null;
  }

  // Resolve a candidate token to the org it grants access to (#113 Phase 5) and
  // the parent identity its media grants are bound to (#204), or null when the
  // token is invalid.
  async function resolveCredential(candidate: string): Promise<ResolvedCredential | null> {
    if (envToken && envFingerprint && tokenMatches(candidate, envToken)) {
      const organizationId = await defaultOrgId();
      return organizationId == null ? null : { organizationId, parent: { type: "env", fingerprint: envFingerprint } };
    }
    const verified = await verifyMcpToken(candidate, Date.now());
    if (!verified) return null;
    return {
      organizationId: verified.organizationId,
      parent: { type: "db", id: verified.id, fingerprint: credentialFingerprint(candidate) },
    };
  }

  const port = Number(process.env.MCP_HTTP_PORT) || 8086;
  // Public origin for media links, e.g. https://mcp.vispix.dev. Without it the
  // HTTP tools return no gateway links (signed storage URLs are local-only).
  const publicUrl = process.env.MCP_PUBLIC_URL?.replace(/\/$/, "");
  const keys = resolveMediaGrantKeys();
  if (keys.source === "ephemeral") {
    console.error("MCP media grants: no MCP_MEDIA_SIGNING_KEY or BETTER_AUTH_SECRET; using a per-process key (links end on restart)");
  }

  const app = createGatewayApp({
    publicUrl,
    keys,
    resolveCredential,
    async isGrantParentLive(claims) {
      if (claims.par.type === "env") {
        return envFingerprint === claims.par.fingerprint && (await defaultOrgId()) === claims.org;
      }
      return isMcpTokenLive(claims.par.id, claims.org, claims.par.fingerprint);
    },
    createMcpServer: createServer,
    getPhotoOriginal: getOriginalFile,
    getPhotoThumbnail: getThumbnailFile,
    getAssetOriginal: getAssetFile,
  });

  await new Promise<void>((resolve) => {
    app.listen(port, () => resolve());
  });
  console.error(`Vispix MCP HTTP server listening on :${port} (public URL: ${publicUrl ?? "unset"}; media key: ${keys.source})`);
}
