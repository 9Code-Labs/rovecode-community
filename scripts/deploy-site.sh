#!/usr/bin/env bash
# Deploy the site to the VPS: build site/ → upload as a new timestamped release → flip the `current`
# symlink → verify over HTTP. Atomic (the symlink flips last) and reversible (`--rollback` points
# `current` at the previous release). Needs key-based SSH to the host; nothing else on the client.
#
#   scripts/deploy-site.sh                 build (landing + /docs/ + /market/, the production build) + deploy
#   scripts/deploy-site.sh --no-docs       build the landing page only (bun run build) + deploy
#   scripts/deploy-site.sh --no-build      deploy the existing site/dist
#   scripts/deploy-site.sh --check         after the flip, walk every URL in the live sitemap (live-check, ~3 min);
#                                          a failing page rolls the release back
#   scripts/deploy-site.sh --rollback      previous release becomes current
#   DEPLOY_HOST=root@1.2.3.4 scripts/deploy-site.sh   another host
set -euo pipefail

# /docs/ ships since 2026-09-04 and /market/ since 2026-09-05 (both Berkay's call); build:all is the production build
BUILD_SCRIPT="build:all"; CHECK=0; NO_BUILD=0
for a in "$@"; do
  case "$a" in
    --no-docs) BUILD_SCRIPT="build" ;;
    --check) CHECK=1 ;;
    --no-build) NO_BUILD=1 ;;
  esac
done

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

if [[ "$NO_BUILD" == 0 ]]; then
  echo "== build ($BUILD_SCRIPT)"
  (cd "$SITE" && bun install --frozen-lockfile > /dev/null && bun run "$BUILD_SCRIPT" 2>&1 | tail -3)
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

if [[ "$CHECK" == 1 ]]; then
  echo "== live-check $URL (every sitemap URL: status, meta, console, axe)"
  # two attempts: a headless-Chromium crash or a network blip must not roll back a good release;
  # the failing rows are printed so a real failure names its page
  ok=0
  for attempt in 1 2; do
    if (cd "$SITE" && node scripts/live-check.mjs "$URL" > /tmp/rovecode-live-check.log 2>&1); then ok=1; break; fi
    echo "-- live-check attempt $attempt failed:"; grep -E "^  (crash|msgs|axe)|false|TOTALS|Error" /tmp/rovecode-live-check.log | head -8
  done
  tail -1 /tmp/rovecode-live-check.log
  if [[ "$ok" == 0 ]]; then
    echo "live-check failed twice — rolling back"
    "$0" --rollback
    exit 1
  fi
fi
