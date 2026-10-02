import { asc, eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { logger } from "./logger";

let warnedUnpinned = false;

/**
 * The "default org" owns pre-tenancy (unprefixed) object keys and scopes the
 * break-glass MCP env token. Pin it with DEFAULT_ORG_ID (or DEFAULT_ORG_SLUG);
 * unpinned it falls back to the lowest-id org, which silently changes if that
 * org is ever deleted, so we warn once. A pin that matches no org yields null
 * (fail closed) rather than falling back to a different tenant.
 */
export async function getDefaultOrgId(env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const idRaw = env.DEFAULT_ORG_ID?.trim();
  const slug = env.DEFAULT_ORG_SLUG?.trim();

  if (idRaw || slug) {
    const id = idRaw ? Number(idRaw) : null;
    if (idRaw && !Number.isInteger(id)) {
      logger.error({ DEFAULT_ORG_ID: idRaw }, "DEFAULT_ORG_ID is not an integer; no default org");
      return null;
    }
    const [org] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(id != null ? eq(organizationsTable.id, id) : eq(organizationsTable.slug, slug!))
      .limit(1);
    if (!org) logger.error({ DEFAULT_ORG_ID: idRaw, DEFAULT_ORG_SLUG: slug }, "Pinned default org does not exist; no default org");
    return org?.id ?? null;
  }

  if (!warnedUnpinned) {
    warnedUnpinned = true;
    logger.warn("DEFAULT_ORG_ID/DEFAULT_ORG_SLUG not set; defaulting to the lowest-id organization for legacy object keys and the MCP_AUTH_TOKEN break-glass token");
  }
  const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).orderBy(asc(organizationsTable.id)).limit(1);
  return org?.id ?? null;
}
