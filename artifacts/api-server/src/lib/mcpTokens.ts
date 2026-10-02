import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, mcpTokensTable, organizationMembersTable, usersTable } from "@workspace/db";

// Raw tokens look like `tvmcp_<40 hex>`; the prefix stored for display is the
// first 12 chars (`tvmcp_1a2b3`), which leaks nothing useful.
const TOKEN_BYTES = 20;
const PREFIX_LEN = 12;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return `tvmcp_${randomBytes(TOKEN_BYTES).toString("hex")}`;
}

export interface McpTokenListItem {
  id: number;
  label: string;
  tokenPrefix: string;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listMcpTokens(organizationId: number): Promise<McpTokenListItem[]> {
  const rows = await db
    .select({
      id: mcpTokensTable.id,
      label: mcpTokensTable.label,
      tokenPrefix: mcpTokensTable.tokenPrefix,
      createdByName: usersTable.name,
      createdAt: mcpTokensTable.createdAt,
      lastUsedAt: mcpTokensTable.lastUsedAt,
    })
    .from(mcpTokensTable)
    .leftJoin(usersTable, eq(mcpTokensTable.createdById, usersTable.id))
    .where(eq(mcpTokensTable.organizationId, organizationId))
    .orderBy(desc(mcpTokensTable.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    tokenPrefix: r.tokenPrefix,
    createdByName: r.createdByName ?? null,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  }));
}

/** Create a token scoped to an org, returning the raw value ONCE. */
export async function createMcpToken(
  label: string,
  organizationId: number,
  createdById: number | null,
): Promise<{ token: string; item: McpTokenListItem }> {
  const raw = generateRawToken();
  const [row] = await db
    .insert(mcpTokensTable)
    .values({
      organizationId,
      label,
      tokenHash: hashToken(raw),
      tokenPrefix: raw.slice(0, PREFIX_LEN),
      createdById,
    })
    .returning();
  const [createdByName] = createdById
    ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, createdById))
    : [{ name: null }];
  return {
    token: raw,
    item: {
      id: row.id,
      label: row.label,
      tokenPrefix: row.tokenPrefix,
      createdByName: createdByName?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: null,
    },
  };
}

/** Revoke (delete) a token by id, scoped to its org; returns whether removed. */
export async function deleteMcpToken(id: number, organizationId: number): Promise<boolean> {
  const deleted = await db
    .delete(mcpTokensTable)
    .where(and(eq(mcpTokensTable.id, id), eq(mcpTokensTable.organizationId, organizationId)))
    .returning({ id: mcpTokensTable.id });
  return deleted.length > 0;
}

// Throttle last-used writes so a polling client doesn't write per request.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const lastUsedWrites = new Map<number, number>();

// A token acts with its creator's standing in the org: once the creator is no
// longer a member (removed) or the user is deleted (created_by is nulled by the
// FK), the token stops working. Joined at use time so no revocation sweep is
// needed. The break-glass env token has no DB row and is unaffected.
function creatorIsMember() {
  return and(
    eq(organizationMembersTable.organizationId, mcpTokensTable.organizationId),
    eq(organizationMembersTable.userId, mcpTokensTable.createdById),
  );
}

/**
 * Verify a candidate token against the DB. Returns the token's id + the org it
 * grants access to on success (null otherwise; also null when its creator has
 * left the org or been deleted), and best-effort stamps
 * last_used_at (throttled). `nowMs` is injected so the gateway avoids importing
 * Date.now() in hot paths; callers pass Date.now().
 */
export async function verifyMcpToken(
  raw: string,
  nowMs: number,
): Promise<{ id: number; organizationId: number } | null> {
  if (!raw) return null;
  const [row] = await db
    .select({ id: mcpTokensTable.id, organizationId: mcpTokensTable.organizationId })
    .from(mcpTokensTable)
    .innerJoin(organizationMembersTable, creatorIsMember())
    .where(eq(mcpTokensTable.tokenHash, hashToken(raw)))
    .limit(1);
  if (!row) return null;

  const last = lastUsedWrites.get(row.id) ?? 0;
  if (nowMs - last >= LAST_USED_WRITE_INTERVAL_MS) {
    lastUsedWrites.set(row.id, nowMs);
    void db
      .update(mcpTokensTable)
      .set({ lastUsedAt: new Date(nowMs) })
      .where(eq(mcpTokensTable.id, row.id))
      .catch(() => {});
  }
  return { id: row.id, organizationId: row.organizationId };
}

/**
 * Whether the token that minted an MCP media grant (#204) still exists, still
 * belongs to the grant's org, and is the same credential (fingerprint = first 16
 * hex of its SHA-256, i.e. of `token_hash`). Revoking a token therefore kills
 * its outstanding media links on the next fetch. Like verifyMcpToken, a token
 * whose creator left the org or was deleted is no longer live.
 */
export async function isMcpTokenLive(id: number, organizationId: number, fingerprint: string): Promise<boolean> {
  const [row] = await db
    .select({ organizationId: mcpTokensTable.organizationId, tokenHash: mcpTokensTable.tokenHash })
    .from(mcpTokensTable)
    .innerJoin(organizationMembersTable, creatorIsMember())
    .where(eq(mcpTokensTable.id, id))
    .limit(1);
  return !!row && row.organizationId === organizationId && row.tokenHash.slice(0, 16) === fingerprint;
}
