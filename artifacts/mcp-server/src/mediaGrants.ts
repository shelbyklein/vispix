import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// Media grants (#204): the HTTP gateway's photo/asset links used to embed the
// caller's connector token (`<public>/<token>/photo/42/original`), so any copied
// link was a non-expiring credential for the whole library. A grant is instead a
// signed, self-contained claim set that opens exactly one object:
//
//   <public>/media/<base64url(claims)>.<base64url(HMAC-SHA256)>
//
// Contract (enforced by verifyMediaGrant + the gateway's /media route):
//   - Audience: `aud` is the gateway's public origin (MCP_PUBLIC_URL), so a grant
//     minted by one deployment (e.g. dev) never opens media on another (prod),
//     even when they share a signing secret.
//   - Binding: one organization (`org`), one object (`kind` + `id`) and one
//     representation (`rep`: photo original/thumbnail, asset original). GET/HEAD
//     only; a grant is never accepted as an MCP credential.
//   - Expiry: `exp` (unix seconds), MEDIA_GRANT_TTL_SECONDS after issue; grants
//     claiming a longer life than the TTL (+ skew) are rejected even if signed.
//   - Parent revocation: `par` fingerprints the connector credential that minted
//     it; the gateway re-checks that credential on every fetch, so revoking a
//     token kills its outstanding links immediately.
//   - Key rotation: signed with the current key; verified against current and
//     previous keys (MCP_MEDIA_SIGNING_KEY / MCP_MEDIA_SIGNING_KEY_PREVIOUS).
//   - Cache: responses are `Cache-Control: private, no-store` so revocation and
//     expiry aren't outlived by shared caches.
//   - Legacy: token-in-path media URLs are no longer issued and are answered with
//     410 Gone; `/<token>/mcp` connector auth is unchanged.

export const MEDIA_GRANT_TTL_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const GRANT_VERSION = 1;
const SIGNING_CONTEXT = "vispix-mcp-media-grant.v1";

export type MediaKind = "photo" | "asset";
export type MediaRepresentation = "original" | "thumbnail";

/** The connector credential a grant was minted under (never the raw token). */
export type GrantParent =
  | { type: "db"; id: number; fingerprint: string }
  | { type: "env"; fingerprint: string };

export interface MediaGrantClaims {
  v: typeof GRANT_VERSION;
  aud: string;
  org: number;
  kind: MediaKind;
  id: number;
  rep: MediaRepresentation;
  par: GrantParent;
  exp: number;
}

export interface MediaGrantKeys {
  current: Buffer;
  previous: Buffer[];
  source: "MCP_MEDIA_SIGNING_KEY" | "BETTER_AUTH_SECRET" | "ephemeral";
}

export type GrantVerification =
  | { ok: true; claims: MediaGrantClaims }
  | { ok: false; reason: "malformed" | "signature" | "audience" | "expired" | "lifetime" };

/** A stable, non-reversible fingerprint of a raw connector token. */
export function credentialFingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", SIGNING_CONTEXT, 32));
}

/**
 * Resolve signing keys from the environment. A dedicated MCP_MEDIA_SIGNING_KEY
 * wins; otherwise the key is derived (HKDF, domain-separated) from
 * BETTER_AUTH_SECRET so existing deployments need no new config. With neither,
 * a random per-process key is used: links still work but die on restart.
 */
export function resolveMediaGrantKeys(env: NodeJS.ProcessEnv = process.env): MediaGrantKeys {
  const previous = (env.MCP_MEDIA_SIGNING_KEY_PREVIOUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 32)
    .map(deriveKey);
  const dedicated = env.MCP_MEDIA_SIGNING_KEY?.trim();
  if (dedicated && dedicated.length >= 32) {
    return { current: deriveKey(dedicated), previous, source: "MCP_MEDIA_SIGNING_KEY" };
  }
  const authSecret = env.BETTER_AUTH_SECRET?.trim();
  if (authSecret && authSecret.length >= 16) {
    return { current: deriveKey(authSecret), previous, source: "BETTER_AUTH_SECRET" };
  }
  return { current: randomBytes(32), previous, source: "ephemeral" };
}

function sign(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(`${SIGNING_CONTEXT}.${payload}`).digest();
}

export function signMediaGrant(claims: MediaGrantClaims, keys: MediaGrantKeys): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(keys.current, payload).toString("base64url")}`;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

function isClaims(c: unknown): c is MediaGrantClaims {
  if (!c || typeof c !== "object") return false;
  const x = c as Record<string, unknown>;
  const par = x.par as Record<string, unknown> | undefined;
  const parOk =
    !!par &&
    typeof par.fingerprint === "string" &&
    /^[0-9a-f]{16}$/.test(par.fingerprint) &&
    (par.type === "env" || (par.type === "db" && isPositiveInt(par.id)));
  const repOk = x.kind === "photo" ? x.rep === "original" || x.rep === "thumbnail" : x.kind === "asset" && x.rep === "original";
  return (
    x.v === GRANT_VERSION &&
    typeof x.aud === "string" &&
    isPositiveInt(x.org) &&
    isPositiveInt(x.id) &&
    repOk &&
    parOk &&
    isPositiveInt(x.exp)
  );
}

/**
 * Check a grant's signature, shape, audience and lifetime. Parent-credential
 * liveness and object existence are the caller's (they need the database).
 */
export function verifyMediaGrant(
  grant: string,
  keys: MediaGrantKeys,
  audience: string,
  nowMs: number,
): GrantVerification {
  const parts = grant.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const signedBy = [keys.current, ...keys.previous].some((key) => {
    const expected = sign(key, payload);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!signedBy) return { ok: false, reason: "signature" };

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isClaims(claims)) return { ok: false, reason: "malformed" };
  if (claims.aud !== audience) return { ok: false, reason: "audience" };
  const now = Math.floor(nowMs / 1000);
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (claims.exp > now + MEDIA_GRANT_TTL_SECONDS + CLOCK_SKEW_SECONDS) return { ok: false, reason: "lifetime" };
  return { ok: true, claims };
}

export interface IssuedMediaLink {
  url: string;
  expiresAt: Date;
}

/**
 * Mints grant URLs for one MCP request: every link is scoped to the request's
 * organization and parent credential, and shares one expiry.
 */
export interface MediaLinkIssuer {
  photo(id: number, rep: MediaRepresentation): IssuedMediaLink;
  asset(id: number): IssuedMediaLink;
}

export function createMediaLinkIssuer(opts: {
  publicUrl: string;
  organizationId: number;
  parent: GrantParent;
  keys: MediaGrantKeys;
  nowMs: number;
}): MediaLinkIssuer {
  const exp = Math.floor(opts.nowMs / 1000) + MEDIA_GRANT_TTL_SECONDS;
  const expiresAt = new Date(exp * 1000);
  const link = (kind: MediaKind, id: number, rep: MediaRepresentation): IssuedMediaLink => {
    const grant = signMediaGrant(
      { v: GRANT_VERSION, aud: opts.publicUrl, org: opts.organizationId, kind, id, rep, par: opts.parent, exp },
      opts.keys,
    );
    return { url: `${opts.publicUrl}/media/${grant}`, expiresAt };
  };
  return {
    photo: (id, rep) => link("photo", id, rep),
    asset: (id) => link("asset", id, "original"),
  };
}
