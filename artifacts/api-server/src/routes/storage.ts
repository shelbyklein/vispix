import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { and, eq } from "drizzle-orm";
import { isAllowedUploadType, safeObjectHeaders, MAX_UPLOAD_BYTES, uploadLengthRangeSigningEnabled } from "../lib/storageKeys";
import { db, organizationMembersTable, photosTable } from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getDefaultOrgId } from "../lib/defaultOrg";
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

  // Only server-written legacy thumbnails are resolved through the photo that
  // references them (thumbnail keys are never client-supplied); any other
  // unprefixed key is a pre-tenancy object of the default org.
  if (wildcardPath.startsWith("thumbnails/")) {
    const key = `/objects/${wildcardPath}`;
    const [owner] = await db
      .select({ organizationId: photosTable.organizationId })
      .from(photosTable)
      .where(eq(photosTable.thumbnailKey, key))
      .limit(1);
    if (owner) return owner.organizationId;
  }

  return getDefaultOrgId();
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

    // Images, plus fonts for the asset library (#162); photos stay image-only
    // via the register route's magic-byte check. Exact types only (see
    // isAllowedUploadType) — the type is signed into the upload URL below.
    if (!isAllowedUploadType(name ?? "", contentType)) {
      res.status(400).json({ error: "Only image and font files are allowed" });
      return;
    }
    if (size > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: `Files are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`, code: "file_too_large", maxBytes: MAX_UPLOAD_BYTES });
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

    // Key the upload under the caller's active org (#113), and bind the declared
    // type (and, when enabled, the declared size) into the signature so the PUT
    // can't store something else. The client sends exactly `uploadHeaders`.
    const signLength = uploadLengthRangeSigningEnabled();
    let uploadURL = await objectStorageService.getObjectEntityUploadURL(req.org!.id, contentType, signLength ? size : undefined);
    const uploadHeaders: Record<string, string> = { "Content-Type": contentType };
    if (signLength) uploadHeaders["x-goog-content-length-range"] = `0,${size}`;
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
        uploadHeaders,
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
    for (const [key, value] of Object.entries(safeObjectHeaders(response.headers.get("content-type")))) {
      res.setHeader(key, value);
    }

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
    // Never let a stored object run as a page on our origin: only raster images
    // inline, everything else an attachment, always sandboxed.
    for (const [key, value] of Object.entries(safeObjectHeaders(response.headers.get("content-type")))) {
      res.setHeader(key, value);
    }

    // Storage keys are content-addressed — once written they never change.
    // Cache aggressively in the browser, but never in shared caches: these
    // objects are access-controlled.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");

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
