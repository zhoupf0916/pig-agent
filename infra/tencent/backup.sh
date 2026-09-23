#!/bin/sh
# Run as the deployment owner. Backups contain user data; keep them private.
set -eu
umask 077
root=${PIG_DEPLOY_ROOT:-/home/ubuntu/pig-agent}
mkdir -p "$root/backups/daily"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$root/backups/daily/$stamp.dump"
cd "$root/current"
docker compose --env-file "$root/data/cloud-local/stack.env" -f infra/cloud/compose.yml -f infra/tencent/compose.yml exec -T postgres pg_dump -U pig -Fc pig > "$output.partial"
docker compose --env-file "$root/data/cloud-local/stack.env" -f infra/cloud/compose.yml -f infra/tencent/compose.yml exec -T postgres pg_restore --list < "$output.partial" > /dev/null
mv "$output.partial" "$output"
# Required to decrypt stored model credentials when restoring the database.
tar -czf "$root/backups/daily/$stamp-config.tar.gz" -C "$root" data/cloud-local/stack.env
