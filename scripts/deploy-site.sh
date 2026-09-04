#!/usr/bin/env bash
# Deploy the site to the VPS: build site/ → upload as a new timestamped release → flip the `current`
# symlink → verify over HTTP. Atomic (the symlink flips last) and reversible (`--rollback` points
# `current` at the previous release). Needs key-based SSH to the host; nothing else on the client.
#
#   scripts/deploy-site.sh                 build + deploy
#   scripts/deploy-site.sh --no-build      deploy the existing site/dist
#   scripts/deploy-site.sh --rollback      previous release becomes current
#   DEPLOY_HOST=root@1.2.3.4 scripts/deploy-site.sh   another host
set -euo pipefail

HOST="${DEPLOY_HOST:-root@64.177.43.110}"
ROOT="${DEPLOY_ROOT:-/var/www/rovecode}"
URL="${DEPLOY_URL:-http://${HOST#*@}/}"
KEEP="${DEPLOY_KEEP:-5}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$HERE/site"
SSH=(ssh -o BatchMode=yes "$HOST")

if [[ "${1:-}" == "--rollback" ]]; then
  "${SSH[@]}" "set -e; cd $ROOT/releases; cur=\$(basename \$(readlink $ROOT/current)); prev=\$(ls -1 | grep -v placeholder | grep -B1 -x \"\$cur\" | head -1);
    [ -n \"\$prev\" ] && [ \"\$prev\" != \"\$cur\" ] || { echo 'no previous release'; exit 1; };
    ln -sfn $ROOT/releases/\$prev $ROOT/current; echo \"current → \$prev (was \$cur)\""
  exit 0
fi

if [[ "${1:-}" != "--no-build" ]]; then
  echo "== build"
  (cd "$SITE" && bun install --frozen-lockfile > /dev/null && bun run build 2>&1 | tail -3)
fi
[ -f "$SITE/dist/index.html" ] || { echo "site/dist/index.html missing — build first"; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
REL="$ROOT/releases/$TS"
echo "== upload → $HOST:$REL"
tar -C "$SITE/dist" -czf - . | "${SSH[@]}" "set -e; mkdir -p $REL; tar -xzf - -C $REL; chown -R www-data:www-data $REL;
  ln -sfn $REL $ROOT/current;
  cd $ROOT/releases && ls -1dt */ | grep -v placeholder | tail -n +$((KEEP + 1)) | xargs -r rm -rf;
  echo \"current → $TS · kept: \$(ls -1 | tr '\n' ' ')\""

echo "== verify $URL"
code="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
title="$(curl -s "$URL" | grep -o '<title>[^<]*</title>' | head -1)"
echo "$code $title"
[[ "$code" == "200" ]] || { echo "deploy verify failed"; exit 1; }
