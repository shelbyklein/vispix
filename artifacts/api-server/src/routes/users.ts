import { Router, type IRouter } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  ListUsersResponse,
  GetMeResponse,
  UpdateNavOrderBody,
  UpdateNavOrderResponse,
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  UpdateUserRoleResponse,
  DeleteUserBody,
  DeleteUserResponse,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { DeletionBlockedError, deleteUserAccount } from "../lib/platformDeletion";

const router: IRouter = Router();

router.get("/users/me", requireAuth, async (req, res): Promise<void> => {
  res.json(GetMeResponse.parse(req.dbUser));
});

router.patch("/users/me/nav-order", requireAuth, async (req, res): Promise<void> => {
  const body = UpdateNavOrderBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ navOrder: body.data.navOrder })
    .where(eq(usersTable.id, req.dbUser!.id))
    .returning();

  res.json(UpdateNavOrderResponse.parse(user));
});

router.get("/users", requireAdmin, async (req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  res.json(ListUsersResponse.parse(users));
});

router.patch("/users/:id/role", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateUserRoleParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateUserRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (existing.role === "admin" && body.data.role !== "admin") {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), ne(usersTable.id, params.data.id)));
    if (count === 0) {
      res.status(400).json({ error: "Cannot remove the last admin" });
      return;
    }
  }

  const [user] = await db
    .update(usersTable)
    .set({ role: body.data.role })
    .where(eq(usersTable.id, params.data.id))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateUserRoleResponse.parse(user));
});

// DELETE /users/:id — permanently remove an account (issue #196). The content
// they created in each org is handed to a surviving member first (see
// platformDeletion), so this removes the person, not the org's library. The
// body must echo their email; the guards (self, last platform admin, sole
// member of an org) live in the lib and come back as 400/409.
router.delete("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userId = Number.parseInt(raw, 10);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const body = DeleteUserBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (body.data.confirm !== existing.email) {
    res.status(400).json({ error: "Type the user's email address to confirm" });
    return;
  }

  try {
    const summary = await deleteUserAccount(userId, { actingUserId: req.dbUser!.id });
    res.json(DeleteUserResponse.parse(summary));
  } catch (err) {
    if (err instanceof DeletionBlockedError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
