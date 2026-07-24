# Deploying Vispix (cheapest path: one VPS + Docker Compose + real GCS)

This is the production runbook. Target: a single small Linux box running the
whole stack in Docker Compose, with photos on a real (private) Google Cloud
Storage bucket. It replaces the current setup (Vite dev servers + the
unauthenticated fake-gcs emulator behind a Cloudflare tunnel), and closes the
two migration-blocking findings from the security audit (issue #137): the
public `/gcs` exposure and running dev-mode servers in production.

Steps you must do yourself are marked **[you]** — they involve provisioning,
DNS, and credentials, which the deploy tooling can't (and shouldn't) do.

---

## Deploying (CI — the normal path, #163)

Images are **built in GitHub Actions** (`.github/workflows/deploy.yml`), not on
the droplet — building on the 2 GB box OOM-killed dockerd and silently failed
releases. On every push to `main` (or `workflow_dispatch`), CI:

1. builds `vispix-app` + `vispix-web` on a GitHub runner (lots of RAM),
2. `docker save`s them and ships the tarball to the droplet over SSH,
3. `docker load`s them and runs `docker compose … up -d --no-build` (migrate +
   restart — **no on-box compilation**), then health-checks `vispix.dev`.

**One-time setup [you]:** add repo secrets (Settings → Secrets and variables →
Actions):
- `DROPLET_SSH_KEY` — private key of a deploy keypair; put its **public** half in
  the droplet's `~/.ssh/authorized_keys`.
- `DROPLET_HOST` — `143.244.146.22`.

**Manual fallback** (registry-free, if CI is down) — build locally and ship:
```
docker buildx build -f deploy/Dockerfile --target app --load -t vispix-app:latest .
docker buildx build -f deploy/Dockerfile --target web --load -t vispix-web:latest .
docker save vispix-app:latest vispix-web:latest | gzip | \
  ssh root@143.244.146.22 'gunzip | docker load'
ssh root@143.244.146.22 'cd /opt/vispix && git pull --ff-only origin main && \
  docker compose -f deploy/docker-compose.prod.yml up -d --no-build'
```
⚠️ **Never** run `up -d --build` on the droplet — the compose file is image-only
and building on-box OOMs the daemon.

## Backups (#163)

- **Nightly DB dump** on the droplet: `deploy/scripts/backup-db.sh` writes a
  compressed `pg_dump` to `/opt/vispix/backups`, 7-day rotation. Install via
  cron: `0 4 * * * /opt/vispix/deploy/scripts/backup-db.sh >> /var/log/vispix-backup.log 2>&1`.
  Restore: `docker cp <dump> vispix-postgres-1:/tmp/d && docker exec vispix-postgres-1 pg_restore -U vispix -d vispix --clean /tmp/d`.
- **Droplet loss [you]:** enable DigitalOcean **snapshots/backups** in the
  control panel (off-site, covers total droplet loss). Optional next step: push
  the nightly dumps to the GCS bucket for off-site DB backup.

---

## What runs where

| Service    | Image        | Port (host)      | Notes                                   |
|------------|--------------|------------------|-----------------------------------------|
| `web`      | `vispix-web` | `127.0.0.1:8083` | nginx: static SPA + `/api` proxy        |
| `mcp`      | `vispix-app` | `127.0.0.1:8086` | MCP gateway (`mcp.vispix.dev`)          |
| `api`      | `vispix-app` | internal only    | Express API, reached via nginx          |
| `postgres` | `pgvector`   | internal only    | data in the `postgres-data` volume      |
| `migrate`  | `vispix-app` | one-shot         | applies migrations, then exits          |

Only web + mcp are published, and only on `127.0.0.1` — the Cloudflare tunnel
running on the host reaches them; nothing on the public LAN does.

---

## 1. Provision the box **[you]**

- A small VPS is plenty to start: **Hetzner CX22** (~€4/mo, 2 vCPU / 4 GB) or a
  DigitalOcean $6 droplet. Pick one near your users.
- Install Docker Engine + the compose plugin (Docker's official convenience
  script is fine): `curl -fsSL https://get.docker.com | sh`.
- Give it swap if you chose a 2 GB box (the image build is memory-hungry):
  `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`.

## 2. Create the real GCS bucket + service account **[you]**

Photos move off the local emulator to a private bucket in your existing GCP
project (`targetvision-502503`). Run locally with `gcloud` authenticated, or in
Cloud Shell. Replace `vispix-prod` with your chosen globally-unique bucket name.

```bash
# Private bucket, uniform access, in your project
gsutil mb -p targetvision-502503 -b on -l us-central1 gs://vispix-prod

# Service account the app signs URLs and reads/writes objects with
gcloud iam service-accounts create vispix-storage \
  --project targetvision-502503 --display-name "Vispix storage"

# Grant object admin on just this bucket (least privilege)
gsutil iam ch \
  serviceAccount:vispix-storage@targetvision-502503.iam.gserviceaccount.com:roles/storage.objectAdmin \
  gs://vispix-prod

# Vertex AI access — the same key is the app's ADC for embeddings
# (semantic search + photo-upload embedding generation). Without this the
# Vertex :predict call 403s and MCP search_photos reports
# "embedding service not configured or unreachable".
gcloud projects add-iam-policy-binding targetvision-502503 \
  --member serviceAccount:vispix-storage@targetvision-502503.iam.gserviceaccount.com \
  --role roles/aiplatform.user

# Key file — this is what the container mounts. Keep it secret.
gcloud iam service-accounts keys create ./gcp-sa.json \
  --iam-account vispix-storage@targetvision-502503.iam.gserviceaccount.com
```

Set bucket CORS so browsers can PUT directly to signed upload URLs from your
site (save as `cors.json`, then apply):

```json
[{ "origin": ["https://vispix.dev"],
   "method": ["GET", "PUT", "HEAD"],
   "responseHeader": ["Content-Type"],
   "maxAgeSeconds": 3600 }]
```
```bash
gsutil cors set cors.json gs://vispix-prod
```

> The service-account key grants write access to the bucket. Treat it like a
> password — it never gets committed (the compose mount and `.gitignore` keep it
> out of the image and git).

## 3. Point the tunnel/DNS at the box **[you]**

You already run a Cloudflare tunnel. Update its ingress so:
- `vispix.dev` → `http://localhost:8083`
- `mcp.vispix.dev` → `http://localhost:8086`

and run `cloudflared` on the new box (copy the tunnel credentials over). If you'd
rather drop the tunnel, point `A`/`AAAA` records at the box's IP and put Caddy in
front for automatic TLS — but the tunnel is the least-effort option and keeps the
origin IP private.

## 4. Configure the app on the box **[you + tooling]**

```bash
git clone https://github.com/shelbyklein/vispix.git && cd vispix
cp deploy/.env.production.example deploy/.env.production
$EDITOR deploy/.env.production            # fill in every CHANGE_ME + bucket name
mkdir -p deploy/secrets && mv ~/gcp-sa.json deploy/secrets/gcp-sa.json
```

Generate the three secrets with `openssl rand -hex 32` (a fresh value each):
`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `AI_KEY_ENCRYPTION_SECRET`. Set
`PRIVATE_OBJECT_DIR=/vispix-prod/private` and
`PUBLIC_OBJECT_SEARCH_PATHS=/vispix-prod/public` (your bucket name), and leave
`GCS_ENDPOINT` / `GCS_BROWSER_UPLOAD_PREFIX` **unset** — that's what flips the
code onto real, signature-enforced GCS.

> `AI_KEY_ENCRYPTION_SECRET` decrypts the AI-provider keys already stored in the
> database. If you're migrating existing data (step 6), reuse the **same** value
> your current prod `.env` uses, or those stored keys won't decrypt.

## 5. Build + start

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

This builds both images, waits for Postgres, runs migrations once, then starts
api/mcp/web. Check it:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs -f api
```

The **first account to sign up becomes the platform admin** — so sign up
immediately at `https://vispix.dev/sign-up` before anyone else can.

## 6. (Optional) migrate existing data **[you]**

If you're carrying over the current library rather than starting fresh:

- **Database:** `pg_dump` the current `vispix` DB and `pg_restore` into the new
  container's Postgres (or point `DATABASE_URL` at a managed DB you've restored
  into). The stored object keys are `/objects/...` paths, so they keep working as
  long as the objects land under the new bucket's private prefix (next bullet).
- **Objects:** copy the emulator's filesystem into the bucket, preserving the
  `private/` prefix so the keys still resolve:
  ```bash
  gsutil -m rsync -r E:/TargetVision/storage/targetvision/private gs://vispix-prod/private
  gsutil -m rsync -r E:/TargetVision/storage/targetvision/public  gs://vispix-prod/public
  ```

## 7. Stripe go-live (when ready) **[you]**

Billing runs keyless until you add live keys. When ready: create the live Pro
price + a webhook endpoint at `https://vispix.dev/api/billing/webhook` in the
Stripe dashboard, then uncomment and fill the four `STRIPE_*` /
`BILLING_PUBLIC_BASE_URL` lines in `.env.production` and
`docker compose ... up -d api`.

---

## Routine deploys (after the first)

```bash
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Migrations re-run automatically (idempotent); the API/MCP restart on the new
image; the web image rebuilds the static bundle. Zero manual DB steps.

## What this closes from the security audit (#137)

- **Critical — public `/gcs`:** gone. There is no `/gcs` proxy in production and
  no emulator; the browser uploads to real GCS via short-lived signed URLs, and
  the bucket is private.
- **High — dev-mode servers:** gone. `NODE_ENV=production` (restores Better
  Auth's brute-force rate limiter) and the web is a static nginx build, not the
  Vite dev server. nginx adds the previously-missing security headers.
- **Medium — 0.0.0.0 service exposure:** Postgres has no published port at all;
  web/mcp bind to `127.0.0.1` behind the tunnel. Set a strong `POSTGRES_PASSWORD`.

Still worth doing after go-live (not migration-blockers): bump `sharp` ≥ 0.35.0,
fix the `coverPhotoId` cross-tenant check and the real-byte quota accounting, and
work through the Low/Info hardening list in the issue.
