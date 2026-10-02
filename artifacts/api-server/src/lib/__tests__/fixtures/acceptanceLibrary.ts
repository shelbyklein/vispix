/**
 * Deterministic acceptance library (#223, TT-VPX-ACCEPT-02).
 *
 * Builds the same two-organization library in a TEST database every time, with
 * no randomness, no AI provider and no object storage. Used by the journey
 * suites (api-server `acceptanceJourneys.integration.test.ts`, mcp-server
 * `acceptanceScopedReads.integration.test.ts`). Call `resetDb()` first; this
 * file never truncates anything itself.
 *
 * EVIDENCE CLASS: fixture + mocked provider. Embeddings are synthetic unit
 * vectors and the query embedding is a stub (`stubEmbedQuery`), so results
 * prove ranking/scoping/contract behaviour, NOT real-provider relevance.
 *
 * ## Contents
 *
 * People (all platform role "member"; org roles via organization_members):
 *   orgA: ownerA (owner), adminA (admin), memberA (member)
 *   orgB: ownerB (owner), adminB (admin), memberB (member)
 *   outsider: belongs to no organization
 *
 * Organization A ("Acceptance A") - 125 photos, index i = 0..124, 3 albums:
 *   i 0-59   "Nationals 2026"            (also the title of orgB's album)
 *   i 60-94  "Spring Open"
 *   i 95-124 "Practice: Range & Targets" (punctuation in the title)
 *   - filename  `IMG_<i padded to 4>.jpg`, except:
 *       i 3   "Fri-pm (146).webp"       punctuation-rich, unique
 *       i 4   "Smith & Jones - Day 1 (final).jpg"
 *       i 5   "100%_wild.jpg"           LIKE wildcards must stay literal
 *       i 6   "Café-final.png" stored NFD; matches NFC "Café-final"
 *       i 10, i 70, i 100   "dup-name.jpg"  repeated across two albums
 *       i 12  "IMG_0013.jpg" so it duplicates photo 13's name
 *   - takenAt   2026-05-01 + (i % 10) days at 12:00 UTC; null when i % 17 == 16
 *   - createdAt 2026-06-01T12:00Z minus i minutes (distinct, album order = i)
 *   - similarity to the stub query axis: 0.97 - 0.006 * i (strictly falling)
 *   - AI overall score: i%4==0 -> 9, i%4==1 -> 7, i%4==3 -> 3, i%4==2 -> none
 *   - average user rating (ownerA + memberA both rate): i%5==0 -> 5,
 *     else i%7==0 -> 3, else unrated (counts as 0)
 *   - usage rights: "Sponsor OK" on i%6==0, "Editorial Only" on i%10==3,
 *     both on i%30==0, none elsewhere
 *   - hidden: i in {7, 32, 57, 82, 107}
 *   - not embedded (no vector): i in {39, 79, 119}
 *   - people (kind "person" collections): "Jane Archer" i%9==0,
 *     "Sam Rivera" i%11==0
 *   - near-duplicates: none recorded
 * Organization B ("Acceptance B") - 15 photos in "Nationals 2026" (same album
 *   title and person name "Jane Archer"), every one a PERFECT match (similarity
 *   1.0) for the stub query, an own "Sponsor OK" tag and filenames that collide
 *   with orgA's ("Fri-pm (146).webp", "IMG_0001.jpg"). Any leak shows instantly.
 *
 * Brand assets (kind "brand", image/png), project "Spring Open Campaign":
 *   orgA global: "Acceptance Logo" variant primary  [isPrimary]
 *                "Acceptance Logo White" (white), "Acceptance Icon" (icon-only),
 *                "Acceptance Logo Stacked" (stacked), "Primary Logo (old)"
 *                (a decoy whose NAME says primary but is not designated)
 *   orgA project: "Spring Open Logo" [isPrimary for the project],
 *                "Spring Open Logo White"
 *   orgA reference asset: "Last Year Poster"
 *   orgB global: "B Logo" [isPrimary]
 * Project "Spring Open Campaign" (orgA, created by ownerA) starts empty.
 * Project "B Project" (orgB).
 *
 * Provider failure / delay states are driven through `providerControl` and
 * `stubEmbedQuery`, installed with vi.mock("../aiEmbedding", ...) in the suite.
 */
import {
  db,
  photosTable,
  photoEmbeddingsTable,
  photoAiEvaluationsTable,
  ratingsTable,
  attributionTagsTable,
  photoAttributionTagsTable,
  collectionsTable,
  photoCollectionsTable,
  assetsTable,
} from "@workspace/db";
import { createUser, createOrganization, addOrganizationMember, createAlbum, createProject } from "../testDb";

export const DIM = 1408;

export function unit(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}

/** A vector whose cosine similarity to the stub query vector is exactly `s`. */
export const withSimilarity = (s: number) => unit({ 0: s, 1: Math.sqrt(Math.max(0, 1 - s * s)) });

// ---- Provider stub ---------------------------------------------------------

export type ProviderMode = "ok" | "timeout" | "provider_error" | "not_configured";
/** Mutable controls so a test can switch the (mocked) embedding provider state. */
export const providerControl: { mode: ProviderMode; delayMs: number; calls: number } = { mode: "ok", delayMs: 0, calls: 0 };
export function resetProvider() {
  providerControl.mode = "ok";
  providerControl.delayMs = 0;
  providerControl.calls = 0;
}

/** Stand-in for aiEmbedding.embedQuery. Every successful query points along axis 0. */
export async function stubEmbedQuery(
  _q: string,
): Promise<{ ok: true; vec: number[] } | { ok: false; reason: Exclude<ProviderMode, "ok"> }> {
  providerControl.calls += 1;
  if (providerControl.delayMs > 0) await new Promise((r) => setTimeout(r, providerControl.delayMs));
  if (providerControl.mode !== "ok") return { ok: false, reason: providerControl.mode };
  return { ok: true, vec: unit({ 0: 1 }) };
}

// ---- Fixture shape ---------------------------------------------------------

export interface FixtureUser {
  id: number;
  authUserId: string;
}

export interface FixturePhoto {
  id: number;
  orgId: number;
  /** Position in orgA's 0..124 numbering (orgB: 0..14). */
  index: number;
  albumId: number;
  albumTitle: string;
  filename: string;
  takenAt: Date | null;
  createdAt: Date;
  similarity: number;
  /** AI overall score, or null when unevaluated. */
  quality: number | null;
  /** Average user rating; 0 = unrated. */
  rating: number;
  rights: string[];
  people: string[];
  hidden: boolean;
  embedded: boolean;
}

export interface AcceptanceLibrary {
  orgA: number;
  orgB: number;
  ownerA: FixtureUser;
  adminA: FixtureUser;
  memberA: FixtureUser;
  ownerB: FixtureUser;
  adminB: FixtureUser;
  memberB: FixtureUser;
  outsider: FixtureUser;
  albums: { nationals: number; spring: number; practice: number; nationalsB: number };
  photosA: FixturePhoto[];
  photosB: FixturePhoto[];
  tags: { sponsorA: number; editorialA: number; sponsorB: number };
  people: { janeA: number; samA: number; janeB: number };
  projects: { springCampaign: number; projectB: number };
  assets: Record<string, number>;
}

const T_CREATED = Date.parse("2026-06-01T12:00:00Z");
const T_TAKEN = Date.parse("2026-05-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const SPECIAL_FILENAMES: Record<number, string> = {
  3: "Fri-pm (146).webp",
  4: "Smith & Jones - Day 1 (final).jpg",
  5: "100%_wild.jpg",
  6: "Café-final.png",
  10: "dup-name.jpg",
  12: "IMG_0013.jpg",
  70: "dup-name.jpg",
  100: "dup-name.jpg",
};
const HIDDEN = new Set([7, 32, 57, 82, 107]);
const NOT_EMBEDDED = new Set([39, 79, 119]);

function describeA(i: number, albums: { nationals: number; spring: number; practice: number }) {
  if (i < 60) return { albumId: albums.nationals, albumTitle: "Nationals 2026" };
  if (i < 95) return { albumId: albums.spring, albumTitle: "Spring Open" };
  return { albumId: albums.practice, albumTitle: "Practice: Range & Targets" };
}

function specA(i: number, album: { albumId: number; albumTitle: string }, orgId: number): FixturePhoto {
  const quality = [9, 7, null, 3][i % 4];
  const rights: string[] = [];
  if (i % 6 === 0) rights.push("Sponsor OK");
  if (i % 10 === 3 || i % 30 === 0) rights.push("Editorial Only");
  const people: string[] = [];
  if (i % 9 === 0) people.push("Jane Archer");
  if (i % 11 === 0) people.push("Sam Rivera");
  return {
    id: 0,
    orgId,
    index: i,
    ...album,
    filename: SPECIAL_FILENAMES[i] ?? `IMG_${String(i).padStart(4, "0")}.jpg`,
    takenAt: i % 17 === 16 ? null : new Date(T_TAKEN + (i % 10) * DAY),
    createdAt: new Date(T_CREATED - i * 60_000),
    similarity: 0.97 - 0.006 * i,
    quality,
    rating: i % 5 === 0 ? 5 : i % 7 === 0 ? 3 : 0,
    rights,
    people,
    hidden: HIDDEN.has(i),
    embedded: !NOT_EMBEDDED.has(i),
  };
}

async function insertPhotos(specs: FixturePhoto[], uploaderId: number): Promise<void> {
  for (let i = 0; i < specs.length; i += 100) {
    const chunk = specs.slice(i, i + 100);
    const rows = await db
      .insert(photosTable)
      .values(
        chunk.map((p) => ({
          albumId: p.albumId,
          uploaderId,
          organizationId: p.orgId,
          url: `/api/storage/objects/acceptance/${p.orgId}/${p.index}`,
          filename: p.filename,
          takenAt: p.takenAt,
          createdAt: p.createdAt,
          isHidden: p.hidden,
          aiDescription: null,
        })),
      )
      .returning({ id: photosTable.id });
    rows.forEach((r, j) => (chunk[j].id = r.id));
  }
  const embedded = specs.filter((p) => p.embedded);
  await db.insert(photoEmbeddingsTable).values(
    embedded.map((p) => ({ photoId: p.id, organizationId: p.orgId, embedding: withSimilarity(p.similarity), model: "test" })),
  );
  const evaluated = specs.filter((p) => p.quality != null);
  await db.insert(photoAiEvaluationsTable).values(
    evaluated.map((p) => {
      const q = p.quality as number;
      return { photoId: p.id, organizationId: p.orgId, technicalQuality: q, composition: q, subjectClarity: q, emotionalImpact: q, marketingUsability: q, overallScore: q };
    }),
  );
}

export async function buildAcceptanceLibrary(): Promise<AcceptanceLibrary> {
  const orgA = (await createOrganization({ name: "Acceptance A", slug: "acceptance-a" })).id;
  const orgB = (await createOrganization({ name: "Acceptance B", slug: "acceptance-b" })).id;
  const mk = async (name: string, org: number | null, role?: "owner" | "admin" | "member"): Promise<FixtureUser> => {
    const u = await createUser({ name });
    if (org != null && role) await addOrganizationMember(org, u.id, role);
    return { id: u.id, authUserId: u.authUserId };
  };
  const ownerA = await mk("Owen A", orgA, "owner");
  const adminA = await mk("Ada A", orgA, "admin");
  const memberA = await mk("Milo A", orgA, "member");
  const ownerB = await mk("Olga B", orgB, "owner");
  const adminB = await mk("Abe B", orgB, "admin");
  const memberB = await mk("Mia B", orgB, "member");
  const outsider = await mk("Otto Outsider", null);

  const nationals = (await createAlbum(ownerA.id, "Nationals 2026", orgA)).id;
  const spring = (await createAlbum(ownerA.id, "Spring Open", orgA)).id;
  const practice = (await createAlbum(ownerA.id, "Practice: Range & Targets", orgA)).id;
  const nationalsB = (await createAlbum(ownerB.id, "Nationals 2026", orgB)).id;
  const albums = { nationals, spring, practice, nationalsB };

  const photosA = Array.from({ length: 125 }, (_, i) => specA(i, describeA(i, albums), orgA));
  const photosB: FixturePhoto[] = Array.from({ length: 15 }, (_, i) => ({
    id: 0,
    orgId: orgB,
    index: i,
    albumId: nationalsB,
    albumTitle: "Nationals 2026",
    filename: i === 3 ? "Fri-pm (146).webp" : `IMG_${String(i).padStart(4, "0")}.jpg`,
    takenAt: new Date(T_TAKEN + (i % 10) * DAY),
    createdAt: new Date(T_CREATED - i * 60_000),
    similarity: 1,
    quality: 10,
    rating: 5,
    rights: ["Sponsor OK"],
    people: ["Jane Archer"],
    hidden: false,
    embedded: true,
  }));
  await insertPhotos(photosA, ownerA.id);
  await insertPhotos(photosB, ownerB.id);

  // Ratings: ownerA and memberA agree, so the average equals the fixture rating.
  const ratingRows = photosA.filter((p) => p.rating > 0).flatMap((p) => [ownerA, memberA].map((u) => ({ photoId: p.id, userId: u.id, score: p.rating })));
  await db.insert(ratingsTable).values(ratingRows);
  await db.insert(ratingsTable).values(photosB.map((p) => ({ photoId: p.id, userId: ownerB.id, score: 5 })));

  // Usage rights.
  const insertTag = async (org: number, name: string) =>
    (await db.insert(attributionTagsTable).values({ organizationId: org, name }).returning({ id: attributionTagsTable.id }))[0].id;
  const sponsorA = await insertTag(orgA, "Sponsor OK");
  const editorialA = await insertTag(orgA, "Editorial Only");
  const sponsorB = await insertTag(orgB, "Sponsor OK");
  const tagIds: Record<string, number> = { "Sponsor OK": sponsorA, "Editorial Only": editorialA };
  await db.insert(photoAttributionTagsTable).values([
    ...photosA.flatMap((p) => p.rights.map((r) => ({ photoId: p.id, tagId: tagIds[r] }))),
    ...photosB.map((p) => ({ photoId: p.id, tagId: sponsorB })),
  ]);

  // People.
  const person = async (org: number, by: number, title: string) =>
    (await db.insert(collectionsTable).values({ organizationId: org, createdById: by, title, kind: "person" }).returning({ id: collectionsTable.id }))[0].id;
  const janeA = await person(orgA, ownerA.id, "Jane Archer");
  const samA = await person(orgA, ownerA.id, "Sam Rivera");
  const janeB = await person(orgB, ownerB.id, "Jane Archer");
  const personIds: Record<string, number> = { "Jane Archer": janeA, "Sam Rivera": samA };
  await db.insert(photoCollectionsTable).values([
    ...photosA.flatMap((p) => p.people.map((n) => ({ collectionId: personIds[n], photoId: p.id }))),
    ...photosB.map((p) => ({ collectionId: janeB, photoId: p.id })),
  ]);

  // Projects and brand assets.
  const springCampaign = (await createProject(ownerA.id, "Spring Open Campaign", orgA)).id;
  const projectB = (await createProject(ownerB.id, "B Project", orgB)).id;
  const assets: Record<string, number> = {};
  const addAsset = async (key: string, org: number, by: number, v: Partial<typeof assetsTable.$inferInsert>) => {
    const [row] = await db
      .insert(assetsTable)
      .values({
        organizationId: org,
        kind: "brand",
        name: key,
        storageKey: `/objects/orgs/${org}/uploads/acceptance-${key.toLowerCase().replace(/\W+/g, "-")}`,
        contentType: "image/png",
        createdById: by,
        ...v,
      })
      .returning({ id: assetsTable.id });
    assets[key] = row.id;
  };
  await addAsset("Acceptance Logo", orgA, ownerA.id, { variant: "primary", isPrimary: true, notes: "Use on light backgrounds" });
  await addAsset("Acceptance Logo White", orgA, ownerA.id, { variant: "white" });
  await addAsset("Acceptance Icon", orgA, ownerA.id, { variant: "icon-only" });
  await addAsset("Acceptance Logo Stacked", orgA, ownerA.id, { variant: "stacked" });
  await addAsset("Primary Logo (old)", orgA, ownerA.id, { variant: "legacy" });
  await addAsset("Spring Open Logo", orgA, ownerA.id, { projectId: springCampaign, variant: "primary", isPrimary: true });
  await addAsset("Spring Open Logo White", orgA, ownerA.id, { projectId: springCampaign, variant: "white" });
  await addAsset("Last Year Poster", orgA, ownerA.id, { kind: "reference", variant: "poster" });
  await addAsset("B Logo", orgB, ownerB.id, { variant: "primary", isPrimary: true });

  return {
    orgA,
    orgB,
    ownerA,
    adminA,
    memberA,
    ownerB,
    adminB,
    memberB,
    outsider,
    albums,
    photosA,
    photosB,
    tags: { sponsorA, editorialA, sponsorB },
    people: { janeA, samA, janeB },
    projects: { springCampaign, projectB },
    assets,
  };
}

// ---- Independent expectations ---------------------------------------------

/** Non-hidden (or all) orgA photos that have an embedding, in the contract's concept order. */
export function expectedConceptOrder(
  photos: FixturePhoto[],
  weight: number,
  neutral: number,
  pred: (p: FixturePhoto) => boolean = () => true,
): number[] {
  return photos
    .filter((p) => p.embedded && pred(p))
    .map((p) => ({ id: p.id, score: p.similarity * (1 - weight) + ((p.quality ?? neutral) / 10) * weight }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map((p) => p.id);
}
