import { Router, type IRouter } from "express";
import { isOrgUploadKey } from "../lib/storageKeys";
import { and, asc, eq, ne } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  organizationInvitesTable,
  usersTable,
} from "@workspace/db";
import { count as sqlCount } from "drizzle-orm";
import {
  ListMyOrganizationsResponse,
  SwitchOrganizationBody,
  SwitchOrganizationResponse,
  CreateOrganizationBody,
  CreateOrganizationResponse,
  ListOrgMembersResponse,
  UpdateOrgMemberRoleBody,
  ListOrgInvitesResponse,
  CreateOrgInviteBody,
  CreateOrgInviteResponse,
  OrgDetailsResponse,
  UpdateOrgBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOrgAuth, requireOrgRole } from "../middlewares/requireOrg";
import { sendEmail, appUrl, adminAlertEmail } from "../lib/email";
import { orgInviteEmail, adminNewOrgEmail } from "../lib/email/templates";
import { acceptPendingInvitesForAuthUser, hasAccount } from "../lib/orgInvites";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Member/invite management is owner/admin-only, scoped to the active org.
const requireOrgAdmin = [requireOrgAuth, requireOrgRole("owner", "admin")] as const;

// Count remaining owners in an org excluding one user — used to refuse removing
// or demoting the last owner (which would orphan the org).
async function otherOwnerCount(organizationId: number, excludeUserId: number): Promise<number> {
  const rows = await db
    .select({ userId: organizationMembersTable.userId })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.organizationId, organizationId),
        eq(organizationMembersTable.role, "owner"),
        ne(organizationMembersTable.userId, excludeUserId),
      ),
    );
  return rows.length;
}

// Turn an org name into a URL-safe slug. Uniqueness is resolved by the caller
// (appends -2, -3, … on collision).
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "org";
}

async function uniqueSlug(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [existing] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, candidate));
    if (!existing) return candidate;
  }
}

// Shared projection: an org the user belongs to, with their role in it.
const myOrgColumns = {
  id: organizationsTable.id,
  name: organizationsTable.name,
  slug: organizationsTable.slug,
  role: organizationMembersTable.role,
  logoKey: organizationsTable.logoKey,
};

// Org logos are plain objects in the member-gated storage (issue #121).
export function orgLogoUrl(logoKey: string | null): string | null {
  return logoKey ? `/api/storage${logoKey}` : null;
}

// GET /organizations — every org the current user belongs to. The web client
// uses this to populate its org switcher; the chosen id goes back as the
// X-Organization-Id header (see requireOrg).
router.get("/organizations", requireAuth, async (req, res): Promise<void> => {
  // Someone already signed in when they were invited joins here, the next
  // time the app loads their organizations (sign-in does the same).
  try {
    await acceptPendingInvitesForAuthUser(req.dbUser!.authUserId);
  } catch (err) {
    req.log.error({ err }, "Failed to accept pending org invites");
  }
  const rows = await db
    .select(myOrgColumns)
    .from(organizationMembersTable)
    .innerJoin(organizationsTable, eq(organizationMembersTable.organizationId, organizationsTable.id))
    .where(eq(organizationMembersTable.userId, req.dbUser!.id))
    .orderBy(asc(organizationMembersTable.createdAt), asc(organizationsTable.id));
  res.json(
    ListMyOrganizationsResponse.parse(
      rows.map(({ logoKey, ...row }) => ({ ...row, logoUrl: orgLogoUrl(logoKey) })),
    ),
  );
});

// POST /organizations — create a new org; the caller becomes its owner and it
// becomes their sticky active org. This is the "no org yet → create one" path
// for a freshly signed-up user (and lets any user spin up another org).
router.post("/organizations", requireAuth, async (req, res): Promise<void> => {
  const body = CreateOrganizationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const name = body.data.name.trim();
  const slug = await uniqueSlug(slugify(name));

  const created = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizationsTable).values({ name, slug }).returning();
    await tx.insert(organizationMembersTable).values({
      organizationId: org.id,
      userId: req.dbUser!.id,
      role: "owner",
    });
    await tx.update(usersTable).set({ lastActiveOrgId: org.id }).where(eq(usersTable.id, req.dbUser!.id));
    return org;
  });

  // Best-effort operator alert; never blocks org creation.
  const alertTo = adminAlertEmail();
  if (alertTo) {
    const { subject, html, text } = adminNewOrgEmail(created.name, req.dbUser!.email);
    sendEmail({ to: alertTo, subject, html, text }).catch((err) =>
      logger.error({ err }, "Failed to send new-org admin alert"),
    );
  }

  res.status(201).json(
    CreateOrganizationResponse.parse({ id: created.id, name: created.name, slug: created.slug, role: "owner", logoUrl: null }),
  );
});

// POST /organizations/switch — persist the sticky active org. Must be a real
// membership; returns 403 otherwise so a client can't pin an org it can't access.
router.post("/organizations/switch", requireAuth, async (req, res): Promise<void> => {
  const body = SwitchOrganizationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [membership] = await db
    .select(myOrgColumns)
    .from(organizationMembersTable)
    .innerJoin(organizationsTable, eq(organizationMembersTable.organizationId, organizationsTable.id))
    .where(
      and(
        eq(organizationMembersTable.userId, req.dbUser!.id),
        eq(organizationMembersTable.organizationId, body.data.organizationId),
      ),
    );

  if (!membership) {
    res.status(403).json({ error: "Not a member of this organization" });
    return;
  }

  await db
    .update(usersTable)
    .set({ lastActiveOrgId: membership.id })
    .where(eq(usersTable.id, req.dbUser!.id));

  res.json(SwitchOrganizationResponse.parse({ ...membership, logoUrl: orgLogoUrl(membership.logoKey) }));
});

// --- Active org details / settings (Phase 4d) ---

// GET /organizations/current — details of the active org. Any member may view.
router.get("/organizations/current", requireOrgAuth, async (req, res): Promise<void> => {
  const org = req.org!;
  const [{ n }] = await db
    .select({ n: sqlCount() })
    .from(organizationMembersTable)
    .where(eq(organizationMembersTable.organizationId, org.id));
  res.json(
    OrgDetailsResponse.parse({
      id: org.id,
      name: org.name,
      slug: org.slug,
      description: org.description,
      createdAt: org.createdAt.toISOString(),
      role: req.orgRole ?? "member",
      memberCount: Number(n),
      logoUrl: orgLogoUrl(org.logoKey),
    }),
  );
});

// PATCH /organizations/current — rename / re-describe / re-logo the active org.
// Slug is immutable (baked into token/handle semantics). Owner/admin only.
router.patch("/organizations/current", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = UpdateOrgBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // Only accept logo keys minted by our own upload flow, never arbitrary paths
  // (mirrors the assets route).
  if (body.data.logoKey != null && !isOrgUploadKey(body.data.logoKey, req.org!.id)) {
    res.status(400).json({ error: "logoKey must be an upload of this organization" });
    return;
  }
  const updates: { name?: string; description?: string | null; logoKey?: string | null } = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.description !== undefined) updates.description = body.data.description === "" ? null : body.data.description;
  if (body.data.logoKey !== undefined) updates.logoKey = body.data.logoKey;

  const [org] = Object.keys(updates).length
    ? await db.update(organizationsTable).set(updates).where(eq(organizationsTable.id, req.org!.id)).returning()
    : [req.org!];

  const [{ n }] = await db
    .select({ n: sqlCount() })
    .from(organizationMembersTable)
    .where(eq(organizationMembersTable.organizationId, org.id));

  res.json(
    OrgDetailsResponse.parse({
      id: org.id,
      name: org.name,
      slug: org.slug,
      description: org.description,
      createdAt: org.createdAt.toISOString(),
      role: req.orgRole ?? "member",
      memberCount: Number(n),
      logoUrl: orgLogoUrl(org.logoKey),
    }),
  );
});

// --- Member + invite management for the active org (Phase 4c, org-admin) ---

router.get("/organizations/members", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      userId: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: organizationMembersTable.role,
      joinedAt: organizationMembersTable.createdAt,
    })
    .from(organizationMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
    .where(eq(organizationMembersTable.organizationId, req.org!.id))
    .orderBy(asc(organizationMembersTable.createdAt));
  res.json(ListOrgMembersResponse.parse(rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }))));
});

router.patch("/organizations/members/:userId", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = Number.parseInt(raw, 10);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "Invalid user id" });
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
    .where(and(eq(organizationMembersTable.organizationId, req.org!.id), eq(organizationMembersTable.userId, userId)));
  if (!existing) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  // Don't demote the org's last owner.
  if (existing.role === "owner" && body.data.role !== "owner" && (await otherOwnerCount(req.org!.id, userId)) === 0) {
    res.status(400).json({ error: "Cannot demote the last owner" });
    return;
  }

  await db
    .update(organizationMembersTable)
    .set({ role: body.data.role })
    .where(and(eq(organizationMembersTable.organizationId, req.org!.id), eq(organizationMembersTable.userId, userId)));
  res.sendStatus(204);
});

router.delete("/organizations/members/:userId", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = Number.parseInt(raw, 10);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const [existing] = await db
    .select({ role: organizationMembersTable.role })
    .from(organizationMembersTable)
    .where(and(eq(organizationMembersTable.organizationId, req.org!.id), eq(organizationMembersTable.userId, userId)));
  if (!existing) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  if (existing.role === "owner" && (await otherOwnerCount(req.org!.id, userId)) === 0) {
    res.status(400).json({ error: "Cannot remove the last owner" });
    return;
  }

  await db
    .delete(organizationMembersTable)
    .where(and(eq(organizationMembersTable.organizationId, req.org!.id), eq(organizationMembersTable.userId, userId)));
  res.sendStatus(204);
});

router.get("/organizations/invites", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: organizationInvitesTable.id,
      email: organizationInvitesTable.email,
      role: organizationInvitesTable.role,
      createdAt: organizationInvitesTable.createdAt,
    })
    .from(organizationInvitesTable)
    .where(eq(organizationInvitesTable.organizationId, req.org!.id))
    .orderBy(asc(organizationInvitesTable.createdAt));
  res.json(ListOrgInvitesResponse.parse(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))));
});

router.post("/organizations/invites", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const body = CreateOrgInviteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const email = body.data.email.trim().toLowerCase();
  const role = body.data.role ?? "member";

  // Already a member? (case-insensitive email match)
  const [alreadyMember] = await db
    .select({ id: usersTable.id })
    .from(organizationMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
    .where(and(eq(organizationMembersTable.organizationId, req.org!.id), eq(usersTable.email, email)));
  if (alreadyMember) {
    res.status(409).json({ error: "That email is already a member" });
    return;
  }

  // Upsert the pending invite (re-inviting updates the role).
  const [invite] = await db
    .insert(organizationInvitesTable)
    .values({ organizationId: req.org!.id, email, role, invitedById: req.dbUser?.id ?? null })
    .onConflictDoUpdate({
      target: [organizationInvitesTable.organizationId, organizationInvitesTable.email],
      set: { role },
    })
    .returning();

  // Email the invitee a join link: sign-in if they already have an account,
  // sign-up otherwise. Either way they join once their verified address signs
  // in (see lib/orgInvites). The invite stands even if the email fails; the
  // response says so, so the inviter can follow up another way.
  const existingAccount = await hasAccount(email);
  const joinUrl = appUrl(`/${existingAccount ? "sign-in" : "sign-up"}?email=${encodeURIComponent(email)}`);
  const inviteMail = orgInviteEmail(req.org!.name, joinUrl, { existingAccount });
  const emailSent = await sendEmail({ to: email, subject: inviteMail.subject, html: inviteMail.html, text: inviteMail.text }).catch(
    (err) => {
      logger.error({ err }, "Failed to send org invite email");
      return false;
    },
  );

  res.status(201).json(
    CreateOrgInviteResponse.parse({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      createdAt: invite.createdAt.toISOString(),
      emailSent,
    }),
  );
});

router.delete("/organizations/invites/:id", ...requireOrgAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid invite id" });
    return;
  }
  await db
    .delete(organizationInvitesTable)
    .where(and(eq(organizationInvitesTable.id, id), eq(organizationInvitesTable.organizationId, req.org!.id)));
  res.sendStatus(204);
});

export default router;
