import { Router, type IRouter } from "express";
import { desc, count, avg, eq, and } from "drizzle-orm";
import {
  db,
  albumsTable,
  photosTable,
  ratingsTable,
  collectionsTable,
  projectsTable,
  organizationMembersTable,
} from "@workspace/db";
import {
  GetDashboardStatsResponse,
  GetRecentPhotosResponse,
  GetTopRatedPhotosResponse,
} from "@workspace/api-zod";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildPhotosResponse, hiddenPhotoCondition } from "../lib/photoHelpers";
import { canSeeHiddenPhotos } from "../lib/capabilities";

const router: IRouter = Router();

router.get("/stats/dashboard", requireOrgAuth, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  const [albumCount, photoCount, memberCount, collectionCount, projectCount, peopleCount] = await Promise.all([
    db.select({ count: count() }).from(albumsTable).where(eq(albumsTable.organizationId, orgId)),
    db.select({ count: count() }).from(photosTable).where(eq(photosTable.organizationId, orgId)),
    // "Users" on the dashboard means members of the active org.
    db.select({ count: count() }).from(organizationMembersTable).where(eq(organizationMembersTable.organizationId, orgId)),
    // People are person-kind collections — count the two kinds separately.
    db.select({ count: count() }).from(collectionsTable).where(and(eq(collectionsTable.organizationId, orgId), eq(collectionsTable.kind, "collection"))),
    db.select({ count: count() }).from(projectsTable).where(eq(projectsTable.organizationId, orgId)),
    db.select({ count: count() }).from(collectionsTable).where(and(eq(collectionsTable.organizationId, orgId), eq(collectionsTable.kind, "person"))),
  ]);

  const recentPhotoRows = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(and(eq(photosTable.organizationId, orgId), hiddenPhotoCondition(canSeeHiddenPhotos(req))))
    .orderBy(desc(photosTable.createdAt))
    .limit(8);

  const recentActivity = await buildPhotosResponse(recentPhotoRows.map((p) => p.id), orgId, req.dbUser?.id);

  res.json(
    GetDashboardStatsResponse.parse({
      totalAlbums: Number(albumCount[0].count),
      totalPhotos: Number(photoCount[0].count),
      totalUsers: Number(memberCount[0].count),
      totalTags: 0,
      totalCollections: Number(collectionCount[0].count),
      totalProjects: Number(projectCount[0].count),
      totalPeople: Number(peopleCount[0].count),
      recentActivity,
    })
  );
});

router.get("/stats/recent-photos", requireOrgAuth, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  const rows = await db
    .select({ id: photosTable.id })
    .from(photosTable)
    .where(and(eq(photosTable.organizationId, orgId), hiddenPhotoCondition(canSeeHiddenPhotos(req))))
    .orderBy(desc(photosTable.createdAt))
    .limit(12);

  const photos = await buildPhotosResponse(rows.map((p) => p.id), orgId, req.dbUser?.id);
  res.json(GetRecentPhotosResponse.parse(photos));
});

router.get("/stats/top-rated", requireOrgAuth, async (req, res): Promise<void> => {
  const orgId = req.org!.id;
  const rows = await db
    .select({
      id: photosTable.id,
      avgRating: avg(ratingsTable.score),
    })
    .from(photosTable)
    .innerJoin(ratingsTable, eq(ratingsTable.photoId, photosTable.id))
    .where(and(eq(photosTable.organizationId, orgId), hiddenPhotoCondition(canSeeHiddenPhotos(req))))
    .groupBy(photosTable.id)
    .orderBy(desc(avg(ratingsTable.score)))
    .limit(12);

  const photos = await buildPhotosResponse(rows.map((p) => p.id), orgId, req.dbUser?.id);
  res.json(GetTopRatedPhotosResponse.parse(photos));
});

export default router;
