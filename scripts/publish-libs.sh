#!/usr/bin/env bash
# Mirror a packages/<name>/ library to its public repo, with its full history.
#
#   scripts/publish-libs.sh models               split packages/models and push to its public repo
#   scripts/publish-libs.sh models --dry-run     split, show what would land, push nothing
#   LIB_REPO_models=git@github.com:… scripts/publish-libs.sh models   # override the remote
#
# HOW. `git subtree split` rewrites the monorepo history into a synthetic history containing ONLY the
# commits that touched packages/<name>, with the package directory as the root — authorship, messages
# and dates travel verbatim. The split is deterministic and incremental, so a push fast-forwards the
# public repo: the libraries stay updated as rovecode evolves by re-running this after a merge, which
# is the job of whoever lands the change (or a weekly automation — the same one that can run it).
#
# ONE WAY. The public repo is a mirror: it receives, it does not send. A PR opened against it is
# re-applied to the monorepo by a maintainer (packages/models/CONTRIBUTING.md says so to its readers);
# pushing back from here would rewrite their merge. If the remote has diverged (someone pushed there
# directly), the push fails non-fast-forward — stop, pull the remote's head into the monorepo as a
# patch on packages/<name>, and split again. Never --force over it.
#
# The mapping lives here (not in a config file) because the list IS the contract — a package not in it
# is not public:
set -euo pipefail

NAME="${1:-}"
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; esac; done

case "$NAME" in
  models) PREFIX="packages/models"; REMOTE="${LIB_REPO_models:-https://github.com/9Code-Labs/rovecode-models.git}" ;;
  ""|-*) echo "usage: scripts/publish-libs.sh <name> [--dry-run]   (known: models)"; exit 2 ;;
  *) echo "unknown library \"$NAME\" — add it to the case in scripts/publish-libs.sh"; exit 2 ;;
esac

cd "$(dirname "$0")/.."
[ -d "$PREFIX" ] || { echo "no $PREFIX here"; exit 2; }
# a dirty tree would split a state nobody committed — the mirror must always name a commit on main
git diff --quiet HEAD -- "$PREFIX" || { echo "$PREFIX has uncommitted changes — commit first"; exit 1; }

echo "== split $PREFIX"
SHA="$(git subtree split --prefix="$PREFIX" HEAD)"
echo "  $SHA ($(git log -1 --format=%s "$SHA" | head -c 72))"

if [ "$DRY" = 1 ]; then
  echo "== --dry-run: the commits that would land"
  # the ones the remote does not have yet — unreachable means "all of them" for a fresh repo
  git log --oneline "$(git ls-remote "$REMOTE" main 2>/dev/null | cut -f1 || true).." "$SHA" 2>/dev/null || git log --oneline "$SHA" | head -20
  exit 0
fi

echo "== push → $REMOTE main"
git push "$REMOTE" "$SHA:refs/heads/main"
echo "published → $REMOTE"
