// Storage key and content-type rules shared by the upload, register and serve
// paths (security hardening, 2026-09-29).

/** Largest object an upload may create (matches the web client's limit). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Whether signed upload URLs bind `x-goog-content-length-range` (audit #8), so
 * GCS itself refuses a PUT outside the declared size. Off by default: browsers
 * must then send that header, and real GCS only allows it cross-origin once
 * the bucket's CORS `responseHeader` lists it (deploy/DEPLOY.md). Registration
 * enforces the real object size either way.
 */
export function uploadLengthRangeSigningEnabled(): boolean {
  return process.env.SIGN_UPLOAD_LENGTH_RANGE === "true";
}

/**
 * Whether a client-supplied key is an upload issued to this organization by
 * POST /storage/uploads/request-url (`/objects/orgs/<org>/uploads/<uuid>`).
 * Register routes (photos, assets, org logo) must only accept these: a row that
 * points at another org's object would let its org read (via thumbnails and
 * MCP), overwrite (optimization) or delete (cleanup, org purge) that object.
 */
export function isOrgUploadKey(key: string, organizationId: number): boolean {
  const prefix = `/objects/orgs/${organizationId}/uploads/`;
  if (!key.startsWith(prefix)) return false;
  return /^[A-Za-z0-9-]+$/.test(key.slice(prefix.length));
}

/**
 * Defense in depth for readers of stored rows: an org-prefixed key must carry
 * the row's own org. Unprefixed keys predate org prefixes (legacy objects) and
 * are allowed through.
 */
export function keyBelongsToOrg(key: string, organizationId: number): boolean {
  return !key.startsWith("/objects/orgs/") || key.startsWith(`/objects/orgs/${organizationId}/`);
}

/** The keys an irreversible storage operation (delete, overwrite) may act on for this org's row. */
export function ownedKeys(keys: (string | null | undefined)[], organizationId: number): { owned: string[]; foreign: string[] } {
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    (keyBelongsToOrg(key, organizationId) ? owned : foreign).push(key);
  }
  return { owned, foreign };
}

const FONT_TYPES = new Set([
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "font/sfnt",
  "font/collection",
  "application/font-woff",
  "application/font-woff2",
  "application/font-sfnt",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/x-font-opentype",
  "application/x-font-truetype",
  "application/vnd.ms-fontobject",
]);
const FONT_EXTENSION = /\.(ttf|otf|woff2?|eot)$/i;

/**
 * Upload gate for presigned URLs: a bare image/* type, a known font type, or
 * application/octet-stream for a font file name (some browsers send fonts that
 * way). Parameters (`;…`) and anything else are refused. The type is then
 * signed into the upload URL, so the PUT must use exactly this type.
 */
export function isAllowedUploadType(name: string, contentType: string): boolean {
  const ct = contentType.trim().toLowerCase();
  if (/^image\/[a-z0-9.+-]+$/.test(ct)) return true;
  if (FONT_TYPES.has(ct)) return true;
  return ct === "application/octet-stream" && FONT_EXTENSION.test(name);
}

const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

/**
 * Headers that stop a stored object from running as a page on our origin:
 * only raster images are served inline; everything else (SVG, fonts, anything
 * mislabelled) is an attachment. Always sandboxed and never sniffed. <img>,
 * CSS fonts and downloads are unaffected by Content-Disposition.
 */
export function safeObjectHeaders(contentType: string | null | undefined): Record<string, string> {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return {
    ...(INLINE_TYPES.has(ct) ? {} : { "Content-Disposition": "attachment" }),
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}
