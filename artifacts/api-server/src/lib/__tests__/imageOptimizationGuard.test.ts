import { describe, it, expect, vi } from "vitest";

// In-place WebP optimization overwrites the original object, so it must never
// act on another org's key through this org's row (storage follow-ups).
const touched: string[] = [];
vi.mock("../objectStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../objectStorage")>()),
  getPrivateObjectDir: () => "/bucket/private",
  objectStorageClient: {
    bucket: () => ({
      file: (name: string) => {
        touched.push(name);
        return { exists: async () => [false] };
      },
    }),
  },
}));

import { optimizeOriginalImage } from "../imageOptimization";

describe("in-place optimization stays inside the photo's org", () => {
  it("skips another org's object without touching storage", async () => {
    await expect(optimizeOriginalImage(1, "/objects/orgs/7/uploads/abc", 3)).resolves.toBe("skipped");
    expect(touched).toEqual([]);
  });
});
