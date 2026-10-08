#!/usr/bin/env bash
# Pig Agent — server-pulled upgrade to any commit of the public repo. Run ON the server as the deploy owner (ubuntu).
#
#   bash deploy.sh <commit>   deploy: backup -> source@commit -> cloud-dist -> switch current -> up --build --wait -> checks
#                             (then runs e2e-remote.sh if it sits next to this file and admin credentials are available)
#   bash deploy.sh rollback   back up, then return to the release that was current before the last deploy
#   bash deploy.sh status     health / agent card / containers / runners / nginx only
#
# <commit> is a 7–40 hex commit of zhoupf0916/pig-agent (full SHA recommended). The release dir is
# releases/<yyyymmdd>-<sha7>. Env knobs: CLOUD_DIST=build|asset (default: build on this server in node:24, falling
# back to the deploy-<sha7> release asset verified against its SHA256SUMS), NPM_REGISTRY (default npmmirror),
# FORCE=1 (proceed although tasks are running / backup failed on rollback), SKIP_E2E=1.
# Secrets: stack.env / accounts.txt are never printed, copied into a release, or uploaded anywhere.
set -Eeuo pipefail
umask 022

ROOT=${PIG_DEPLOY_ROOT:-/home/ubuntu/pig-agent}
REPO=zhoupf0916/pig-agent
ENVF=$ROOT/data/cloud-local/stack.env
ACC=$ROOT/data/cloud-local/accounts.txt
LAST=$ROOT/releases/.last-deploy
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
NODE_IMAGE=node:24-bookworm-slim
PNPM_VERSION=11.19.0
IMAGES="pig-agent-cloud pig-agent-gateway pig-agent-worker"
SERVICES="postgres cloud gateway worker runner-b runner-c runner-d"
SCHEMA_FILES="apps/cloud/src/db.ts apps/cloud/src/*schema*.ts"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF=$HERE/$(basename "${BASH_SOURCE[0]}")
CMD=${1:-}
SHA="" REL="" NEW="" STATE=""
SWITCHED=0
RESULTS=()
FAILS=0

mkdir -p "$ROOT/backups" "$ROOT/releases"
LOG=$ROOT/backups/deploy-${CMD:-none}-$(date +%Y%m%dT%H%M%S).log
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
origin() { grep -m1 '^WEB_PUBLIC_ORIGIN=' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | sed -E 's#^(https?://[^/]+).*#\1#' || true; }
schema_sum() { (cd "$1" && cat $SCHEMA_FILES 2>/dev/null | sha256sum | cut -d' ' -f1); }

checks() {
  local h="" card code html asset o host n i running url
  for i in $(seq 1 45); do h=$(curl -fsS -m 5 http://127.0.0.1:8890/health 2>/dev/null) && break; sleep 2; done
  [[ "$h" == *'"ok":true'* ]] && pass "health 127.0.0.1:8890 $h" || bad "health 127.0.0.1:8890 (${h:-no response})"
  running=$(compose "$ROOT/current" ps --status running --services 2>/dev/null || true)
  for s in $SERVICES; do grep -qx "$s" <<<"$running" && pass "container $s running" || bad "container $s not running"; done
  n=0; for i in $(seq 1 30); do n=$(sql "SELECT count(*) FROM workers WHERE enabled AND seen_at>now()-interval '30 seconds'" 2>/dev/null || echo 0); [ "${n:-0}" -ge 1 ] && break; sleep 2; done
  [ "${n:-0}" -ge 1 ] && pass "runners online: $n" || bad "no runner heartbeat in 60s"
  html=$(curl -fsS -m 10 http://127.0.0.1:8890/ 2>/dev/null || true); asset=$(grep -oE '/assets/[^"]+\.js' <<<"$html" | head -1 || true)
  [ -n "$asset" ] && curl -fsS -o /dev/null -m 10 "http://127.0.0.1:8890$asset" && pass "web workbench served ($asset)" || bad "web workbench page/asset"
  curl -fsS -m 10 http://127.0.0.1:8890/admin/ 2>/dev/null | grep -q 'app.js' && pass "admin console served" || bad "admin console page"
  o=$(origin)
  if [ "${1:-}" = new ]; then
    card=$(curl -fsS -m 10 http://127.0.0.1:8890/.well-known/agent-card.json 2>/dev/null || true)
    url=$(grep -oE '"url":"[^"]*/v1/a2a"' <<<"$card" | head -1 | cut -d'"' -f4 || true)
    if [[ "$card" == *'"streaming":true'* && -n "$url" ]]; then pass "A2A agent card (streaming) url=$url"; else bad "A2A agent card missing or not streaming"; fi
    if [[ "$o" == https://* ]]; then [ "$url" = "$o/v1/a2a" ] && pass "agent card advertises https ($o/v1/a2a)" || bad "agent card advertises '$url', expected $o/v1/a2a"; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{"id":"x"}}' http://127.0.0.1:8890/v1/a2a || true)
    [ "$code" = 401 ] && pass "A2A endpoint rejects anonymous calls (401)" || bad "A2A anonymous call returned $code (expected 401)"
  fi
  if [[ "$o" == https://* ]]; then
    host=${o#https://}; host=${host%%:*}
    curl -fsS -m 10 --connect-to "$host:443:127.0.0.1:443" "https://$host/health" 2>/dev/null | grep -q '"ok":true' && pass "public HTTPS via nginx https://$host/health" || bad "public HTTPS via nginx https://$host/health"
    if [ "${1:-}" = new ]; then
      curl -fsS -m 10 --connect-to "$host:443:127.0.0.1:443" "https://$host/.well-known/agent-card.json" 2>/dev/null | grep -q "\"url\":\"https://$host/v1/a2a\"" && pass "agent card via nginx (https url)" || bad "agent card via nginx (https url)"
    fi
  fi
}
summary() { printf '\n===== SUMMARY: %s =====\n' "$1"; printf '%s\n' "${RESULTS[@]}"; }

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
# Optional release "deploy-<sha7>": <sha7>-cloud-dist.tar.gz + SHA256SUMS (which may also carry "<tree>  cloud-dist.tree").
REF_TREE=""
fetch_sums() {
  local base="https://github.com/$REPO/releases/download/deploy-${SHA:0:7}"
  curl -fsSL --retry 2 --connect-timeout 15 "$base/SHA256SUMS" -o "$NEW/.sums" 2>/dev/null || { rm -f "$NEW/.sums"; return 1; }
  REF_TREE=$(grep -E '^[0-9a-f]{64}  cloud-dist\.tree$' "$NEW/.sums" | cut -d' ' -f1 || true)
}
fetch_dist() {
  local base="https://github.com/$REPO/releases/download/deploy-${SHA:0:7}" f=${SHA:0:7}-cloud-dist.tar.gz line
  echo "downloading prebuilt cloud-dist asset from release deploy-${SHA:0:7} (sha256 via its SHA256SUMS)"
  [ -f "$NEW/.sums" ] || fetch_sums || { echo "no release deploy-${SHA:0:7}"; return 1; }
  line=$(grep -E "^[0-9a-f]{64}  $f\$" "$NEW/.sums" || true); [ -n "$line" ] || { echo "no checksum for $f"; return 1; }
  curl -fsSL --retry 3 --connect-timeout 20 "$base/$f" -o "$NEW/.cloud-dist.tgz" || return 1
  echo "${line%% *}  $NEW/.cloud-dist.tgz" | sha256sum -c --quiet - || { rm -f "$NEW/.cloud-dist.tgz"; return 1; }
  rm -rf "$NEW/cloud-dist" && tar -xzf "$NEW/.cloud-dist.tgz" -C "$NEW" && rm -f "$NEW/.cloud-dist.tgz"
}

resolve_target() { # sets SHA (full), REL, NEW, STATE; downloads the source tree if needed
  local ref=$1 tmp top d
  [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]] || die "usage: bash $SELF <commit-sha>|rollback|status (got '$ref')"
  for d in "$ROOT"/releases/*-"${ref:0:7}"*; do # reuse a complete earlier download of the same commit
    [ -f "$d/.source-ok" ] && [[ "$(cat "$d/.source-ok")" == "$ref"* ]] && { SHA=$(cat "$d/.source-ok"); REL=$(basename "$d"); break; }
  done
  if [ -z "$REL" ]; then
    tmp=$ROOT/releases/.download-${ref:0:7}; rm -rf "$tmp" && mkdir -p "$tmp"
    curl -fsSL --retry 3 --connect-timeout 20 "https://codeload.github.com/$REPO/tar.gz/$ref" | tar -xz -C "$tmp" || die "source download failed for $ref"
    top=$(ls "$tmp"); SHA=${top##*-}
    [[ "$SHA" =~ ^[0-9a-f]{40}$ && "$SHA" == "$ref"* ]] || die "unexpected archive layout ($top)"
    [ -f "$tmp/$top/infra/tencent/compose.yml" ] && [ -f "$tmp/$top/infra/cloud/Dockerfile" ] || die "source tree incomplete"
    REL=$(date +%Y%m%d)-${SHA:0:7}
    [ -e "$ROOT/releases/$REL" ] && mv "$ROOT/releases/$REL" "$ROOT/releases/$REL.stale-$(date +%s)"
    mv "$tmp/$top" "$ROOT/releases/$REL" && rmdir "$tmp" && echo "$SHA" > "$ROOT/releases/$REL/.source-ok"
  fi
  NEW=$ROOT/releases/$REL; STATE=$ROOT/releases/.before-$REL
}

deploy() {
  local START CUR PREV active queued avail dump cfg entries got i
  START=$(date +%s)
  step "0/7 preflight"
  for c in docker curl tar sha256sum timeout; do command -v $c >/dev/null || die "missing command: $c"; done
  docker compose version >/dev/null || die "docker compose plugin missing"
  [ -f "$ENVF" ] || die "missing $ENVF"
  [ -L "$ROOT/current" ] || die "$ROOT/current is not a symlink"
  docker volume inspect pig-agent-cloud_database >/dev/null 2>&1 || die "volume pig-agent-cloud_database not found (refusing: would start an empty DB)"
  avail=$(df -Pk "$ROOT" | awk 'NR==2{print int($4/1048576)}')
  [ "$avail" -ge 5 ] || die "only ${avail}G free (need 5G)"
  active=$(sql "SELECT count(*) FROM runs WHERE state IN ('preparing','running','cancelling')" || echo "?")
  queued=$(sql "SELECT count(*) FROM runs WHERE state='queued'" || echo "?")
  echo "disk free ${avail}G; runs running=$active queued=$queued"
  if [ "$active" != 0 ] && [ "${FORCE:-0}" != 1 ]; then die "$active task(s) running — wait for them or re-run with FORCE=1"; fi

  step "1/7 source $REPO@$CMD"
  resolve_target "$CMD"
  CUR=$(readlink -f "$ROOT/current")
  if [ "$CUR" = "$NEW" ]; then
    [ -f "$STATE" ] || die "current already points at $REL but $STATE is missing"
    PREV=$(cat "$STATE"); echo "re-run: current already $REL"
  else PREV=$CUR; echo "$PREV" > "$STATE"; fi
  [ -d "$PREV" ] || die "previous release $PREV missing"
  echo "$REL" > "$LAST"
  pass "source $REPO@${SHA:0:12} in releases/$REL (previous: $(basename "$PREV"); running tasks=$active)"

  step "2/7 backup db + config (existing backup.sh)"
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

  step "3/7 cloud-dist"
  fetch_sums || true
  if [ -f "$NEW/cloud-dist/cloud.mjs" ] && [ -f "$NEW/.dist-ok" ] && [ "$(cat "$NEW/.dist-ok")" = "$(tree_sha "$NEW/cloud-dist")" ]; then echo "reusing verified cloud-dist"
  elif [ "${CLOUD_DIST:-build}" = build ] && build_dist; then echo "server build finished"
  else echo "server build skipped/failed -> prebuilt asset"; fetch_dist || die "cloud-dist: build failed and no verified release asset"; fi
  [ -f "$NEW/cloud-dist/cloud.mjs" ] || die "cloud-dist incomplete"
  got=$(tree_sha "$NEW/cloud-dist"); echo "$got" > "$NEW/.dist-ok"
  if [ -z "$REF_TREE" ]; then pass "cloud-dist ready (tree sha256 ${got:0:12}; no published reference to compare)"
  elif [ "$got" = "$REF_TREE" ]; then pass "cloud-dist ready, matches published reference build (tree sha256 ${got:0:12})"
  else pass "cloud-dist ready (WARN: tree ${got:0:12} differs from published reference ${REF_TREE:0:12})"; fi

  step "4/7 keep data/ and stack.env; schema diff"
  if [ -e "$PREV/data" ] && [ ! -e "$NEW/data" ]; then ln -s "$(readlink -f "$PREV/data")" "$NEW/data"; echo "linked data/ like previous release"; fi
  if [ "$(schema_sum "$PREV")" = "$(schema_sum "$NEW")" ]; then echo same > "$STATE.schema"; else echo changed > "$STATE.schema"; fi
  pass "data/ untouched ($ROOT/data + docker volumes), stack.env $(wc -l <"$ENVF") lines (not printed); schema files vs previous: $(cat "$STATE.schema")"

  step "5/7 tag running images as before-$REL"
  for i in $IMAGES; do
    if docker image inspect "$i:before-$REL" >/dev/null 2>&1; then echo "$i:before-$REL already exists (kept)"
    elif docker image inspect "$i:local" >/dev/null 2>&1; then docker tag "$i:local" "$i:before-$REL"; echo "tagged $i:before-$REL"; fi
  done
  pass "rollback images tagged"

  step "6/7 switch current -> $REL; docker compose up -d --build --wait"
  relink "$NEW"; SWITCHED=1
  echo "current -> $(readlink "$ROOT/current")"
  if up_current --build; then pass "compose up --build --wait"
  else bad "compose up --build --wait (see: docker compose ... logs --tail=100 cloud worker gateway)"; fi

  step "7/7 checks"
  checks new
  summary "deploy $REL ($(( ($(date +%s) - START) / 60 )) min)"
  if [ "$FAILS" != 0 ]; then echo "DEPLOY FAIL ($FAILS) — roll back with: bash $SELF rollback"; echo "log: $LOG"; exit 1; fi
  echo "DEPLOY OK — previous release kept: $PREV ; rollback: bash $SELF rollback"
  if [ "${SKIP_E2E:-0}" = 1 ] || [ ! -f "$HERE/e2e-remote.sh" ]; then echo "e2e: bash $HERE/e2e-remote.sh"
  elif [ -n "${PIG_REMOTE_ADMIN_PASSWORD:-}" ] || grep -q '^Password:' "$ACC" 2>/dev/null; then
    step "e2e (bash $HERE/e2e-remote.sh)"; bash "$HERE/e2e-remote.sh" || true
  else echo "e2e: skipped here (no stored admin password on this server); run from another machine: PIG_BASE=$(origin) PIG_REMOTE_ADMIN_PASSWORD=... bash e2e-remote.sh"; fi
  echo "log: $LOG"
}

rollback() {
  local PREV CUR flag=--no-build i
  [ -f "$LAST" ] || die "no $LAST (nothing deployed with this script)"
  REL=$(cat "$LAST"); STATE=$ROOT/releases/.before-$REL
  [ -f "$STATE" ] || die "no $STATE"
  PREV=$(cat "$STATE"); CUR=$(readlink -f "$ROOT/current")
  [ -d "$PREV" ] || die "previous release $PREV missing"
  [ "$CUR" != "$PREV" ] || die "current already points at $(basename "$PREV") (already rolled back)"
  echo "rolling back $REL -> $(basename "$PREV")"
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
  if up_current $flag; then pass "compose up $flag --wait"; else bad "compose up $flag --wait"; fi
  step "4/4 checks"
  checks old
  summary "rollback $REL -> $(basename "$PREV")"
  case "$(cat "$STATE.schema" 2>/dev/null)" in
    same) echo "Database NOT restored: $REL changed no schema files, so the previous code runs on the current DB." ;;
    *) echo "Database NOT restored. WARNING: $REL changed schema files; check that the previous code tolerates the current DB." ;;
  esac
  echo "Only if pre-deploy data must come back (overwrites newer data; confirm first): dump at $(cat "$STATE.dump" 2>/dev/null || echo "backups/before-$REL/")"
  [ "$FAILS" = 0 ] && echo "ROLLBACK OK" || { echo "ROLLBACK FAIL ($FAILS)"; exit 1; }
}

case "$CMD" in
  rollback) rollback ;;
  status) checks new; summary status ;;
  ""|-h|--help) echo "usage: bash $SELF <commit-sha> | rollback | status"; exit 2 ;;
  *) deploy ;;
esac
