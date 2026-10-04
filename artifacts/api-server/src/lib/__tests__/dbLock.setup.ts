import { beforeAll, afterAll } from "vitest";
import { acquireTestDbLock } from "@workspace/db";

// Vitest setup file (api-server and mcp-server): hold a Postgres advisory lock
// for the duration of each test file so concurrent test processes sharing one
// test database never interleave their TRUNCATEs and fixtures.
let release: (() => Promise<void>) | null = null;

beforeAll(async () => {
  release = await acquireTestDbLock();
}, 10 * 60_000);

// Registered first, so (hooks run in stack order) it runs after the file's own
// afterAll hooks, i.e. after the file has closed its pool.
afterAll(async () => {
  await release?.();
  release = null;
});
