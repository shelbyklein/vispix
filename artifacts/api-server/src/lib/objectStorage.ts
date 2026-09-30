import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID, generateKeyPairSync } from "crypto";
import { getObjectAclPolicy } from "./objectAcl";

// When GCS_ENDPOINT is set (local dev against fake-gcs-server), getSignedUrl
// still needs signing credentials, but fake-gcs-server never validates
// signatures — so an ephemeral throwaway key generated at boot is enough.
const gcsEndpoint = process.env.GCS_ENDPOINT;

function makeEphemeralSigningCredentials() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    client_email: "fake@local-dev.iam.gserviceaccount.com",
    private_key: privateKey,
  };
}

export const objectStorageClient = gcsEndpoint
  ? new Storage({
      apiEndpoint: gcsEndpoint,
      projectId: "local-dev",
      credentials: makeEphemeralSigningCredentials(),
    })
  : new Storage(); // uses GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC

export function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
        "tool and set PRIVATE_OBJECT_DIR env var."
    );
  }
  return dir;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    return getPrivateObjectDir();
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  // organizationId prefixes the key as orgs/<id>/uploads/<uuid> (#113) so the
  // object path itself carries its tenant, letting the download route enforce
  // membership. Retrieval is transparent — getObjectEntityFile keeps the whole
  // suffix after /objects/ as the entity id.
  // contentType, when given, is signed into the URL: the PUT must send exactly
  // that Content-Type or storage rejects it.
  async getObjectEntityUploadURL(organizationId: number, contentType?: string, maxBytes?: number): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/orgs/${organizationId}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
      contentType,
      maxBytes,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    // Strip the storage host (real GCS, or the local GCS_ENDPOINT emulator)
    // so downstream code only ever sees /bucket/object paths.
    let url: URL;
    try {
      url = new URL(rawPath);
    } catch {
      return rawPath;
    }
    const isGoogleHost = url.origin === "https://storage.googleapis.com";
    const isLocalEndpoint = gcsEndpoint !== undefined && url.origin === new URL(gcsEndpoint).origin;
    if (!isGoogleHost && !isLocalEndpoint) {
      return rawPath;
    }

    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  /**
   * Best-effort delete of an object entity (e.g. a photo original or thumbnail).
   * Swallows ObjectNotFoundError since the caller is cleaning up, not asserting
   * the object exists.
   */
  async deleteObjectEntity(objectPath: string): Promise<void> {
    try {
      const file = await this.getObjectEntityFile(objectPath);
      await file.delete();
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return;
      throw err;
    }
  }

}

export function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

export async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
  contentType,
  maxBytes,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
  /** PUT only: sign the Content-Type header into the URL. */
  contentType?: string;
  /** PUT only: sign `x-goog-content-length-range: 0,<maxBytes>` so GCS refuses larger bodies. */
  maxBytes?: number;
}): Promise<string> {
  const [url] = await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .getSignedUrl({
      version: "v4",
      action: method === "GET" || method === "HEAD" ? "read" : method === "PUT" ? "write" : "delete",
      expires: Date.now() + ttlSec * 1000,
      ...(method === "PUT" && contentType ? { contentType } : {}),
      ...(method === "PUT" && maxBytes != null ? { extensionHeaders: { "x-goog-content-length-range": `0,${maxBytes}` } } : {}),
    });
  return url;
}
