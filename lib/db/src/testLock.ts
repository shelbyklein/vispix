import pg from "pg";

// Cross-process mutex for DB-backed test files. Integration tests TRUNCATE a
// shared database, so two test processes on one database (e.g. the api-server
// and mcp-server suites run concurrently, or another run pointed at the same
// DB) corrupt each other mid-test. A session-level Postgres advisory lock on a
// dedicated connection serializes whole test FILES across processes; if the
// process dies the connection closes and the lock frees itself.
const TEST_DB_LOCK_KEY = 7_215_001;

/** Waits for the lock; resolves to a release function. */
export async function acquireTestDbLock(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [TEST_DB_LOCK_KEY]);
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [TEST_DB_LOCK_KEY]);
    } finally {
      await client.end();
    }
  };
}
