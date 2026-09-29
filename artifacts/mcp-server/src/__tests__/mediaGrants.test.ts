import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MEDIA_GRANT_TTL_SECONDS,
  createMediaLinkIssuer,
  credentialFingerprint,
  resolveMediaGrantKeys,
  signMediaGrant,
  verifyMediaGrant,
  type MediaGrantClaims,
} from "../mediaGrants.js";

const AUD = "https://mcp.example.test";
const NOW = Date.parse("2026-09-29T00:00:00Z");
const keys = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "k".repeat(40) });
const otherKeys = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "z".repeat(40) });

function claims(overrides: Partial<MediaGrantClaims> = {}): MediaGrantClaims {
  return {
    v: 1,
    aud: AUD,
    org: 1,
    kind: "photo",
    id: 100,
    rep: "original",
    par: { type: "db", id: 11, fingerprint: "0123456789abcdef" },
    exp: Math.floor(NOW / 1000) + MEDIA_GRANT_TTL_SECONDS,
    ...overrides,
  };
}

// Re-encode a grant's payload without re-signing it (an attacker's edit).
function tamper(grant: string, edit: (c: MediaGrantClaims) => MediaGrantClaims): string {
  const [payload, sig] = grant.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MediaGrantClaims;
  return `${Buffer.from(JSON.stringify(edit(decoded))).toString("base64url")}.${sig}`;
}

describe("media grant contract", () => {
  it("round-trips a signed grant with every bound field intact", () => {
    const result = verifyMediaGrant(signMediaGrant(claims(), keys), keys, AUD, NOW);
    expect(result).toEqual({ ok: true, claims: claims() });
  });

  it.each([
    ["organization", (c: MediaGrantClaims) => ({ ...c, org: 2 })],
    ["object id", (c: MediaGrantClaims) => ({ ...c, id: 101 })],
    ["object kind", (c: MediaGrantClaims) => ({ ...c, kind: "asset" as const })],
    ["representation", (c: MediaGrantClaims) => ({ ...c, rep: "thumbnail" as const })],
    ["expiry", (c: MediaGrantClaims) => ({ ...c, exp: c.exp + 60 })],
    ["parent credential", (c: MediaGrantClaims) => ({ ...c, par: { type: "db" as const, id: 12, fingerprint: "0123456789abcdef" } })],
    ["audience", (c: MediaGrantClaims) => ({ ...c, aud: "https://evil.test" })],
  ])("rejects a grant whose %s was altered", (_field, edit) => {
    const altered = tamper(signMediaGrant(claims(), keys), edit);
    expect(verifyMediaGrant(altered, keys, AUD, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a truncated or foreign signature", () => {
    const grant = signMediaGrant(claims(), keys);
    expect(verifyMediaGrant(grant.slice(0, -4), keys, AUD, NOW)).toEqual({ ok: false, reason: "signature" });
    expect(verifyMediaGrant(signMediaGrant(claims(), otherKeys), keys, AUD, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "x."]) {
      expect(verifyMediaGrant(bad, keys, AUD, NOW).ok).toBe(false);
    }
    // Validly signed but not a grant (e.g. an asset thumbnail, which doesn't exist).
    const bogus = signMediaGrant(claims({ kind: "asset", rep: "thumbnail" }), keys);
    expect(verifyMediaGrant(bogus, keys, AUD, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a grant minted for another deployment", () => {
    const grant = signMediaGrant(claims({ aud: "https://mcp-dev.example.test" }), keys);
    expect(verifyMediaGrant(grant, keys, AUD, NOW)).toEqual({ ok: false, reason: "audience" });
  });

  it("expires at exp and refuses lifetimes beyond the TTL", () => {
    const grant = signMediaGrant(claims(), keys);
    const expMs = claims().exp * 1000;
    expect(verifyMediaGrant(grant, keys, AUD, expMs - 1000).ok).toBe(true);
    expect(verifyMediaGrant(grant, keys, AUD, expMs)).toEqual({ ok: false, reason: "expired" });
    const tooLong = signMediaGrant(claims({ exp: Math.floor(NOW / 1000) + 2 * MEDIA_GRANT_TTL_SECONDS }), keys);
    expect(verifyMediaGrant(tooLong, keys, AUD, NOW)).toEqual({ ok: false, reason: "lifetime" });
  });

  it("verifies grants signed with the previous key during rotation, and only then", () => {
    const old = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "o".repeat(40) });
    const rotated = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "n".repeat(40), MCP_MEDIA_SIGNING_KEY_PREVIOUS: "o".repeat(40) });
    const afterRotation = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "n".repeat(40) });
    const grant = signMediaGrant(claims(), old);
    expect(verifyMediaGrant(grant, rotated, AUD, NOW).ok).toBe(true);
    expect(verifyMediaGrant(grant, afterRotation, AUD, NOW)).toEqual({ ok: false, reason: "signature" });
  });
});

describe("signing key resolution", () => {
  it("prefers MCP_MEDIA_SIGNING_KEY, falls back to BETTER_AUTH_SECRET, else ephemeral", () => {
    const both = resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "d".repeat(40), BETTER_AUTH_SECRET: "b".repeat(40) });
    expect(both.source).toBe("MCP_MEDIA_SIGNING_KEY");
    const auth = resolveMediaGrantKeys({ BETTER_AUTH_SECRET: "b".repeat(40) });
    expect(auth.source).toBe("BETTER_AUTH_SECRET");
    expect(auth.current.equals(resolveMediaGrantKeys({ BETTER_AUTH_SECRET: "b".repeat(40) }).current)).toBe(true);
    // Derived, never the raw secret itself.
    expect(auth.current.equals(Buffer.from("b".repeat(40)))).toBe(false);
    const none = resolveMediaGrantKeys({});
    expect(none.source).toBe("ephemeral");
    expect(none.current.equals(resolveMediaGrantKeys({}).current)).toBe(false);
  });

  it("ignores too-short keys", () => {
    expect(resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY: "short" }).source).toBe("ephemeral");
    expect(resolveMediaGrantKeys({ MCP_MEDIA_SIGNING_KEY_PREVIOUS: "short" }).previous).toHaveLength(0);
  });
});

describe("media link issuer", () => {
  it("issues credential-free /media URLs sharing one expiry", () => {
    const token = `tvmcp_${"a".repeat(40)}`;
    const issuer = createMediaLinkIssuer({
      publicUrl: AUD,
      organizationId: 1,
      parent: { type: "db", id: 11, fingerprint: credentialFingerprint(token) },
      keys,
      nowMs: NOW,
    });
    const photo = issuer.photo(100, "original");
    const asset = issuer.asset(300);
    for (const link of [photo, asset]) {
      expect(link.url.startsWith(`${AUD}/media/`)).toBe(true);
      expect(link.url).not.toContain(token);
      expect(link.expiresAt.toISOString()).toBe("2026-09-29T01:00:00.000Z");
    }
  });

  it("fingerprints a credential as the first 16 hex of its SHA-256 (the stored token_hash prefix)", () => {
    const raw = `tvmcp_${"b".repeat(40)}`;
    expect(credentialFingerprint(raw)).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 16));
  });
});

