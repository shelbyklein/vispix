import { describe, it, expect, beforeAll } from "vitest";

// The upload URL must bind its Content-Type (GHSA-m962-7g6v-rff3): a V4 signed
// URL lists the headers it covers in X-Goog-SignedHeaders, and storage rejects
// a PUT whose covered headers differ. Uses the real @google-cloud/storage signer
// with the local ephemeral key (GCS_ENDPOINT set), so no network is involved.
let signObjectURL: typeof import("../objectStorage").signObjectURL;
let service: InstanceType<typeof import("../objectStorage").ObjectStorageService>;

beforeAll(async () => {
  process.env.GCS_ENDPOINT = "http://127.0.0.1:1";
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  const mod = await import("../objectStorage");
  signObjectURL = mod.signObjectURL;
  service = new mod.ObjectStorageService();
});

function signedHeaders(url: string): string[] {
  return (new URL(url).searchParams.get("X-Goog-SignedHeaders") ?? "").split(";");
}

describe("signed upload URLs", () => {
  it("cover content-type when a type is given", async () => {
    const url = await signObjectURL({ bucketName: "b", objectName: "o", method: "PUT", ttlSec: 60, contentType: "image/jpeg" });
    expect(signedHeaders(url)).toContain("content-type");
  });

  it("don't cover content-type without one (server-side PUTs unchanged)", async () => {
    const url = await signObjectURL({ bucketName: "b", objectName: "o", method: "PUT", ttlSec: 60 });
    expect(signedHeaders(url)).not.toContain("content-type");
  });

  it("cover the content-length range when a size limit is given (audit #8)", async () => {
    const url = await signObjectURL({ bucketName: "b", objectName: "o", method: "PUT", ttlSec: 60, contentType: "image/jpeg", maxBytes: 5000 });
    expect(signedHeaders(url)).toEqual(expect.arrayContaining(["content-type", "x-goog-content-length-range"]));
    const unbounded = await signObjectURL({ bucketName: "b", objectName: "o", method: "PUT", ttlSec: 60, contentType: "image/jpeg" });
    expect(signedHeaders(unbounded)).not.toContain("x-goog-content-length-range");
  });

  it("the browser upload URL for an org is keyed under the org and bound to the type", async () => {
    const url = await service.getObjectEntityUploadURL(42, "font/woff2");
    expect(new URL(url).pathname).toMatch(/^\/test-bucket\/private\/orgs\/42\/uploads\/[0-9a-f-]{36}$/);
    expect(signedHeaders(url)).toContain("content-type");
  });
});
