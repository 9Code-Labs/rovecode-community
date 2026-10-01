# 0001 — The model index ships in three files, and every models.dev provider is reachable

Date: 2026-09-30 · Status: landed

## What changed

`src/providers/models-index.json` (one 1.4 MB file, 213 providers / 7,527 models) became three
generated files, and `catalog.ts` gained a third lookup candidate:

- **models-index.json** — the 17 providers `provider-map.ts` and the built-in table can name
  (678 models, 138 KB). The catalog's common path; loaded on the first lookup.
- **models-index-extra.json** — the other 196 providers, same shape (1.4 MB). Loaded on the first
  lookup whose key is absent from the hot file, which is a hand-registered vendor id.
- **models-manifest.json** — every provider's env-var name and model count, 12 KB. `auth.ts`
  `keyNameFor` reads this; it used to parse the whole 1.4 MB index for one string, on the
  provider-config path (`buildSnapshot` asks `keyNameFor` for every provider without a keyEnv).

`resolve()` now tries the provider id **itself** as a models.dev key when no table entry translates
it (after the explicit map and the vendor prefix). That is what makes the extra file worth shipping:
`rovecode provider add kilo <url>` prices and reports context windows with no table edit. Before the
split those 196 providers were embedded in every install and every binary and were *unreachable* —
`resolve()` had no candidate for them at all.

## Why, measured

On this machine (Windows, bun 1.3.14):

- first catalog lookup, before: 53 ms, +6 MB resident (parse of the full 1.4 MB)
- after: hot path ~1.7 ms / 138 KB; the extra parse (~12 ms / 1.3 MB) happens only for a
  hand-registered vendor, once per process
- manifest: ~0.7 ms vs ~12 ms for `keyNameFor`'s data
- `dist/cli` stops carrying a second copy of the index on disk (the bundler inlines the catalog's
  literal `require`s; only the manifest is copied, because `createRequire(import.meta.url)` stays a
  runtime lookup). Verified by deleting the files from `dist/cli` and re-pricing a model.

The fallback needs BOTH the id and the model to exist under the same key, so a custom proxy that
shares a vendor's name picks up that vendor's rows only for model ids that vendor actually serves —
and `model show` names the source, so the numbers are never mistaken for a measurement of the
endpoint in front of them.

## Invariants, pinned by tests

`test/unit/model-index-split.test.ts`:

- hot ∪ extra is exactly the snapshot; hot ∩ extra is empty (the `hot[key] ?? extra[key]` gate in
  `findIn` is only safe while this holds)
- every key `provider-map.ts` names is in hot — a mapped lookup must never pay the extra parse
- a mapped-only session never opens the extra file (asserted in a subprocess: module-global lazy
  state cannot be tested in-process)
- an unmapped id that IS a models.dev provider resolves (context window from the extra file); an
  unmapped id that is NOT still resolves to nothing, without throwing

`bun scripts/build-model-index.mjs --check` compares all three files against the installed
`@opencode-ai/models` — the generator imports `provider-map.ts` and `provider-config.ts` directly
(runs under bun), so the partition cannot drift from the table that decides reachability.

## The two provider-key maps deliberately did NOT merge

`auth.ts` keeps `AUTH_PROVIDER_MAP` (together→togetherai, fireworks→fireworks-ai, moonshot→moonshotai)
separate from catalog's `PROVIDER_MAP`. They answer different questions: the catalog's map is about
*pricing* (gemini → google's price rows), auth's is about *the env var a human actually sets*
(`GEMINI_API_KEY`, not `GOOGLE_API_KEY`). Merging them would change `keyNameFor("gemini")` and
`keyNameFor("alibaba")` — a real behavior change for existing setups, deferred to its own decision.
