import { defineConfig } from "vitest/config";

// Integration tests talk to a real Postgres. Point them at a dedicated test
// database (never the dev/prod DB). CI provides TEST_DATABASE_URL; locally we
// default to the `vispix_test` database on the docker Postgres (port 5433).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/vispix_test";

export default defineConfig({
  test: {
    // `env` overrides process.env for the test worker, so a DATABASE_URL set in
    // the developer's shell can never leak the dev database into the tests.
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      AI_KEY_ENCRYPTION_SECRET:
        process.env.AI_KEY_ENCRYPTION_SECRET ?? "test-ai-key-encryption-secret-0000000000000000",
    },
    // Integration tests share one Postgres and TRUNCATE between tests, so they
    // must run fully serially: `concurrent: false` stops concurrency within a
    // file, and `fileParallelism: false` stops separate files from running in
    // parallel workers (otherwise one file's reset wipes another's rows
    // mid-test — FK violations, duplicate-key errors, empty result sets).
    sequence: { concurrent: false },
    fileParallelism: false,
    // ...and an advisory lock keeps OTHER processes (e.g. the mcp-server suite)
    // off the same database while a file runs.
    setupFiles: ["./src/lib/__tests__/dbLock.setup.ts"],
  },
});
