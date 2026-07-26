/**
 * Unit tests for EXIF date extraction in thumbnail generation.
 *
 * sharp and exif-reader are intentionally NOT mocked — tests run against
 * real JPEG fixture files so that library integration failures surface here
 * rather than silently in production.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PRIVATE_OBJECT_DIR = "/private/test-bucket";

const __testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__testDir, "fixtures");

/** Minimal 2×2 JPEG with EXIF DateTimeOriginal = "2022:03:10 14:45:00" */
const fixtureJpegWithExif = readFileSync(join(fixtureDir, "with-exif.jpg"));
/** Minimal 2×2 JPEG with no EXIF segment */
const fixtureJpegWithoutExif = readFileSync(
  join(fixtureDir, "without-exif.jpg"),
);

const hoisted = vi.hoisted(() => ({
  sourceBuffer: Buffer.alloc(0) as Buffer,
  returning: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
}));

vi.mock("@workspace/db", () => {
  const photosTable = {
    id: Symbol("id"),
    thumbnailGenerating: Symbol("thumbnailGenerating"),
    takenAt: Symbol("takenAt"),
    thumbnailKey: Symbol("thumbnailKey"),
  };

  const makeWhereResult = () => ({
    returning: hoisted.returning,
    then(
      resolve: (v: undefined) => unknown,
      reject?: (e: unknown) => unknown,
    ) {
      return Promise.resolve(undefined).then(resolve, reject);
    },
    catch(fn: (e: unknown) => unknown) {
      return Promise.resolve(undefined).catch(fn);
    },
    finally(fn: () => void) {
      return Promise.resolve(undefined).finally(fn);
    },
    [Symbol.toStringTag]: "Promise",
  });

  const makeSetResult = () => ({ where: () => makeWhereResult() });
  const db = {
    update: () => ({ set: makeSetResult }),
    // generateAndStoreThumbnail looks up the photo's org to key the thumbnail
    // under orgs/<id>/ (storage ACL). One org is plenty for these tests.
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ organizationId: 1 }]) }) }),
  };

  return { db, photosTable };
});

vi.mock("../objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        exists: () => Promise.resolve([true]),
        download: () => Promise.resolve([hoisted.sourceBuffer]),
      }),
    }),
  },
  parseObjectPath: (path: string) => {
    if (!path.startsWith("/")) path = `/${path}`;
    const parts = path.split("/");
    return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
  },
  signObjectURL: () => Promise.resolve("https://storage.example.com/upload"),
  getPrivateObjectDir: () => process.env.PRIVATE_OBJECT_DIR!,
}));

vi.mock("../logger", () => ({
  logger: {
    info: hoisted.loggerInfo,
    warn: hoisted.loggerWarn,
    error: hoisted.loggerError,
  },
}));

vi.stubGlobal("fetch", hoisted.mockFetch);

import {
  extractExifDate,
  generateAndStoreThumbnail,
  parseExifDateValue,
} from "../thumbnailGeneration";

function setupFetchForUpload() {
  // URL signing no longer goes through fetch (signObjectURL is mocked above);
  // the only fetch left is the thumbnail PUT to the signed URL.
  hoisted.mockFetch.mockResolvedValueOnce({ ok: true });
}

function setupDbClaim(takenAtAlreadySet: boolean) {
  let callCount = 0;
  hoisted.returning.mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([{ id: 1 }]);
    return Promise.resolve(takenAtAlreadySet ? [] : [{ id: 1 }]);
  });
}

beforeEach(() => {
  hoisted.sourceBuffer = fixtureJpegWithExif;
  hoisted.returning.mockReset();
  hoisted.loggerInfo.mockReset();
  hoisted.loggerWarn.mockReset();
  hoisted.loggerError.mockReset();
  hoisted.mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// parseExifDateValue — pure function, no IO
// ---------------------------------------------------------------------------
describe("parseExifDateValue", () => {
  it("parses a valid EXIF date string (YYYY:MM:DD HH:MM:SS) into a UTC Date", () => {
    const result = parseExifDateValue("2023:06:15 10:30:00");
    expect(result).toEqual(new Date(Date.UTC(2023, 5, 15, 10, 30, 0)));
  });

  it("returns a valid Date object unchanged", () => {
    const date = new Date("2023-06-15T10:30:00Z");
    expect(parseExifDateValue(date)).toEqual(date);
  });

  it("returns null for null", () => {
    expect(parseExifDateValue(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseExifDateValue(undefined)).toBeNull();
  });

  it("returns null for a string that does not match EXIF format", () => {
    expect(parseExifDateValue("2023-06-15T10:30:00Z")).toBeNull();
    expect(parseExifDateValue("not-a-date")).toBeNull();
    expect(parseExifDateValue("")).toBeNull();
  });

  it("returns null for an invalid Date object", () => {
    expect(parseExifDateValue(new Date("not-a-date"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case (a): JPEG with real EXIF data — sharp + exif-reader run for real
// ---------------------------------------------------------------------------
describe("extractExifDate — case (a): real JPEG with EXIF DateTimeOriginal", () => {
  it("returns the correct date from the fixture JPEG's EXIF block", async () => {
    const result = await extractExifDate(fixtureJpegWithExif);

    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Date);
    // Fixture was written with "2022:03:10 14:45:00"
    expect(result!.toISOString()).toBe("2022-03-10T14:45:00.000Z");
  });

  it("does not throw and returns a Date for the fixture — proving sharp+exif-reader integration", async () => {
    await expect(extractExifDate(fixtureJpegWithExif)).resolves.toBeInstanceOf(
      Date,
    );
  });
});

// ---------------------------------------------------------------------------
// Case (c): JPEG without EXIF — sharp + exif-reader run for real
// ---------------------------------------------------------------------------
describe("extractExifDate — case (c): real JPEG without EXIF", () => {
  it("returns null when the JPEG has no EXIF segment", async () => {
    const result = await extractExifDate(fixtureJpegWithoutExif);
    expect(result).toBeNull();
  });

  it("returns null and does not throw on a corrupt/arbitrary buffer", async () => {
    const result = await extractExifDate(Buffer.from("not-a-jpeg"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case (b): pre-existing takenAt is never overwritten
// — object storage returns the real EXIF fixture so sharp+exif-reader parse
//   genuine bytes; only DB and fetch are mocked.
// ---------------------------------------------------------------------------
describe("generateAndStoreThumbnail — case (b): pre-existing takenAt is never overwritten", () => {
  it("does not log 'takenAt populated' when EXIF is present but takenAt is already set", async () => {
    hoisted.sourceBuffer = fixtureJpegWithExif;
    setupDbClaim(true);
    setupFetchForUpload();

    const result = await generateAndStoreThumbnail(42, "/objects/test-photo-id");

    expect(result).toBe("success");

    const populatedCalls = hoisted.loggerInfo.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[1] === "string" && args[1].includes("takenAt populated"),
    );
    expect(populatedCalls).toHaveLength(0);
  });

  it("logs 'takenAt populated' when EXIF is present and takenAt was null (normal path)", async () => {
    hoisted.sourceBuffer = fixtureJpegWithExif;
    setupDbClaim(false);
    setupFetchForUpload();

    const result = await generateAndStoreThumbnail(43, "/objects/test-photo-id-2");

    expect(result).toBe("success");

    const populatedCalls = hoisted.loggerInfo.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[1] === "string" && args[1].includes("takenAt populated"),
    );
    expect(populatedCalls).toHaveLength(1);
    expect(populatedCalls[0][0]).toMatchObject({ photoId: 43 });
  });

  it("does not attempt a takenAt update when the JPEG has no EXIF", async () => {
    hoisted.sourceBuffer = fixtureJpegWithoutExif;
    setupDbClaim(false);
    setupFetchForUpload();

    const result = await generateAndStoreThumbnail(44, "/objects/test-photo-id-3");

    expect(result).toBe("success");

    const populatedCalls = hoisted.loggerInfo.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[1] === "string" && args[1].includes("takenAt populated"),
    );
    expect(populatedCalls).toHaveLength(0);
  });
});
