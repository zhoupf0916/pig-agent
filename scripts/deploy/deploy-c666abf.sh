#!/usr/bin/env bash
# Pig Agent — Tencent server upgrade to main@c666abf (P0–P2). Run ON the server as the deploy owner (ubuntu).
#
#   bash deploy-c666abf.sh            deploy: backup -> source -> cloud-dist -> switch current -> up --build --wait -> checks
#                                     (then runs e2e-remote.sh automatically if it sits next to this file)
#   bash deploy-c666abf.sh rollback   back up, then switch back to the release that was current before this deploy
#   bash deploy-c666abf.sh status     health / agent card / containers / runners only
#
# Env knobs: CLOUD_DIST=build|asset (default build on this server in node:24, falls back to the pinned
# prebuilt asset), NPM_REGISTRY (default npmmirror), FORCE=1 (proceed although tasks are running), SKIP_E2E=1.
# Secrets: stack.env / accounts.txt are never printed, copied into the release, or uploaded anywhere.
set -Eeuo pipefail
umask 022

ROOT=${PIG_DEPLOY_ROOT:-/home/ubuntu/pig-agent}
REPO=zhoupf0916/pig-agent
SHA=c666abf541a4760fe49456a128f60a7d9711f6e6
REL=20261008-p0p2-c666abf
NEW=$ROOT/releases/$REL
ENVF=$ROOT/data/cloud-local/stack.env
STATE=$ROOT/releases/.before-$REL
ASSET_URL=https://github.com/$REPO/releases/download/deploy-$REL/$REL-cloud-dist.tar.gz
ASSET_SHA256=8451f8cc05f4350bfd6c832eaa3053f1b67e6b4b2ae37661c6ead304ca5c18fd
# sha256 over "sha256sum" of every cloud-dist file (sorted); a server build of $SHA reproduces it exactly.
DIST_TREE_SHA256=83a8560a6afa4e4c52f0a335108f4c162793b2720973290c6734d2354c61051c
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
NODE_IMAGE=node:24-bookworm-slim
PNPM_VERSION=11.19.0
IMAGES="pig-agent-cloud pig-agent-gateway pig-agent-worker"
SERVICES="postgres cloud gateway worker runner-b runner-c runner-d"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF=$HERE/$(basename "${BASH_SOURCE[0]}")
SWITCHED=0
RESULTS=()
FAILS=0

mkdir -p "$ROOT/backups"
LOG=$ROOT/backups/deploy-$REL-${1:-deploy}-$(date +%Y%m%dT%H%M%S).log
(umask 077; : > "$LOG")
exec > >(tee -a "$LOG") 2>&1

pass() { RESULTS+=("OK   $*"); echo "OK   $*"; }
bad() { RESULTS+=("FAIL $*"); FAILS=$((FAILS + 1)); echo "FAIL $*"; }
step() { printf '\n== %s ==\n' "$*"; }
hint() {
  if [ "$SWITCHED" = 1 ]; then echo "current was switched -> roll back with: bash $SELF rollback"
  else echo "current was NOT switched; the running release is untouched."; fi
}
die() { echo "FAIL $*"; hint; echo "log: $LOG"; exit 1; }
trap 'echo "FAIL unexpected error at line $LINENO"; hint; echo "log: $LOG"' ERR

compose() { local dir=$1; shift; (cd "$dir" && docker compose --env-file "$ENVF" -f infra/cloud/compose.yml -f infra/tencent/compose.yml "$@"); }
# Same invocation as docs/tencent-deployment.md (cwd = current, relative -f paths, same project name).
up_current() { (cd "$ROOT/current" && timeout 1800 docker compose --env-file "$ENVF" -f infra/cloud/compose.yml -f infra/tencent/compose.yml up -d "$@" --wait); }
sql() { compose "$ROOT/current" exec -T postgres psql -U pig -d pig -Atc "$1"; }
tree_sha() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }
relink() { # atomic, keeps the existing absolute/relative style of the current symlink
  local target=$1
  if [[ "$(readlink "$ROOT/current")" != /* ]]; then target=releases/$(basename "$1"); fi
  ln -sfn "$target" "$ROOT/current.next" && mv -T "$ROOT/current.next" "$ROOT/current"
}
origin() { grep -m1 '^WEB_PUBLIC_ORIGIN=' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d "\"'" || true; }

checks() { # $1 = "new" also checks the A2A card
  local h="" card code html asset o host n i
  for i in $(seq 1 45); do h=$(curl -fsS -m 5 http://127.0.0.1:8890/health 2>/dev/null) && break; sleep 2; done
  [[ "$h" == *'"ok":true'* ]] && pass "health 127.0.0.1:8890 $h" || bad "health 127.0.0.1:8890 (${h:-no response})"
  local running; running=$(compose "$ROOT/current" ps --status running --services 2>/dev/null || true)
  for s in $SERVICES; do grep -qx "$s" <<<"$running" && pass "container $s running" || bad "container $s not running"; done
  n=0; for i in $(seq 1 30); do n=$(sql "SELECT count(*) FROM workers WHERE enabled AND seen_at>now()-interval '30 seconds'" 2>/dev/null || echo 0); [ "${n:-0}" -ge 1 ] && break; sleep 2; done
  [ "${n:-0}" -ge 1 ] && pass "runners online: $n" || bad "no runner heartbeat in 60s"
  html=$(curl -fsS -m 10 http://127.0.0.1:8890/ 2>/dev/null || true); asset=$(grep -oE '/assets/[^"]+\.js' <<<"$html" | head -1 || true)
  [ -n "$asset" ] && curl -fsS -o /dev/null -m 10 "http://127.0.0.1:8890$asset" && pass "web workbench served ($asset)" || bad "web workbench page/asset"
  curl -fsS -m 10 http://127.0.0.1:8890/admin/ 2>/dev/null | grep -q 'app.js' && pass "admin console served" || bad "admin console page"
  if [ "${1:-}" = new ]; then
    card=$(curl -fsS -m 10 http://127.0.0.1:8890/.well-known/agent-card.json 2>/dev/null || true)
    if [[ "$card" == *'"streaming":true'* && "$card" == *'/v1/a2a"'* ]]; then pass "A2A agent card (streaming) $(grep -o '"url":"[^"]*"' <<<"$card" | head -1)"; else bad "A2A agent card missing or not streaming"; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{"id":"x"}}' http://127.0.0.1:8890/v1/a2a || true)
    [ "$code" = 401 ] && pass "A2A endpoint rejects anonymous calls (401)" || bad "A2A anonymous call returned $code (expected 401)"
  fi
  o=$(origin)
  if [[ "$o" == https://* ]]; then
    host=${o#https://}; host=${host%%/*}; host=${host%%:*}
    curl -fsS -m 10 --connect-to "$host:443:127.0.0.1:443" "https://$host/health" 2>/dev/null | grep -q '"ok":true' && pass "public HTTPS via nginx https://$host/health" || bad "public HTTPS via nginx https://$host/health"
    if [ "${1:-}" = new ]; then
      curl -fsS -m 10 --connect-to "$host:443:127.0.0.1:443" "https://$host/.well-known/agent-card.json" 2>/dev/null | grep -q '"streaming":true' && pass "agent card via nginx" || bad "agent card via nginx"
    fi
  fi
}

summary() {
  printf '\n===== SUMMARY: %s =====\n' "$1"
  printf '%s\n' "${RESULTS[@]}"
}

build_dist() {
  echo "building cloud-dist in $NODE_IMAGE (registry $NPM_REGISTRY, memory cap 2g; ~2-6 min)"
  rm -rf "$NEW/cloud-dist"
  timeout 1500 docker run --rm --network host --memory 2g \
    -e CI=1 -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -e npm_config_registry="$NPM_REGISTRY" -e HUID="$(id -u)" -e HGID="$(id -g)" -e PNPM_VERSION="$PNPM_VERSION" \
    -v "$NEW":/src -w /src "$NODE_IMAGE" sh -ec '
      trap "rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/web/dist; chown -R \$HUID:\$HGID /src" EXIT
      npm i -g "pnpm@$PNPM_VERSION" >/tmp/p.log 2>&1 || { tail -20 /tmp/p.log; exit 1; }
      pnpm install --frozen-lockfile >/tmp/i.log 2>&1 || { tail -30 /tmp/i.log; exit 1; }
      pnpm --filter @pig-agent/web build >/tmp/b.log 2>&1 || { tail -30 /tmp/b.log; exit 1; }
      node scripts/build-cloud.mjs'
}
fetch_dist() {
  echo "downloading prebuilt cloud-dist asset (sha256-pinned)"
  curl -fsSL --retry 3 --connect-timeout 20 "$ASSET_URL" -o "$NEW/.cloud-dist.tgz"
  echo "$ASSET_SHA256  $NEW/.cloud-dist.tgz" | sha256sum -c --quiet - || { rm -f "$NEW/.cloud-dist.tgz"; return 1; }
  rm -rf "$NEW/cloud-dist" && tar -xzf "$NEW/.cloud-dist.tgz" -C "$NEW" && rm -f "$NEW/.cloud-dist.tgz"
}

deploy() {
  local START CUR PREV active queued avail dump cfg entries i
  START=$(date +%s)
  step "0/7 preflight"
  for c in docker curl tar sha256sum timeout; do command -v $c >/dev/null || die "missing command: $c"; done
  docker compose version >/dev/null || die "docker compose plugin missing"
  [ -f "$ENVF" ] || die "missing $ENVF"
  [ -L "$ROOT/current" ] || die "$ROOT/current is not a symlink"
  docker volume inspect pig-agent-cloud_database >/dev/null 2>&1 || die "volume pig-agent-cloud_database not found (refusing: would start an empty DB)"
  CUR=$(readlink -f "$ROOT/current")
  if [ "$CUR" = "$NEW" ]; then
    [ -f "$STATE" ] || die "current already points at $REL but $STATE is missing"
    PREV=$(cat "$STATE"); echo "re-run: current already $REL"
  else
    PREV=$CUR; echo "$PREV" > "$STATE"
  fi
  [ -d "$PREV" ] || die "previous release $PREV missing"
  echo "previous release: $PREV"
  avail=$(df -Pk "$ROOT" | awk 'NR==2{print int($4/1048576)}')
  [ "$avail" -ge 5 ] || die "only ${avail}G free (need 5G)"
  active=$(sql "SELECT count(*) FROM runs WHERE state IN ('preparing','running','cancelling')" || echo "?")
  queued=$(sql "SELECT count(*) FROM runs WHERE state='queued'" || echo "?")
  echo "disk free ${avail}G; runs running=$active queued=$queued"
  if [ "$active" != 0 ] && [ "${FORCE:-0}" != 1 ]; then die "$active task(s) running — wait for them or re-run with FORCE=1"; fi
  pass "preflight (stack.env present, db volume present, ${avail}G free, running tasks=$active)"

  step "1/7 backup db + config (existing backup.sh)"
  [ -f "$PREV/infra/tencent/backup.sh" ] || die "missing $PREV/infra/tencent/backup.sh"
  PIG_DEPLOY_ROOT=$ROOT sh "$PREV/infra/tencent/backup.sh" || die "backup.sh failed"
  dump=$(ls -1t "$ROOT"/backups/daily/*.dump 2>/dev/null | head -1 || true)
  cfg=${dump%.dump}-config.tar.gz
  [ -n "$dump" ] && [ "$(stat -c %Y "$dump")" -ge "$START" ] && [ -s "$dump" ] || die "no fresh dump in backups/daily"
  entries=$(compose "$ROOT/current" exec -T postgres pg_restore --list < "$dump" | grep -vc '^;' || true)
  [ "${entries:-0}" -gt 10 ] || die "dump verification failed (pg_restore --list entries=$entries)"
  tar -tzf "$cfg" | grep -qx 'data/cloud-local/stack.env' || die "config backup $cfg does not contain stack.env"
  mkdir -p "$ROOT/backups/before-$REL" && chmod 700 "$ROOT/backups/before-$REL"
  cp -p "$dump" "$cfg" "$ROOT/backups/before-$REL/"
  echo "$ROOT/backups/before-$REL/$(basename "$dump")" > "$STATE.dump"
  pass "backup verified: $(basename "$dump") ($(du -h "$dump" | cut -f1), $entries toc entries) + config tar -> backups/before-$REL/"

  step "2/7 source main@${SHA:0:7} -> releases/$REL"
  if [ -f "$NEW/.source-ok" ] && [ "$(cat "$NEW/.source-ok")" = "$SHA" ]; then
    echo "reusing existing $NEW"
  else
    [ "$CUR" != "$NEW" ] || die "current points at an incomplete $NEW"
    rm -rf "$NEW.tmp" && mkdir -p "$NEW.tmp"
    curl -fsSL --retry 3 --connect-timeout 20 "https://codeload.github.com/$REPO/tar.gz/$SHA" | tar -xz --strip-components=1 -C "$NEW.tmp" || die "source download failed"
    [ -f "$NEW.tmp/infra/tencent/compose.yml" ] && [ -f "$NEW.tmp/infra/cloud/Dockerfile" ] || die "source tree incomplete"
    [ -e "$NEW" ] && mv "$NEW" "$NEW.stale-$(date +%s)"
    mv "$NEW.tmp" "$NEW" && echo "$SHA" > "$NEW/.source-ok"
  fi
  pass "source $REPO@${SHA:0:7} in releases/$REL"

  step "3/7 cloud-dist"
  if [ -f "$NEW/cloud-dist/cloud.mjs" ] && [ "$(tree_sha "$NEW/cloud-dist")" = "$DIST_TREE_SHA256" ]; then
    echo "reusing verified cloud-dist"
  elif [ "${CLOUD_DIST:-build}" = build ] && build_dist; then
    echo "server build finished"
  else
    echo "server build skipped/failed -> prebuilt asset"; fetch_dist || die "cloud-dist: build failed and asset download/verification failed"
  fi
  [ -f "$NEW/cloud-dist/cloud.mjs" ] && grep -q 'agent-card.json' "$NEW/cloud-dist/cloud.mjs" || die "cloud-dist incomplete"
  if [ "$(tree_sha "$NEW/cloud-dist")" = "$DIST_TREE_SHA256" ]; then pass "cloud-dist ready, matches reference build (tree sha256 ${DIST_TREE_SHA256:0:12})"
  else pass "cloud-dist ready (WARN: tree hash differs from reference build; content built from $SHA)"; fi

  step "4/7 keep data/ and stack.env"
  if [ -e "$PREV/data" ] && [ ! -e "$NEW/data" ]; then ln -s "$(readlink -f "$PREV/data")" "$NEW/data"; echo "linked data/ like previous release"; fi
  pass "data/ untouched ($ROOT/data + docker volumes), stack.env $(wc -l <"$ENVF") lines (not printed)"

  step "5/7 tag running images as before-$REL"
  for i in $IMAGES; do
    if docker image inspect "$i:before-$REL" >/dev/null 2>&1; then echo "$i:before-$REL already exists (kept)";
    elif docker image inspect "$i:local" >/dev/null 2>&1; then docker tag "$i:local" "$i:before-$REL"; echo "tagged $i:before-$REL"; fi
  done
  pass "rollback images tagged"

  step "6/7 switch current -> $REL; docker compose up -d --build --wait"
  relink "$NEW"; SWITCHED=1
  echo "current -> $(readlink "$ROOT/current")"
  if up_current --build; then
    pass "compose up --build --wait"
  else bad "compose up --build --wait (see: docker compose ... logs --tail=100 cloud worker gateway)"; fi

  step "7/7 checks"
  checks new
  summary "deploy $REL ($(( ($(date +%s) - START) / 60 )) min)"
  if [ "$FAILS" = 0 ]; then
    echo "DEPLOY OK — previous release kept: $PREV ; rollback: bash $SELF rollback"
    if [ "${SKIP_E2E:-0}" != 1 ] && [ -f "$HERE/e2e-remote.sh" ]; then
      step "e2e (bash $HERE/e2e-remote.sh)"; bash "$HERE/e2e-remote.sh" || true
    else echo "e2e: bash $HERE/e2e-remote.sh"; fi
  else
    echo "DEPLOY FAIL ($FAILS) — roll back with: bash $SELF rollback"; echo "log: $LOG"; exit 1
  fi
  echo "log: $LOG"
}

rollback() {
  local PREV CUR flag=--no-build i
  [ -f "$STATE" ] || die "no $STATE (deploy never switched)"
  PREV=$(cat "$STATE"); CUR=$(readlink -f "$ROOT/current")
  [ -d "$PREV" ] || die "previous release $PREV missing"
  SWITCHED=1
  step "1/4 back up current data first"
  if PIG_DEPLOY_ROOT=$ROOT sh "$CUR/infra/tencent/backup.sh"; then pass "backup of current state: $(ls -1t "$ROOT"/backups/daily/*.dump | head -1)"
  elif [ "${FORCE:-0}" = 1 ]; then bad "backup failed (continuing: FORCE=1)"
  else die "backup failed; re-run with FORCE=1 to roll back without it"; fi
  step "2/4 restore before-$REL images"
  for i in $IMAGES; do docker image inspect "$i:before-$REL" >/dev/null 2>&1 || flag=--build; done
  if [ "$flag" = --no-build ]; then for i in $IMAGES; do docker tag "$i:before-$REL" "$i:local"; done; pass "images restored from before-$REL"
  else echo "before-$REL images missing -> rebuilding from $PREV/cloud-dist"; fi
  step "3/4 switch current -> $(basename "$PREV"); compose up"
  relink "$PREV"
  if up_current $flag; then pass "compose up $flag --wait"
  else bad "compose up $flag --wait"; fi
  step "4/4 checks"
  checks old
  summary "rollback to $(basename "$PREV")"
  echo "Database NOT restored: c666abf adds no schema migrations, so the previous code runs on the current DB."
  echo "Only if pre-deploy data must come back (overwrites newer data; confirm first): dump at $(cat "$STATE.dump" 2>/dev/null || echo backups/before-$REL/)"
  [ "$FAILS" = 0 ] && echo "ROLLBACK OK" || { echo "ROLLBACK FAIL ($FAILS)"; exit 1; }
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback) rollback ;;
  status) checks new; summary status ;;
  *) echo "usage: bash $0 [deploy|rollback|status]"; exit 2 ;;
esac
