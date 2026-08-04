import { Router, type IRouter } from "express";
import { asc, eq, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  organizationSubscriptionsTable,
  photosTable,
  usersTable,
} from "@workspace/db";
import {
  AdminOrganizationsResponse,
  DeleteOrganizationBody,
  DeleteOrganizationResponse,
  JoinOrganizationResponse,
  ServiceStatusResponse,
  UpdateOrgMemberRoleBody,
  planCapBytes,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAuth";
import { buildServiceStatus } from "../lib/serviceStatus";
import { DeletionBlockedError, deleteOrganizationCascade } from "../lib/platformDeletion";

// Platform superadmin routes (issue #120): the operator's cross-org view.
// requireAdmin only — these deliberately do NOT go through requireOrg, because
// they exist to see every organization, not to act inside one. Acting inside a
// customer org still requires membership (join-on-demand below) so the tenancy
// membership check stays the single wall between orgs.

const router: IRouter = Router();

// GET /admin/organizations — every org with plan, subscription status, member
// roster, photo count, and storage usage. The roster doubles as the per-user
// membership source for the platform Users page.
router.get("/admin/organizations", requireAdmin, async (req, res): Promise<void> => {
  const orgs = await db.select().from(organizationsTable).orderBy(asc(organizationsTable.id));

  const members = await db
    .select({
      organizationId: organizationMembersTable.organizationId,
      userId: organizationMembersTable.userId,
      role: organizationMembersTable.role,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(organizationMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
    .orderBy(asc(organizationMembersTable.createdAt));

  const photoStats = await db
    .select({
      organizationId: photosTable.organizationId,
      photoCount: sql<number>`count(*)::int`,
      usageBytes: sql<number>`coalesce(sum(${photosTable.filesize}), 0)::bigint`,
    })
    .from(photosTable)
    .groupBy(photosTable.organizationId);

  const subs = await db.select().from(organizationSubscriptionsTable);

  const statsByOrg = new Map(photoStats.map((s) => [s.organizationId, s]));
  const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
  const membersByOrg = new Map<number, typeof members>();
  for (const m of members) {
    const list = membersByOrg.get(m.organizationId) ?? [];
    list.push(m);
    membersByOrg.set(m.organizationId, list);
  }

  const me = req.dbUser!;
  const payload = orgs.map((org) => {
    const roster = membersByOrg.get(org.id) ?? [];
    const stats = statsByOrg.get(org.id);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      subscriptionStatus: subByOrg.get(org.id)?.status ?? "inactive",
      memberCount: roster.length,
      photoCount: stats?.photoCount ?? 0,
      usageBytes: Number(stats?.usageBytes ?? 0),
      capBytes: planCapBytes(org.plan),
      createdAt: org.createdAt.toISOString(),
      myRole: roster.find((m) => m.userId === me.id)?.role ?? null,
      members: roster.map(({ userId, name, email, role }) => ({ userId, name, email, role })),
    };
  });

  res.json(AdminOrganizationsResponse.parse(payload));
});

// POST /admin/organizations/:id/join — join-on-demand support access: add the
// calling platform admin to the org as an org-admin. Transparent by design (the
// customer sees them in the member list). Idempotent: an existing membership is
// left untouched (never demotes an owner).
router.post("/admin/organizations/:id/join", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orgId = Number.parseInt(raw, 10);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ error: "Invalid organization id" });
    return;
  }

  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  const me = req.dbUser!;
  const [existing] = await db
    .select({ role: organizationMembersTable.role })
    .from(organizationMembersTable)
    .where(
      sql`${organizationMembersTable.organizationId} = ${orgId} and ${organizationMembersTable.userId} = ${me.id}`,
    );
  if (existing) {
    res.json(JoinOrganizationResponse.parse({ organizationId: orgId, role: existing.role, alreadyMember: true }));
    return;
  }

  // onConflictDoNothing covers the race where a membership appeared between the
  // check and the insert (e.g. a concurrent invite acceptance).
  await db
    .insert(organizationMembersTable)
    .values({ organizationId: orgId, userId: me.id, role: "admin" })
    .onConflictDoNothing();

  res.json(JoinOrganizationResponse.parse({ organizationId: orgId, role: "admin", alreadyMember: false }));
});

// GET /admin/service-status — platform readiness at a glance (issue #122):
// can the deployment actually serve end to end? The org-scoped variant lives
// with the other org admin routes in routes/admin.ts.
router.get("/admin/service-status", requireAdmin, async (req, res): Promise<void> => {
  res.json(ServiceStatusResponse.parse(await buildServiceStatus()));
});

// PATCH /admin/organizations/:id/members/:userId — platform-level org-role
// change: set any member's role in any org (owner/admin/member) without the
// caller needing to be inside that org. Mirrors the org-scoped route's
// last-owner guard so an org can never end up ownerless.
router.patch("/admin/organizations/:id/members/:userId", requireAdmin, async (req, res): Promise<void> => {
  const rawOrg = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawUser = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const orgId = Number.parseInt(rawOrg, 10);
  const userId = Number.parseInt(rawUser, 10);
  if (!Number.isInteger(orgId) || !Number.isInteger(userId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateOrgMemberRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select({ role: organizationMembersTable.role })
    .from(organizationMembersTable)
    .where(
      sql`${organizationMembersTable.organizationId} = ${orgId} and ${organizationMembersTable.userId} = ${userId}`,
    );
  if (!existing) {
    res.status(404).json({ error: "Member not found" });
    return;
  }

  if (existing.role === "owner" && body.data.role !== "owner") {
    const [{ others }] = await db
      .select({ others: sql<number>`count(*)::int` })
      .from(organizationMembersTable)
      .where(
        sql`${organizationMembersTable.organizationId} = ${orgId} and ${organizationMembersTable.userId} <> ${userId} and ${organizationMembersTable.role} = 'owner'`,
      );
    if (others === 0) {
      res.status(400).json({ error: "Cannot demote the last owner" });
      return;
    }
  }

  await db
    .update(organizationMembersTable)
    .set({ role: body.data.role })
    .where(
      sql`${organizationMembersTable.organizationId} = ${orgId} and ${organizationMembersTable.userId} = ${userId}`,
    );
  res.sendStatus(204);
});

// DELETE /admin/organizations/:id — permanently remove an organization and
// everything in it (issue #196). Irreversible: the body must echo the org's
// slug, so deleting takes knowing which org you're deleting, not just its id.
router.delete("/admin/organizations/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orgId = Number.parseInt(raw, 10);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ error: "Invalid organization id" });
    return;
  }

  const body = DeleteOrganizationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }
  if (body.data.confirm !== org.slug) {
    res.status(400).json({ error: `Type the organization's slug ("${org.slug}") to confirm` });
    return;
  }

  try {
    const summary = await deleteOrganizationCascade(orgId);
    res.json(DeleteOrganizationResponse.parse(summary));
  } catch (err) {
    if (err instanceof DeletionBlockedError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
