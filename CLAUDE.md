# Vispix

A pnpm-workspace monorepo photo album app: Express API + React web frontend + Expo mobile app, backed by Postgres/Drizzle, Better Auth (email/password), fake-gcs-server object storage (GCS-compatible), and pluggable AI providers (OpenAI/Anthropic/Gemini) for photo analysis. Everything runs locally — no cloud accounts required.

## Branch workflow (dev → main releases)

- **All day-to-day work happens on the `dev` branch**, checked out on the Beelink home server at `~/vispix-dev/app` (`ssh beelink`). It's served live at **dev.vispix.dev** (web 8085 / API 8084) and **mcp-dev.vispix.dev** (MCP 8086) by the Docker stack in `deploy/dev/`, operated with `scripts/vispix-dev.sh`. See `docs/DEV_ENVIRONMENT.md`.
- **Prod** (vispix.dev, mcp.vispix.dev) runs on a DigitalOcean droplet. Pushing to `main` builds and deploys it via GitHub Actions and applies pending migrations (`deploy/DEPLOY.md`). There is no prod checkout to maintain by hand.
- **Release** (only when the user says so): open a PR `dev` → `main` and merge with a **merge commit** (not squash — keeps the long-lived `dev` history connected). The deploy workflow does the rest.
- The dev web server picks up edits via HMR; **API changes need a dev API restart**: `scripts/vispix-dev.sh restart api` (rebuilds the bundle on start).
- Run pnpm on the Beelink through the container so native deps match: `scripts/vispix-dev.sh pnpm <args>` (install, typecheck, codegen, db generate/migrate).
- Dev has its **own database** (`vispix_dev` in the dev Postgres container) and its **own copy of object storage** (`~/vispix-dev/storage`, fake-gcs). Schema changes, migrations, and destructive testing on dev are safe. `PHOTO_STORAGE_DELETE_DISABLED=true` is still set in the dev `.env` from when storage was shared with prod — harmless to keep.

## Run & Operate

- `pnpm run dev` — start storage (docker compose) + API (port 8080) + web (port 8081)
- `pnpm run dev:api` / `pnpm run dev:web` / `pnpm run dev:storage` — run pieces individually
- `pnpm run dev:mobile` — run the Expo mobile app (`expo start`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from `lib/api-spec/openapi.yaml`
- `pnpm run test` — run tests across packages (api-server integration tests need a Postgres `vispix_test` DB; see Migrations)
- Prerequisites (standalone local setup, not the Beelink dev stack): Node 24 (nvm), pnpm (corepack), Docker (Postgres + fake-gcs-server via the root `docker-compose.yml`)
- Env vars load from a root `.env` file (see `.env.example`). The api-server reads it via `--env-file-if-exists`; `lib/db`'s scripts use `dotenv-cli` (`dotenv -e ../../.env -- <cmd>`).

## Database & migrations

- Schema lives in `lib/db/src/schema/*` (Drizzle). Generated migrations live in `lib/db/drizzle/` with a `meta/_journal.json`.
- **Forward workflow (versioned):** edit the schema → `pnpm --filter @workspace/db run generate` (writes a new `NNNN_*.sql` migration) → `pnpm --filter @workspace/db run migrate` (applies pending migrations; safe to re-run, tracked in `drizzle.__drizzle_migrations`). CI applies migrations this way against a fresh Postgres before running tests.
- **`pnpm --filter @workspace/db run push`** still works for quick local iteration but does not create migration files — prefer generate+migrate so schema history is captured.
- **Existing databases** are baselined against `0000_secret_cable.sql` (the local dev DB already was), so `migrate` is a no-op there until a new migration is generated. A brand-new database gets the full schema from `migrate`.
- The older hand-written `lib/db/migrations/*.sql` files predate this system and are historical only — not applied by `migrate`.
- Tests: api-server integration tests run against a dedicated `vispix_test` database (never the dev DB — `testDb.ts` refuses a non-"test" `DATABASE_URL`). Create it once with `createdb vispix_test` (or the SQL equivalent) then `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/vispix_test pnpm --filter @workspace/db exec tsx src/migrate.ts`.

## Auth (Better Auth)

- Config: `artifacts/api-server/src/lib/auth.ts` (better-auth pinned exact — see api-server/photo-album package.json; keep both in sync). Handler mounted in `app.ts` at `/api/auth/*splat` **before** `express.json()` (it reads the raw body).
- Sessions are cookies stored in Postgres (`user`/`session`/`account`/`verification` tables, schema in `lib/db/src/schema/auth.ts`, generated via `@better-auth/cli generate`).
- App users live in the separate `users` table, soft-linked by `authUserId`; `requireAuth` auto-provisions on first sign-in. **The first user ever to sign up gets role "admin"**; everyone after is "member".
- The admin registration toggle is enforced server-side by a `databaseHooks.user.create.before` hook (403 on sign-up when disabled).
- Frontend: `artifacts/photo-album/src/lib/auth-client.ts` (better-auth/react), `AuthGate` component gates routes, sign-in/sign-up pages at `src/pages/sign-in.tsx` / `sign-up.tsx`.

## Object storage (fake-gcs-server)

- `docker compose up -d` runs fsouza/fake-gcs-server on port 4443; the `targetvision` bucket is auto-created from `scripts/fake-gcs/seed/`. Objects persist in a named volume.
- `artifacts/api-server/src/lib/objectStorage.ts`: when `GCS_ENDPOINT` is set, the GCS client points at the emulator and signs URLs with an ephemeral RSA key generated at boot (fake-gcs-server never validates signatures). Unset `GCS_ENDPOINT` → real GCS via ADC.
- Browser uploads: `POST /api/storage/uploads/request-url` rewrites the signed URL onto the `/gcs` Vite proxy path when `GCS_BROWSER_UPLOAD_PREFIX` is set, keeping uploads same-origin (no CORS against the emulator). Server-side callers (thumbnails) use absolute signed URLs directly.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- Build: esbuild (API bundles to `dist/index.mjs`)
- Auth: Better Auth
- Object storage: Google Cloud Storage API (fake-gcs-server locally)

## Where things live

| Package | Path | What it is |
|---|---|---|
| `@workspace/api-server` | `artifacts/api-server` | Express 5 API |
| `@workspace/photo-album` | `artifacts/photo-album` | Vite + React web frontend |
| `@workspace/mobile` | `artifacts/mobile` | Expo / React Native app (no auth wired yet) |
| `lib/db` | `lib/db` | Drizzle schema + `drizzle-kit push` + seed |
| `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` | `lib/*` | OpenAPI spec + Orval-generated Zod schemas and React Query hooks |

## Gotchas

- The API routes rely on `lib/api-spec/openapi.yaml` staying in sync with route/DB code — if you add a query param or body field to a route, add it to the OpenAPI spec and re-run `pnpm --filter @workspace/api-spec run codegen`, or the generated Zod schemas and TypeScript types will silently drift.
- Better Auth is externalized in the api-server esbuild bundle's `@opentelemetry/*` pattern — `@opentelemetry/semantic-conventions` must stay an explicit api-server dependency or the bundle fails at boot. Do NOT add `@opentelemetry/api` as a direct dep: it forks drizzle-orm into two peer-variant instances and breaks typecheck.
- Seed users (`lib/db/src/seed.ts`) have no Better Auth account rows and can't sign in — they only anchor demo data. Don't seed before the first real sign-up if you want that account to get the first-user admin grant.
- `lib/object-storage-web/tsconfig.json` needs `"composite": true` since `artifacts/photo-album` references it as a TS project reference.
- Known pre-existing typecheck failures (2 in photo-album, 0 in api-server/mobile): dual-`@types/react` (19.1.x pinned by mobile vs 19.2.x catalog) type conflicts in `calendar.tsx`/`spinner.tsx`. Fixing means realigning mobile's pinned React types, which risks breaking Expo compatibility — needs its own investigation. (The previous ~69-error count was `openapi.yaml` drift from the generated api-zod/api-client-react packages not having been regenerated since the Better Auth migration — running codegen and syncing the spec resolved it.)
- Vite dev server proxies `/api` → API server and `/gcs` → fake-gcs-server (`artifacts/photo-album/vite.config.ts`).
