import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { and, asc, eq, or } from "drizzle-orm";
import { db, organizationMembersTable, organizationsTable, photosTable } from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOrgAuth } from "../middlewares/requireOrg";
import { assertUploadAllowed } from "../lib/billing/subscriptions";

// All private object routes require an authenticated user, and additionally
// membership of the org that owns the object (#113). Org-prefixed keys
// (orgs/<id>/…) name their org directly; legacy (unprefixed) keys predate
// org-prefixing and all belong to the default org, so they're gated the same way
// — no object is readable by a non-member of its org.

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Resolve which org an object path belongs to: the prefix's org for
// orgs/<id>/… keys. Unprefixed keys are either derived objects written without
// a prefix (historically, thumbnails — resolved via the photo that references
// the key, so non-default-org thumbnails serve correctly) or true legacy
// objects predating org-prefixing, which all belong to the default org.
async function objectOrgId(wildcardPath: string): Promise<number | null> {
  const m = wildcardPath.match(/^orgs\/(\d+)\//);
  if (m) return Number.parseInt(m[1], 10);

  const key = `/objects/${wildcardPath}`;
  const [owner] = await db
    .select({ organizationId: photosTable.organizationId })
    .from(photosTable)
    .where(or(eq(photosTable.thumbnailKey, key), eq(photosTable.storageKey, key)))
    .limit(1);
  if (owner) return owner.organizationId;

  const [defaultOrg] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .orderBy(asc(organizationsTable.id))
    .limit(1);
  return defaultOrg?.id ?? null;
}

// The caller must belong to the org that owns the object. Returns true when
// access is allowed.
export async function mayAccessObjectPath(userId: number, wildcardPath: string): Promise<boolean> {
  const orgId = await objectOrgId(wildcardPath);
  if (orgId == null) return false;
  const [membership] = await db
    .select({ userId: organizationMembersTable.userId })
    .from(organizationMembersTable)
    .where(and(eq(organizationMembersTable.organizationId, orgId), eq(organizationMembersTable.userId, userId)));
  return Boolean(membership);
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * Requires authentication — only signed-in users may mint upload URLs.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", requireOrgAuth, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    // Photos are still image-only (the register route magic-byte-checks them);
    // this coarse gate also allows fonts for the asset library (#162). Some
    // browsers send fonts as octet-stream, so fall back to the extension.
    const ct = contentType.toLowerCase();
    const isImage = ct.startsWith("image/");
    const isFont =
      ct.startsWith("font/") ||
      /(woff|ttf|otf|sfnt|fontobject|opentype|truetype)/.test(ct) ||
      /\.(ttf|otf|woff2?|eot)$/i.test(name ?? "");
    if (!isImage && !isFont) {
      res.status(400).json({ error: "Only image and font files are allowed" });
      return;
    }

    // Storage-quota pre-flight (#118): refuse to mint an upload URL when the
    // file would cross the org's plan cap, so over-cap bytes never reach storage.
    // The register route (POST /albums/:id/photos) re-checks authoritatively.
    const quota = await assertUploadAllowed(req.org!, size ?? 0);
    if (!quota.allowed) {
      res.status(402).json({
        error: "Storage limit reached — upgrade your plan to add more photos.",
        code: "storage_limit_exceeded",
        usageBytes: quota.usageBytes,
        capBytes: quota.capBytes,
        plan: req.org!.plan,
      });
      return;
    }

    // Key the upload under the caller's active org (#113).
    let uploadURL = await objectStorageService.getObjectEntityUploadURL(req.org!.id);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    // In local dev the browser can't PUT cross-origin to fake-gcs-server, so
    // rewrite the signed URL onto the web app's same-origin proxy prefix
    // (see the /gcs proxy in photo-album/vite.config.ts). Server-side callers
    // like thumbnail generation keep using absolute signed URLs.
    const browserPrefix = process.env.GCS_BROWSER_UPLOAD_PREFIX;
    if (browserPrefix) {
      const parsedUrl = new URL(uploadURL);
      uploadURL = `${browserPrefix}${parsedUrl.pathname}${parsedUrl.search}`;
    }

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;

    // Tenant ACL (#113): an org-prefixed object is only served to a member of
    // that org. 404 (not 403) so a non-member can't probe which keys exist.
    if (!(await mayAccessObjectPath(req.dbUser!.id, wildcardPath))) {
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    // Storage keys are content-addressed — once written they never change.
    // Cache aggressively so browsers never re-download the same thumbnail/photo.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
