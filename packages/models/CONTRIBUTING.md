# Contributing to @rovecode-labs/models

Thank you for your interest! This package is developed inside the
[rovecode monorepo](https://github.com/9Code-Labs/rovecode) (`packages/models/`) and mirrored here.
Both are valid places to contribute:

- **Issues** — here is fine. Bugs, wrong prices, missing models, a provider that does not resolve.
- **Pull requests** — here or in the monorepo. A PR here is re-applied to the monorepo by a maintainer
  (the mirror is one-way), so small, focused PRs merge fastest.

## The rules that keep this package trustworthy

1. **Numbers need a warrant.** A price or context window comes with the page it was read from and the
   day (`source` / `checked` in `src/catalog-local.ts`). "I saw it on the pricing page on 2026-09-30"
   merges; "I think it's about this" does not.
2. **Unknown is a first-class answer.** Never invent a context window or price to fill a gap — return
   `undefined` and let the caller's fallback say "assumed". A guessed number is how a user overflows a
   request or trusts a stale price.
3. **The index is generated, not edited.** `src/models-*.json` come from
   `scripts/build-model-index.mjs` (in the monorepo). To change what ships, change the generator or
   `@opencode-ai/models`, never the output.
4. **A new provider mapping** goes in `src/provider-map.ts`, and the comment says how its presence in
   the models.dev snapshot was verified (`Object.keys` of the snapshot, not a guess).

## Running the tests

```bash
bun install
bun test
```

The suite is offline by design: anything that fetches is replaced or faked in the test itself.

## Style

The package follows the monorepo's conventions: strict TypeScript (`noUncheckedIndexedAccess`),
no new dependencies without a measured reason, and comments that say *why*, with the number or the
link that backs the claim.
