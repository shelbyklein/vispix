import { defineConfig } from "vitest/config";

// Same test-database setup as api-server: integration tests talk to a real
// Postgres, never the dev/prod DB. CI provides TEST_DATABASE_URL; locally we
// default to the `vispix_test` database on the docker Postgres (port 5433).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/vispix_test";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      AI_KEY_ENCRYPTION_SECRET:
        process.env.AI_KEY_ENCRYPTION_SECRET ?? "test-ai-key-encryption-secret-0000000000000000",
    },
    // Integration tests TRUNCATE a shared database between tests.
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
