#!/usr/bin/env bash
# Build a slim source tarball of one commit for deploy.sh --source-tar, on a machine with a git checkout
# (the server's GitHub downloads are slow). docs/ (~49 MB of images, not used by any build or runtime) is left out.
#
#   bash scripts/deploy/pack-source.sh <commit> [out-dir]      -> <out-dir>/pig-src-<sha7>.tgz + .sha256
#
# Prints the upload + detached deploy commands. Only tracked files of the public repo at that commit are packed.
set -euo pipefail
ref=${1:?usage: pack-source.sh <commit> [out-dir]}
out=${2:-.}
SHA=$(git rev-parse --verify "$ref^{commit}")
git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null || echo "WARN: $SHA is not on origin/main" >&2
mkdir -p "$out"
f=$out/pig-src-${SHA:0:7}.tgz
git archive --format=tar --prefix="pig-agent-$SHA/" "$SHA" -- . ':(exclude)docs' | gzip -9n > "$f"
(cd "$out" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
echo "packed $f ($(du -h "$f" | cut -f1)), sha256 $(cut -c1-16 "$f.sha256")…"
R=/home/ubuntu/pig-agent
cat <<CMD
# upload (from this machine):
scp $f $f.sha256 ubuntu@<server>:$R/uploads/
# deploy (on the server, detached):
S=$SHA; cd $R && mkdir -p tools/\$S && tar -xzf uploads/pig-src-\${S:0:7}.tgz -C tools/\$S --strip-components=3 --wildcards '*/scripts/deploy/*' && (setsid nohup bash tools/\$S/deploy.sh \$S --source-tar uploads/pig-src-\${S:0:7}.tgz > backups/deploy-\${S:0:7}.out 2>&1 < /dev/null &) && echo "tail -f $R/backups/deploy-\${S:0:7}.out"
CMD
