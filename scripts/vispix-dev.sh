#!/usr/bin/env bash
# Operates the DEV stack (dev.vispix.dev) defined in deploy/dev/docker-compose.yml.
# Run from the dev checkout on the Beelink ($VISPIX_DEV_ROOT/app).
#
#   scripts/vispix-dev.sh up              start everything (tunnel too if TUNNEL_TOKEN is set)
#   scripts/vispix-dev.sh down            stop everything (data is kept)
#   scripts/vispix-dev.sh restart [svc]   restart a service (default: api — needed after API changes)
#   scripts/vispix-dev.sh logs [svc...]   follow logs
#   scripts/vispix-dev.sh ps              container status
#   scripts/vispix-dev.sh pnpm <args>     run pnpm inside the Node 24 container (install, typecheck, codegen, migrate...)
#   scripts/vispix-dev.sh psql            psql shell on vispix_dev
#   scripts/vispix-dev.sh compose <args>  any other docker compose command
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VISPIX_DEV_ROOT="${VISPIX_DEV_ROOT:-$(dirname "$REPO")}"
export VISPIX_UID="$(id -u)" VISPIX_GID="$(id -g)"

compose() {
  docker compose --project-directory "$REPO/deploy/dev" \
    --env-file "$VISPIX_DEV_ROOT/.env" \
    -f "$REPO/deploy/dev/docker-compose.yml" "$@"
}

[ -f "$VISPIX_DEV_ROOT/.env" ] || touch "$VISPIX_DEV_ROOT/.env"
profiles=()
grep -qE '^TUNNEL_TOKEN=.+' "$VISPIX_DEV_ROOT/.env" && profiles=(--profile tunnel)

cmd="${1:-}"; shift || true
case "$cmd" in
  up)      compose "${profiles[@]}" up -d "$@" ;;
  down)    compose "${profiles[@]}" down "$@" ;;
  restart) compose restart "${@:-api}" ;;
  logs)    compose logs -f --tail 100 "$@" ;;
  ps)      compose "${profiles[@]}" ps ;;
  psql)    compose exec postgres psql -U postgres -d vispix_dev "$@" ;;
  pnpm)
    tty=(); [ -t 0 ] && tty=(-t)
    exec docker run --rm -i "${tty[@]}" --user "$VISPIX_UID:$VISPIX_GID" --network host \
      -e HOME="$VISPIX_DEV_ROOT" -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e CI=true \
      -v "$VISPIX_DEV_ROOT:$VISPIX_DEV_ROOT" -w "$(pwd)" node:24-bookworm \
      sh -c 'mkdir -p "$HOME/.bin" && corepack enable --install-directory "$HOME/.bin" && PATH="$HOME/.bin:$PATH" pnpm "$@"' pnpm "$@" ;;
  compose) compose "$@" ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
