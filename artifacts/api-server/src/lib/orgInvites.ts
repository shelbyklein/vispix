import { eq, inArray, sql } from "drizzle-orm";
import { db, user as authUser, usersTable, organizationInvitesTable, organizationMembersTable } from "@workspace/db";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Add a user to every organization that invited their email address, and
 * consume those invites. Only a verified address counts — an invite is proof
 * of nothing until the invitee has shown they own the mailbox. Returns the
 * organizations joined.
 *
 * Runs on first sign-in (requireAuth provisioning), on every sign-in (the
 * Better Auth session hook) and when the app loads the user's organizations,
 * so someone who already has an account joins the next time they sign in or
 * open Vispix.
 */
export async function acceptPendingInvites(
  executor: Executor,
  member: { userId: number; email: string | null | undefined; emailVerified: boolean | null | undefined },
): Promise<number[]> {
  if (!member.emailVerified || !member.email) return [];
  const emailKey = member.email.trim().toLowerCase();
  const invites = await executor.select().from(organizationInvitesTable).where(eq(organizationInvitesTable.email, emailKey));
  if (invites.length === 0) return [];
  await executor
    .insert(organizationMembersTable)
    .values(invites.map((i) => ({ organizationId: i.organizationId, userId: member.userId, role: i.role })))
    .onConflictDoNothing();
  await executor.delete(organizationInvitesTable).where(inArray(organizationInvitesTable.id, invites.map((i) => i.id)));
  return invites.map((i) => i.organizationId);
}

/** acceptPendingInvites for an app user, reading the verified address from their auth account. */
export async function acceptPendingInvitesForAuthUser(authUserId: string): Promise<number[]> {
  const [row] = await db
    .select({ userId: usersTable.id, email: authUser.email, emailVerified: authUser.emailVerified })
    .from(usersTable)
    .innerJoin(authUser, eq(authUser.id, usersTable.authUserId))
    .where(eq(usersTable.authUserId, authUserId));
  if (!row) return []; // not provisioned yet: requireAuth handles first sign-in
  return acceptPendingInvites(db, row);
}

/** Whether an auth account already exists for this address (the invite email then says "sign in"). */
export async function hasAccount(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(sql`lower(${authUser.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return !!row;
}
