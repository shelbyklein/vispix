import { Router, type IRouter } from "express";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  albumsTable,
  photosTable,
  collectionsTable,
  photoCollectionsTable,
  collectionTagsTable,
  projectsTable,
  attributionTagsTable,
  photoAttributionTagsTable,
  mcpTokensTable,
  organizationMembersTable,
  organizationInvitesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { buildServiceStatus } from "../lib/serviceStatus";
import { countPhotosNeedingAiAnalysis } from "../lib/aiAnalysisBackfill";

const router: IRouter = Router();

// Getting-started checklist signals (#148) — a guided tour of everything the
// app can do. All derived from real data so the steps tick themselves off as
// the user acts; nothing is stored except the per-user dismissal timestamp.
// Any org member may read their org's status.
router.get("/onboarding/status", requireOrgAuth, async (req, res): Promise<void> => {
  const orgId = req.org!.id;

  const exists = async (query: Promise<unknown[]>) => (await query).length > 0;
  const one = sql`1`;

  const [
    hasPhotos,
    hasAlbums,
    hasCollectionPhotos,
    hasSmartCollection,
    hasProject,
    hasCollectionTag,
    hasTaggedPerson,
    hasAttribution,
    hasMcpToken,
    memberRows,
    inviteRows,
    serviceStatus,
    photosNeedingAnalysis,
  ] = await Promise.all([
    exists(db.select({ one }).from(photosTable).where(eq(photosTable.organizationId, orgId)).limit(1)),
    exists(db.select({ one }).from(albumsTable).where(eq(albumsTable.organizationId, orgId)).limit(1)),
    // A photo added to any of this org's collections — the core curation act.
    exists(
      db
        .select({ one })
        .from(photoCollectionsTable)
        .innerJoin(collectionsTable, eq(photoCollectionsTable.collectionId, collectionsTable.id))
        .where(and(eq(collectionsTable.organizationId, orgId), eq(collectionsTable.kind, "collection")))
        .limit(1),
    ),
    // A collection with a semantic smartQuery set (ranked by AI similarity).
    exists(
      db
        .select({ one })
        .from(collectionsTable)
        .where(and(eq(collectionsTable.organizationId, orgId), isNotNull(collectionsTable.smartQuery)))
        .limit(1),
    ),
    exists(db.select({ one }).from(projectsTable).where(eq(projectsTable.organizationId, orgId)).limit(1)),
    // A tag applied to any collection ("categorize" in the app's vocabulary).
    exists(
      db
        .select({ one })
        .from(collectionTagsTable)
        .innerJoin(collectionsTable, eq(collectionTagsTable.collectionId, collectionsTable.id))
        .where(eq(collectionsTable.organizationId, orgId))
        .limit(1),
    ),
    // A photo grouped under a person (person-kind collection with a member).
    exists(
      db
        .select({ one })
        .from(photoCollectionsTable)
        .innerJoin(collectionsTable, eq(photoCollectionsTable.collectionId, collectionsTable.id))
        .where(and(eq(collectionsTable.organizationId, orgId), eq(collectionsTable.kind, "person")))
        .limit(1),
    ),
    // A photo with usage rights recorded via an attribution tag.
    exists(
      db
        .select({ one })
        .from(photoAttributionTagsTable)
        .innerJoin(attributionTagsTable, eq(photoAttributionTagsTable.tagId, attributionTagsTable.id))
        .where(eq(attributionTagsTable.organizationId, orgId))
        .limit(1),
    ),
    exists(db.select({ one }).from(mcpTokensTable).where(eq(mcpTokensTable.organizationId, orgId)).limit(1)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationMembersTable)
      .where(eq(organizationMembersTable.organizationId, orgId)),
    db
      .select({ one })
      .from(organizationInvitesTable)
      .where(eq(organizationInvitesTable.organizationId, orgId))
      .limit(1),
    buildServiceStatus({ organizationId: orgId }),
    countPhotosNeedingAiAnalysis(orgId),
  ]);

  const memberCount = Number(memberRows[0]?.n ?? 0);
  const aiConfigured = serviceStatus.services.find((s) => s.key === "ai")?.ok ?? false;

  res.json({
    hasPhotos,
    hasAlbums,
    hasCollectionPhotos,
    hasSmartCollection,
    hasProject,
    hasCollectionTag,
    hasTaggedPerson,
    hasAttribution,
    hasMcpToken,
    aiConfigured,
    // Complete only once there are photos and none still await a description.
    aiAnalysisComplete: hasPhotos && photosNeedingAnalysis === 0,
    memberCount,
    // "Invited a teammate" counts a second member OR a still-pending invite.
    invitedTeammate: memberCount > 1 || inviteRows.length > 0,
    dismissed: req.dbUser!.onboardingDismissedAt != null,
  });
});

// Dismiss the checklist for this user (all orgs, all devices).
router.post("/onboarding/dismiss", requireAuth, async (req, res): Promise<void> => {
  await db
    .update(usersTable)
    .set({ onboardingDismissedAt: new Date() })
    .where(and(eq(usersTable.id, req.dbUser!.id)));
  res.sendStatus(204);
});

export default router;
