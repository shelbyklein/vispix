// Storage is a no-op here: these tests cover the DB half of the deletes, and
// the object purge is best-effort by design. Must be set before the module
// under test is imported, since it reads the flag per call.
process.env.PHOTO_STORAGE_DELETE_DISABLED = "true";

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  organizationsTable,
  organizationMembersTable,
  albumsTable,
  photosTable,
  collectionsTable,
  projectsTable,
  user as authUserTable,
} from "@workspace/db";
import {
  resetDb,
  createUser,
  createOrganization,
  addOrganizationMember,
  createAlbum,
  createPhoto,
  createCollection,
  createProject,
} from "./testDb";
import {
  DeletionBlockedError,
  deleteOrganizationCascade,
  deleteUserAccount,
} from "../platformDeletion";

// Mirrors what Better Auth writes on sign-up: the app `users` row is soft-linked
// to this by authUserId, with no FK, so deletion has to handle it explicitly.
async function createAuthUser(authUserId: string, email: string) {
  await db.insert(authUserTable).values({ id: authUserId, name: authUserId, email });
}

describe("deleteOrganizationCascade", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("removes the org and everything scoped to it", async () => {
    const owner = await createUser();
    const org = await createOrganization({ slug: "doomed" });
    await addOrganizationMember(org.id, owner.id, "owner");
    const album = await createAlbum(owner.id, "Album", org.id);
    await createPhoto(album.id, owner.id, { organizationId: org.id, filesize: 100 });
    await createPhoto(album.id, owner.id, { organizationId: org.id, filesize: 200 });
    await createCollection(owner.id, "Coll", org.id);

    const summary = await deleteOrganizationCascade(org.id);

    expect(summary.photosDeleted).toBe(2);
    expect(summary.membersRemoved).toBe(1);
    expect(summary.subscriptionCancelled).toBe(false);
    expect(await db.select().from(organizationsTable).where(eq(organizationsTable.id, org.id))).toHaveLength(0);
    expect(await db.select().from(photosTable).where(eq(photosTable.organizationId, org.id))).toHaveLength(0);
    expect(await db.select().from(albumsTable).where(eq(albumsTable.organizationId, org.id))).toHaveLength(0);
    expect(
      await db.select().from(organizationMembersTable).where(eq(organizationMembersTable.organizationId, org.id)),
    ).toHaveLength(0);
    // The person survives their organization.
    expect(await db.select().from(usersTable).where(eq(usersTable.id, owner.id))).toHaveLength(1);
  });

  it("leaves other organizations untouched", async () => {
    const owner = await createUser();
    const doomed = await createOrganization({ slug: "doomed" });
    const keeper = await createOrganization({ slug: "keeper" });
    await addOrganizationMember(doomed.id, owner.id, "owner");
    await addOrganizationMember(keeper.id, owner.id, "owner");
    const keeperAlbum = await createAlbum(owner.id, "Keep", keeper.id);
    await createPhoto(keeperAlbum.id, owner.id, { organizationId: keeper.id });

    await deleteOrganizationCascade(doomed.id);

    expect(await db.select().from(organizationsTable).where(eq(organizationsTable.id, keeper.id))).toHaveLength(1);
    expect(await db.select().from(photosTable).where(eq(photosTable.organizationId, keeper.id))).toHaveLength(1);
  });

  it("clears the sticky last-active org of members who were in it", async () => {
    const owner = await createUser();
    const org = await createOrganization({ slug: "sticky" });
    await addOrganizationMember(org.id, owner.id, "owner");
    await db.update(usersTable).set({ lastActiveOrgId: org.id }).where(eq(usersTable.id, owner.id));

    await deleteOrganizationCascade(org.id);

    const [after] = await db.select().from(usersTable).where(eq(usersTable.id, owner.id));
    expect(after.lastActiveOrgId).toBeNull();
  });

  it("404s on an unknown organization", async () => {
    await expect(deleteOrganizationCascade(999999)).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteUserAccount", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reassigns the deleted user's content to a surviving owner", async () => {
    const admin = await createUser({ role: "admin" });
    const owner = await createUser({ name: "Owner" });
    const leaver = await createUser({ name: "Leaver" });
    await createAuthUser(leaver.authUserId, leaver.email);
    const org = await createOrganization({ slug: "shared" });
    await addOrganizationMember(org.id, owner.id, "owner");
    await addOrganizationMember(org.id, leaver.id, "member");

    const album = await createAlbum(leaver.id, "Leaver's album", org.id);
    const photo = await createPhoto(album.id, leaver.id, { organizationId: org.id });
    const collection = await createCollection(leaver.id, "Leaver's collection", org.id);
    const project = await createProject(leaver.id, "Leaver's project", org.id);

    const summary = await deleteUserAccount(leaver.id, { actingUserId: admin.id });

    expect(summary.organizationsAffected).toBe(1);
    expect(summary.reassignedTo[0]).toMatchObject({ organizationId: org.id, userId: owner.id });

    // The content is still there, now owned by the surviving owner.
    const [keptAlbum] = await db.select().from(albumsTable).where(eq(albumsTable.id, album.id));
    const [keptPhoto] = await db.select().from(photosTable).where(eq(photosTable.id, photo.id));
    const [keptCollection] = await db.select().from(collectionsTable).where(eq(collectionsTable.id, collection.id));
    const [keptProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
    expect(keptAlbum.ownerId).toBe(owner.id);
    expect(keptPhoto.uploaderId).toBe(owner.id);
    expect(keptCollection.createdById).toBe(owner.id);
    expect(keptProject.createdById).toBe(owner.id);

    // The person and their sign-in identity are gone.
    expect(await db.select().from(usersTable).where(eq(usersTable.id, leaver.id))).toHaveLength(0);
    expect(await db.select().from(authUserTable).where(eq(authUserTable.id, leaver.authUserId))).toHaveLength(0);
  });

  it("promotes the heir when the deleted user was the only owner", async () => {
    const admin = await createUser({ role: "admin" });
    const owner = await createUser();
    const member = await createUser();
    await createAuthUser(owner.authUserId, owner.email);
    const org = await createOrganization({ slug: "succession" });
    await addOrganizationMember(org.id, owner.id, "owner");
    await addOrganizationMember(org.id, member.id, "member");

    await deleteUserAccount(owner.id, { actingUserId: admin.id });

    const [heir] = await db
      .select()
      .from(organizationMembersTable)
      .where(eq(organizationMembersTable.userId, member.id));
    expect(heir.role).toBe("owner");
  });

  it("prefers an owner over an admin as the heir", async () => {
    const platformAdmin = await createUser({ role: "admin" });
    const orgAdmin = await createUser();
    const orgOwner = await createUser();
    const leaver = await createUser();
    await createAuthUser(leaver.authUserId, leaver.email);
    const org = await createOrganization({ slug: "ranked" });
    // Added first, so a naive "first member" pick would choose the admin.
    await addOrganizationMember(org.id, orgAdmin.id, "admin");
    await addOrganizationMember(org.id, orgOwner.id, "owner");
    await addOrganizationMember(org.id, leaver.id, "member");
    const album = await createAlbum(leaver.id, "A", org.id);

    await deleteUserAccount(leaver.id, { actingUserId: platformAdmin.id });

    const [kept] = await db.select().from(albumsTable).where(eq(albumsTable.id, album.id));
    expect(kept.ownerId).toBe(orgOwner.id);
  });

  it("refuses when the user is the sole member of an organization", async () => {
    const admin = await createUser({ role: "admin" });
    const solo = await createUser({ name: "Solo" });
    const org = await createOrganization({ name: "Solo Org", slug: "solo" });
    await addOrganizationMember(org.id, solo.id, "owner");
    const album = await createAlbum(solo.id, "A", org.id);

    await expect(deleteUserAccount(solo.id, { actingUserId: admin.id })).rejects.toBeInstanceOf(
      DeletionBlockedError,
    );

    // Nothing was reassigned or removed on the way to the refusal.
    expect(await db.select().from(usersTable).where(eq(usersTable.id, solo.id))).toHaveLength(1);
    expect(await db.select().from(albumsTable).where(eq(albumsTable.id, album.id))).toHaveLength(1);
  });

  it("refuses to delete the caller's own account", async () => {
    const admin = await createUser({ role: "admin" });
    await expect(deleteUserAccount(admin.id, { actingUserId: admin.id })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses to delete the last platform admin", async () => {
    const onlyAdmin = await createUser({ role: "admin" });
    const other = await createUser({ role: "member" });
    await expect(deleteUserAccount(onlyAdmin.id, { actingUserId: other.id })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("deletes a user with no organizations", async () => {
    const admin = await createUser({ role: "admin" });
    const orphan = await createUser();
    await createAuthUser(orphan.authUserId, orphan.email);

    const summary = await deleteUserAccount(orphan.id, { actingUserId: admin.id });

    expect(summary.organizationsAffected).toBe(0);
    expect(await db.select().from(usersTable).where(eq(usersTable.id, orphan.id))).toHaveLength(0);
  });

  it("404s on an unknown user", async () => {
    const admin = await createUser({ role: "admin" });
    await expect(deleteUserAccount(999999, { actingUserId: admin.id })).rejects.toMatchObject({
      status: 404,
    });
  });
});
