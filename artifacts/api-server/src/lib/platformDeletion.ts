import {
  db,
  organizationsTable,
  organizationMembersTable,
  organizationSubscriptionsTable,
  photosTable,
  assetsTable,
  albumsTable,
  collectionsTable,
  projectsTable,
  campaignsTable,
  bulkUploadBatchesTable,
  imageGenerationsTable,
  imageGenerationSessionsTable,
  usersTable,
  user as authUserTable,
} from "@workspace/db";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { stripe } from "./stripe";

// Platform-level deletion of organizations and users (issue #196).
//
// Both deletes are irreversible and both are more than a `DELETE` statement:
//
//  - An organization's 22 child tables are ON DELETE CASCADE, so Postgres does
//    the row work. What it does NOT do is remove the objects those rows pointed
//    at (photo originals + thumbnails, assets, generated images, the org logo)
//    or stop the customer's Stripe subscription — both are handled here.
//
//  - A user is the harder case: photos.uploader_id, albums.owner_id and the
//    created_by/user_id columns on collections/projects/campaigns/bulk upload
//    batches/image-gen sessions all CASCADE from `users`. Deleting the row
//    naively would take the org's content with it. So every piece of org-scoped
//    content is first REASSIGNED to a surviving member of that org (preferring
//    an owner), and only then is the user removed. What does die with them is
//    their own personal data — ratings — which is the intent.
//
// Storage deletes honour PHOTO_STORAGE_DELETE_DISABLED for the same reason
// photo deletes do: the dev stack has its own database but shares the prod
// bucket, so a dev org delete must never unlink objects prod rows still use.

const objectStorageService = new ObjectStorageService();

// A refusal the caller should surface verbatim — these are guard rails
// (last owner, last admin, deleting yourself), not unexpected failures.
export class DeletionBlockedError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = "DeletionBlockedError";
  }
}

export type OrgDeletionSummary = {
  organizationId: number;
  name: string;
  slug: string;
  photosDeleted: number;
  membersRemoved: number;
  objectsDeleted: number;
  subscriptionCancelled: boolean;
};

export type UserDeletionSummary = {
  userId: number;
  email: string;
  organizationsAffected: number;
  // orgId → the member content was handed to, so the response can say who.
  reassignedTo: { organizationId: number; organizationName: string; userId: number; name: string }[];
};

function storageDeletesDisabled(): boolean {
  return process.env.PHOTO_STORAGE_DELETE_DISABLED === "true";
}

// Best-effort object purge: failures are logged, never thrown. The DB rows are
// already gone by the time this runs, so a failed unlink leaks an object rather
// than corrupting state — worth a log line, not a failed request.
async function purgeObjects(keys: (string | null)[], context: Record<string, unknown>): Promise<number> {
  if (storageDeletesDisabled()) {
    logger.info({ ...context, keyCount: keys.length }, "Storage purge skipped (PHOTO_STORAGE_DELETE_DISABLED)");
    return 0;
  }
  let deleted = 0;
  for (const key of keys) {
    if (!key) continue;
    try {
      await objectStorageService.deleteObjectEntity(key);
      deleted += 1;
    } catch (err) {
      logger.error({ err, ...context, key }, "Failed to delete storage object");
    }
  }
  return deleted;
}

/**
 * Delete an organization and everything inside it: DB rows (via cascade), the
 * storage objects its rows referenced, and its Stripe subscription.
 */
export async function deleteOrganizationCascade(orgId: number): Promise<OrgDeletionSummary> {
  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) throw new DeletionBlockedError("Organization not found", 404);

  // Collect object keys BEFORE the cascade removes the rows holding them.
  const photos = await db
    .select({ storageKey: photosTable.storageKey, thumbnailKey: photosTable.thumbnailKey })
    .from(photosTable)
    .where(eq(photosTable.organizationId, orgId));
  const assets = await db
    .select({ storageKey: assetsTable.storageKey })
    .from(assetsTable)
    .where(eq(assetsTable.organizationId, orgId));
  const generated = await db
    .select({ storageKey: imageGenerationsTable.storageKey })
    .from(imageGenerationsTable)
    .where(eq(imageGenerationsTable.organizationId, orgId));
  const [{ memberCount }] = await db
    .select({ memberCount: sql<number>`count(*)::int` })
    .from(organizationMembersTable)
    .where(eq(organizationMembersTable.organizationId, orgId));

  const subscriptionCancelled = await cancelOrgSubscription(orgId);

  // One statement; Postgres cascades the 22 org-scoped tables and nulls
  // users.last_active_org_id for anyone whose sticky org this was.
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));

  const keys = [
    ...photos.flatMap((p) => [p.storageKey, p.thumbnailKey]),
    ...assets.map((a) => a.storageKey),
    ...generated.map((g) => g.storageKey),
    org.logoKey,
  ];
  const objectsDeleted = await purgeObjects(keys, { organizationId: orgId });

  logger.info(
    { organizationId: orgId, slug: org.slug, photos: photos.length, objectsDeleted },
    "Organization deleted",
  );

  return {
    organizationId: orgId,
    name: org.name,
    slug: org.slug,
    photosDeleted: photos.length,
    membersRemoved: memberCount,
    objectsDeleted,
    subscriptionCancelled,
  };
}

// Cancel the org's Stripe subscription so deleting the account also stops the
// billing. Best-effort: an unconfigured Stripe or an already-cancelled
// subscription must not block the delete.
async function cancelOrgSubscription(orgId: number): Promise<boolean> {
  const [sub] = await db
    .select()
    .from(organizationSubscriptionsTable)
    .where(eq(organizationSubscriptionsTable.organizationId, orgId));
  const subscriptionId = sub?.stripeSubscriptionId;
  if (!subscriptionId || !stripe) return false;

  try {
    await stripe.subscriptions.cancel(subscriptionId);
    logger.info({ organizationId: orgId, subscriptionId }, "Cancelled Stripe subscription for deleted org");
    return true;
  } catch (err) {
    logger.error({ err, organizationId: orgId, subscriptionId }, "Failed to cancel Stripe subscription");
    return false;
  }
}

/**
 * Delete a user, reassigning every piece of org content they created to a
 * surviving member of that org first (preferring an owner). Their Better Auth
 * identity — and with it every session and credential — goes too.
 */
export async function deleteUserAccount(
  userId: number,
  opts: { actingUserId: number },
): Promise<UserDeletionSummary> {
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!target) throw new DeletionBlockedError("User not found", 404);

  if (userId === opts.actingUserId) {
    throw new DeletionBlockedError("You cannot delete your own account", 400);
  }

  // Never leave the platform without an operator.
  if (target.role === "admin") {
    const [{ others }] = await db
      .select({ others: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), ne(usersTable.id, userId)));
    if (others === 0) {
      throw new DeletionBlockedError("Cannot delete the last platform admin", 400);
    }
  }

  const memberships = await db
    .select({ organizationId: organizationMembersTable.organizationId, role: organizationMembersTable.role })
    .from(organizationMembersTable)
    .where(eq(organizationMembersTable.userId, userId));

  // Resolve a successor per org up front, so a blocked org fails the whole
  // delete before anything has been reassigned.
  const plan: {
    organizationId: number;
    organizationName: string;
    heir: { userId: number; name: string; role: string };
    promoteHeirToOwner: boolean;
  }[] = [];

  for (const membership of memberships) {
    const [org] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, membership.organizationId));

    const candidates = await db
      .select({
        userId: organizationMembersTable.userId,
        role: organizationMembersTable.role,
        name: usersTable.name,
      })
      .from(organizationMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
      .where(
        and(
          eq(organizationMembersTable.organizationId, membership.organizationId),
          ne(organizationMembersTable.userId, userId),
        ),
      )
      .orderBy(asc(organizationMembersTable.createdAt));

    const rank = (role: string) => (role === "owner" ? 0 : role === "admin" ? 1 : 2);
    const heir = [...candidates].sort((a, b) => rank(a.role) - rank(b.role))[0];
    if (!heir) {
      throw new DeletionBlockedError(
        `${target.name} is the only member of "${org?.name ?? "an organization"}". Delete that organization first, or add another member to inherit its content.`,
      );
    }

    plan.push({
      organizationId: membership.organizationId,
      organizationName: org?.name ?? "",
      heir,
      // Removing the last owner would leave the org ownerless, so the heir is
      // promoted — same invariant the role routes' last-owner guard protects.
      promoteHeirToOwner: membership.role === "owner" && heir.role !== "owner",
    });
  }

  await db.transaction(async (tx) => {
    for (const step of plan) {
      const heirId = step.heir.userId;
      const orgId = step.organizationId;

      await tx
        .update(photosTable)
        .set({ uploaderId: heirId })
        .where(and(eq(photosTable.uploaderId, userId), eq(photosTable.organizationId, orgId)));
      await tx
        .update(albumsTable)
        .set({ ownerId: heirId })
        .where(and(eq(albumsTable.ownerId, userId), eq(albumsTable.organizationId, orgId)));
      await tx
        .update(collectionsTable)
        .set({ createdById: heirId })
        .where(and(eq(collectionsTable.createdById, userId), eq(collectionsTable.organizationId, orgId)));
      await tx
        .update(projectsTable)
        .set({ createdById: heirId })
        .where(and(eq(projectsTable.createdById, userId), eq(projectsTable.organizationId, orgId)));
      await tx
        .update(campaignsTable)
        .set({ createdById: heirId })
        .where(and(eq(campaignsTable.createdById, userId), eq(campaignsTable.organizationId, orgId)));
      await tx
        .update(bulkUploadBatchesTable)
        .set({ userId: heirId })
        .where(
          and(eq(bulkUploadBatchesTable.userId, userId), eq(bulkUploadBatchesTable.organizationId, orgId)),
        );
      await tx
        .update(imageGenerationSessionsTable)
        .set({ userId: heirId })
        .where(
          and(
            eq(imageGenerationSessionsTable.userId, userId),
            eq(imageGenerationSessionsTable.organizationId, orgId),
          ),
        );

      if (step.promoteHeirToOwner) {
        await tx
          .update(organizationMembersTable)
          .set({ role: "owner" })
          .where(
            and(
              eq(organizationMembersTable.organizationId, step.organizationId),
              eq(organizationMembersTable.userId, step.heir.userId),
            ),
          );
      }
    }

    // Cascades memberships and the user's own ratings.
    await tx.delete(usersTable).where(eq(usersTable.id, userId));
    // The Better Auth identity is only soft-linked (no FK), so it needs its own
    // delete — it cascades session + account rows, killing any live session.
    await tx.delete(authUserTable).where(eq(authUserTable.id, target.authUserId));
  });

  logger.info(
    { userId, email: target.email, organizations: plan.length },
    "User deleted; org content reassigned",
  );

  return {
    userId,
    email: target.email,
    organizationsAffected: plan.length,
    reassignedTo: plan.map((p) => ({
      organizationId: p.organizationId,
      organizationName: p.organizationName,
      userId: p.heir.userId,
      name: p.heir.name,
    })),
  };
}
