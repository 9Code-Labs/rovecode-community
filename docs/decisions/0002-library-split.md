# 0002 — Libraries split out of the monorepo and published as public repos

Date: 2026-09-30 · Status: landed (first extraction: `@rovecode-labs/models`)

## The shape

rovecode stays one repository. Libraries live in `packages/<name>/` INSIDE it (bun workspaces), and each
is mirrored to its own public GitHub repo under the 9Code-Labs org with `git subtree split` — the
package's history, authorship and commit messages travel with it. Content flows one way, monorepo →
public repo, exactly like the site (`scripts/publish-site-data.sh` → 9Code-Labs/rovecode-site). A PR
against the public repo is answered by the subtree: accepted by re-applying it here, never by letting
the two histories fork.

Why not separate source-of-truth repos: the libraries exist because rovecode's own surfaces need them
(the catalog is the pricing source of `/cost`, the usage panel and `model show`). A library that lives
elsewhere drifts the day a refactor here lands without the corresponding release there; a library that
lives HERE ships every improvement the day it lands, and the mirror is a `git subtree push` away.

npm scope is `@rovecode-labs` (the api-sdk precedent), licence MIT (the libraries are meant to be
embedded; the app stays AGPL), engines bun — the packages ship TypeScript source like the app does.

## The order (by coupling, ascending)

1. **`@rovecode-labs/models`** (`packages/models`) — the model catalog: provider-map, the local price
   overlay, the three-file index + generator, context windows, keyNameFor. Zero imports from rovecode
   beyond a structural type pick; useful to any terminal tool that needs "what is this model's context
   window and price" offline. Extracted in this commit.
2. `@rovecode-labs/markdown-cells` — sextant's markdown→cell renderer. Needs a small Theme interface
   extracted from sextant's theme.ts first.
3. `@rovecode-labs/providers` — registry/auth/stream. Coupled to core/types.ts; only worth doing once
   the types it shares are themselves a package or the seam is narrowed.

## What an extraction must prove

- the monorepo's own suite passes importing the package by NAME (`@rovecode-labs/models`), not by path
- `bun run build:cli` still bundles (JSON index files embed; the manifest copy step follows the move)
- the single binary still answers a manifest-backed lookup (the `zai → ZHIPU_API_KEY` probe)
- the package's own tests run standalone from its directory (the public repo's CI runs exactly those)
- `scripts/publish-libs.sh <name>` subtree-pushes the package to its public repo, and is a no-op when
  nothing changed
