import { type Request, type Response, type NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { db, usersTable, insertUserSchema } from "@workspace/db";
import { acceptPendingInvites } from "../lib/orgInvites";
import { eq, sql } from "drizzle-orm";
import { auth } from "../lib/auth";
import { logger } from "../lib/logger";

// Fixed arbitrary key for the Postgres advisory lock that serializes
// first-sign-in user provisioning (see requireAuth below).
const USER_PROVISION_LOCK_KEY = 72_7001;

declare global {
  namespace Express {
    interface Request {
      dbUser?: typeof usersTable.$inferSelect;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const authUserId = session.user.id;

  let [user] = await db.select().from(usersTable).where(eq(usersTable.authUserId, authUserId));

  if (!user) {
    const name = session.user.name || session.user.email;
    const email = session.user.email;

    try {
      // Serialize concurrent first-sign-in requests (e.g. duplicate requests from
      // one browser tab) so the auth-user-id uniqueness check and the "am I the
      // first user" admin-grant decision are both made atomically.
      user = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USER_PROVISION_LOCK_KEY})`);

        const [existing] = await tx.select().from(usersTable).where(eq(usersTable.authUserId, authUserId));
        if (existing) return existing;

        // First user on a fresh database owns the instance.
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(usersTable);
        const role = count === 0 ? "admin" : "member";
        if (role === "admin") {
          logger.warn({ email }, "First user sign-in: granting admin role");
        }

        const parsed = insertUserSchema.safeParse({ authUserId, name, email, role });
        if (!parsed.success) {
          throw new Error("Failed to create user");
        }
        const [inserted] = await tx.insert(usersTable).values(parsed.data).returning();

        // Auto-join any orgs this (verified) email was invited to (#113 Phase
        // 4c) and consume the invites, so an invited teammate lands in the
        // shared org rather than the "create your own org" screen.
        const joined = await acceptPendingInvites(tx, {
          userId: inserted.id,
          email,
          emailVerified: (session.user as { emailVerified?: boolean }).emailVerified,
        });
        if (joined.length > 0) {
          await tx.update(usersTable).set({ lastActiveOrgId: joined[0] }).where(eq(usersTable.id, inserted.id));
        }
        return inserted;
      });
    } catch (err) {
      logger.error({ err, authUserId }, "Failed to provision user on first sign-in");
      res.status(500).json({ error: "Failed to create user" });
      return;
    }
  }

  req.dbUser = user;
  next();
};

export const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  await requireAuth(req, res, () => {
    if (!req.dbUser) return;
    if (req.dbUser.role !== "admin") {
      res.status(403).json({ error: "Forbidden: admin only" });
      return;
    }
    next();
  });
};
