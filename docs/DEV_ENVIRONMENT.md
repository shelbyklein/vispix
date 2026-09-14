# Dev environment (`dev.vispix.dev`)

The dev copy of Vispix runs on the **Beelink** home server (Ubuntu, `ssh beelink`)
as a Docker Compose stack, so you can work on the `dev` branch without touching
the live site. Prod (`vispix.dev`) runs on a DigitalOcean droplet and deploys
from `main` via GitHub Actions — see `deploy/DEPLOY.md`.

| | Prod | Dev (this) |
|---|---|---|
| Host | DigitalOcean droplet | Beelink (`ssh beelink`) |
| Code | `main`, built in CI | `~/vispix-dev/app` on `dev` (live source, Vite HMR) |
| Web | vispix.dev | **dev.vispix.dev** → `localhost:8085` |
| API | internal | `localhost:8084` (proxied at `/api`) |
| MCP | mcp.vispix.dev | **mcp-dev.vispix.dev** → `localhost:8086` |
| Database | `vispix` (droplet) | **`vispix_dev`** (dev Postgres container, `127.0.0.1:5433`) |
| Object storage | Google Cloud Storage | **fake-gcs** on `~/vispix-dev/storage` (`127.0.0.1:4443`) |

Dev has its own database and its own copy of object storage, so **schema
changes, migrations, and destructive testing on dev are safe**.

## Layout on the Beelink

```
~/vispix-dev/
  app/        this repo, checked out on `dev`; app/.env is the app's env (see .env.dev.example)
  storage/    fake-gcs object store (photos + thumbnails)
  secrets/    vertex-embeddings.json (GOOGLE_APPLICATION_CREDENTIALS)
  .env        compose-only vars: TUNNEL_TOKEN (mode 600)
```

The stack is `deploy/dev/docker-compose.yml` (project `vispix-dev`):

| Service | What |
|---|---|
| `postgres` | pgvector/pgvector:pg16, data in the `vispix-dev_postgres-data` volume |
| `fake-gcs` | fsouza/fake-gcs-server, `storage/` bind mount |
| `api` | `pnpm run dev:api` in `node:24-bookworm` (builds the bundle, then serves 8084) |
| `web` | `pnpm run dev:web:dev` (Vite on 8085) |
| `mcp` | `pnpm run mcp:http` (8086) |
| `tunnel` | cloudflared for the dashboard-managed tunnel `vispix-dev-beelink` |

The node services use host networking with the dev root mounted at the same
path, so `app/.env` uses plain `localhost` URLs and absolute host paths.
Each service has memory/CPU caps so dev can't starve the other apps on the box.

## Daily use

Everything goes through `scripts/vispix-dev.sh`, run from `~/vispix-dev/app`:

```sh
scripts/vispix-dev.sh up              # start everything (+ tunnel when TUNNEL_TOKEN is set)
scripts/vispix-dev.sh ps              # status
scripts/vispix-dev.sh logs api web    # follow logs
scripts/vispix-dev.sh restart api     # after API changes (web picks up edits via HMR)
scripts/vispix-dev.sh down            # stop (data is kept)
scripts/vispix-dev.sh psql            # psql on vispix_dev
scripts/vispix-dev.sh pnpm install    # pnpm inside the Node 24 container
```

Always run pnpm through the script (not a host Node) so native dependencies
(`sharp`, `esbuild`) are installed for the same runtime the stack uses.

**Preview a branch:**

```sh
cd ~/vispix-dev/app
git fetch origin
git checkout <branch>
scripts/vispix-dev.sh pnpm install    # only if deps changed
scripts/vispix-dev.sh restart api
```

Open `https://dev.vispix.dev` and sign in (dev has its own cookie host; prod is
unaffected). The Beelink's firewall doesn't expose 8085 to the LAN; to reach it
directly, forward it: `ssh -L 8085:127.0.0.1:8085 beelink`.

## Branch workflow (dev → main releases)

Day-to-day work lives on the long-running **`dev` branch**, which the Beelink
checkout keeps checked out — the dev site always shows it. `main` is the release
line that prod deploys from.

- **Work:** commit directly to `dev` (or merge short feature branches into it).
- **Release** (at a good release point): PR `dev` → `main`, merge with a
  **merge commit** (not squash, so the next release PR diffs cleanly). The
  deploy workflow builds the images, applies pending migrations to prod, and
  restarts the stack.

## Schema changes on dev

Dev owns `vispix_dev`, so the normal workflow just works here:

```sh
# in ~/vispix-dev/app, after editing lib/db/src/schema/*
scripts/vispix-dev.sh pnpm --filter @workspace/db run generate    # writes the migration
scripts/vispix-dev.sh pnpm --filter @workspace/db run migrate     # applies it to vispix_dev
scripts/vispix-dev.sh restart api
```

Prod gets the same migrations automatically when `dev` is merged to `main`.

## Setting up from scratch

1. `git clone git@github.com:shelbyklein/vispix.git ~/vispix-dev/app && cd ~/vispix-dev/app && git checkout dev`
2. Create `app/.env` from `.env.dev.example` (secrets marked "MUST match prod"
   come from the prod `.env`) and put the Vertex key at
   `~/vispix-dev/secrets/vertex-embeddings.json`.
3. `scripts/vispix-dev.sh pnpm install --frozen-lockfile`
4. Restore data (optional): `pg_restore` a `vispix_dev` dump into the postgres
   container, and copy the object store into `~/vispix-dev/storage`.
   ⚠️ fake-gcs keeps each object's metadata in a `user.metadata` extended
   attribute — copy with `rsync -aX` or `tar --xattrs`, or every object 404s.
5. Put the tunnel token in `~/vispix-dev/.env` as `TUNNEL_TOKEN=...` (Cloudflare
   Zero Trust → Networks → Tunnels → `vispix-dev-beelink`). Its published
   routes are `dev.vispix.dev → http://localhost:8085` and
   `mcp-dev.vispix.dev → http://localhost:8086`.
6. `scripts/vispix-dev.sh up`
