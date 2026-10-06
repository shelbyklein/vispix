# Release checklist

Reusable checklist for a `dev` to `main` release (#223). Copy it into the
release PR or issue and fill in the evidence column. Flow and deploy mechanics
are defined elsewhere; this file does not restate them: `CLAUDE.md` (branch
workflow), `deploy/DEPLOY.md` (what the deploy workflow does),
`docs/DEV_ENVIRONMENT.md` (dev stack), `docs/ISSUE_WORKFLOW.md` (issue/todo
mapping).

## Evidence types

Every line below names the evidence it needs. Each type proves a different
thing, so one never substitutes for another, and a report must say which type
it is quoting.

| Code | Evidence | Proves | Does not prove |
|---|---|---|---|
| **S** | Source/CI: typecheck, build, unit tests | The code compiles and pure logic holds | Anything at runtime |
| **F** | Fixture + mocked provider: `acceptanceJourneys` (api-server), `acceptanceScopedReads` (mcp-server), `retrievalParity`, `roleMatrix`, `orgIsolation` against a test DB | Ranking, scoping, roles, pagination, degraded states and contracts, deterministically | Real-provider relevance or latency, real storage, browsers, real MCP clients |
| **D** | Dev environment (dev.vispix.dev, own DB and storage) with real or test providers | The built release behaves on real infrastructure, with real embeddings if the dev providers are configured | Production data, production config |
| **P** | Real provider (embeddings, analysis) with an agreed budget | Relevance and failure behaviour of the actual provider | Anything else; cost and quotas must be approved first |
| **C** | Real MCP client against a scoped token (e.g. a Claude connector) | Auth, org scoping, media grants and tool schemas over the real transport | Web behaviour |
| **H** | Physical device or real browser at the target widths | Layout, touch, accessibility, uploads from a real device | Server behaviour |
| **R** | Production smoke after the release, read-only unless stated | The deployed revision is up and wired correctly | Broader correctness |

Mocked embeddings or images (**F**) must never be reported as **P**.
Production checks (**R**) never run destructive fixtures.

## 1. Before opening the release PR

| Check | Evidence | Result / link |
|---|---|---|
| `dev` is the release candidate; record the head SHA and the `main` SHA it merges onto | S | |
| CI green on `dev`: `pnpm run typecheck` and `pnpm run test` (the CI workflow applies migrations to a fresh Postgres first) | S, F | |
| Known pre-existing failures listed separately (CLAUDE.md "Gotchas"), none new | S | |
| Every issue in the release has its todos checked against its own acceptance checks, or is listed as open/blocked with an owner | S | |
| Acceptance journeys pass: `acceptanceJourneys.integration.test.ts`, `acceptanceScopedReads.integration.test.ts` (see "Commands") | F | |
| No `it.fails`/`it.todo` in the journey suites was silently dropped; each one is either still tracked or the bug is fixed and `.fails` removed | F | |
| Pending migrations reviewed: additive, with the compatibility and rollback notes below | S | |

## 2. Migrations

| Check | Evidence | Result |
|---|---|---|
| New files in `lib/db/drizzle/` are additive (no dropped columns, no data deletion) or have an explicit data-preservation plan | S | |
| Applied to a fresh DB and to a copy of the previous schema: `pnpm --filter @workspace/db exec tsx src/migrate.ts` | F | |
| Already applied on dev (`scripts/vispix-dev.sh pnpm --filter @workspace/db run migrate`) with the previous API still serving (old code must tolerate the new schema) | D | |
| Backfills named, with scope and expected runtime | S | |

## 3. Dev acceptance (before merging)

Run on dev (`dev.vispix.dev`, `mcp-dev.vispix.dev`); restart the API after API changes
(`scripts/vispix-dev.sh restart api`).

| Check | Evidence | Result |
|---|---|---|
| Sign in as each role: owner, admin, member; a member sees no hidden photos or primary-logo controls | D | |
| Filename search, photo-ID search, conceptual search ("smiling children"-style) return sensible results; record latency as a sample (n, environment), not an SLA | D / P | |
| Filter switching, pagination to the end, retry after a forced failure | D | |
| Photo details Previous/Next deep in an album and in search results | D | |
| Ten-photo shortlist saved to a project and exported (zip) | D | |
| Primary logo can be designated; variants and notes visible in the asset library (and via MCP `list_assets`) | D | |
| Real-provider relevance spot check against the agreed query list | P | |
| Real MCP client with a scoped token: `list_albums`, `search_photos`, `get_photo`, thumbnails/originals only for its organization | C | |
| Narrow viewport and a physical phone: grids, details, lightbox, upload | H | |
| Missing resources (provider budget, device, connector account) are recorded as BLOCKED for that gate only, not as passed | n/a | |

## 4. Release

Only when the owner says so.

1. Open a PR `dev` to `main`. The description lists included issues, migrations, and the evidence table above.
2. Merge with a **merge commit** (not squash).
3. Watch the deploy workflow: build, `docker load`, migrate, restart, health check (`deploy/DEPLOY.md`).
4. Record the released SHA and the time.

## 5. Production smoke (read-only)

| Check | Evidence | Result |
|---|---|---|
| Deploy workflow finished green; `vispix.dev` and `mcp.vispix.dev` respond | R | |
| Migrations applied (workflow log), API and MCP running the released SHA | R | |
| Sign in as a non-superadmin member of one organization; library, search and a photo open | R | |
| One filename search and one conceptual search return results; no error banner | R | |
| Scoped MCP read (`list_albums`) from a real client returns only that organization | R, C | |
| Logs: no new error spike, no secrets or tokens in log lines | R | |

Production is observed, not written to. Do not run fixtures, bulk operations or
destructive tests there.

## 6. Rollback

Trigger: failed health check, error spike, or an authorization/privacy regression.

1. Redeploy the previous `main` SHA through the deploy workflow (revert the merge commit on `main` with a PR, or re-run the workflow for the previous commit). Do not hand-edit the droplet.
2. Migrations are additive and are **not** rolled back; the previous code must run against the new schema. If a migration cannot satisfy that, say so in the release PR before merging.
3. Never roll back by dropping user-created data or permissions. A media-access fix is never rolled back by re-exposing reusable credentials.
4. Re-run section 5 against the rolled-back SHA and record the outcome.

## Commands (fixture evidence, local)

Use a dedicated test database; `testDb.ts` refuses a database whose name has no
"test", and tests TRUNCATE it.

```sh
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/vispix_test
(cd lib/db && DATABASE_URL=$TEST_DATABASE_URL pnpm exec tsx src/migrate.ts)
pnpm run typecheck
(cd artifacts/api-server && DATABASE_URL=$TEST_DATABASE_URL npx vitest run)
(cd artifacts/mcp-server && DATABASE_URL=$TEST_DATABASE_URL npx vitest run)
```

The shared fixture is `artifacts/api-server/src/lib/__tests__/fixtures/acceptanceLibrary.ts`
(contents are documented at the top of the file). The journey suites print an
informational latency table (`[acceptance latency, informational ...]`): one
local run, mocked provider, no budget asserted. Treat those numbers as a
baseline sample only; agree a budget before comparing against one.

## Report template

Each gate in the release report states: revision (SHA), environment, role,
provider mode (mock / real, which), evidence code from the table above, linked
issue, result. No secrets, tokens or production data in the report.
