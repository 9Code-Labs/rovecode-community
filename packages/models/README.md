# @rovecode-labs/models

Offline model catalog for terminal agents: context windows, pricing (including prompt-size tiers),
capabilities and provider env-var names — trimmed from [models.dev](https://models.dev) and shipped
with the package, so the first lookup costs ~1.7 ms and no network.

```ts
import { ModelCatalog, resolveContextWindow, keyNameFor } from "@rovecode-labs/models";

const catalog = new ModelCatalog();

catalog.lookup("anthropic", "claude-opus-5");
// → { contextWindow: 1_000_000, maxOutput: 128_000,
//     pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
//     supportsTools: true, supportsReasoning: true, source: "models.dev" }

catalog.modelsFor("anthropic");          // every model id the catalog knows for a provider
catalog.supportsImages("openai", "gpt-5.4");

resolveContextWindow(catalog, spec, provider, model);
// config (per-model, then provider-wide) → catalog → an explicit 128k assumption, marked as assumed

keyNameFor("anthropic"); // → "ANTHROPIC_API_KEY"  (the env var a key is read from)
```

## What makes it different

- **The data ships with the package.** 213 providers / 7,527 models, trimmed to the six fields an agent
  actually reads, split into a 138 KB hot file (the providers every built-in maps to) and a lazily
  loaded extra file (the other 196 — reachable: a hand-registered provider id is tried as its own
  models.dev key).
- **Honest unknowns.** A model that is not in the catalog resolves to `undefined`, never to a guess;
  the context-window fallback is explicit and marked `source: "assumed"`.
- **Pricing tiers models.dev has no field for** — per-request vs marginal repricing past a prompt-size
  threshold (xAI, OpenAI, Gemini), each with the vendor page and the day it was read.
- **A local overlay with provenance** for ids the snapshot lacks (DeepSeek's API aliases, retired xAI
  slugs) — every row names the page it was read from and when, and `source: "local"` says so.

## Live refresh (opt-in)

```ts
const catalog = new ModelCatalog({ fetchFn: fetch, cacheDir: ".cache/models" });
await catalog.refresh(); // layers https://models.dev/api.json over the bundled data, 24 h disk cache
```

## Requirements

Bun ≥ 1.3 (the package ships TypeScript source and JSON data; the runtime imports both directly).

## Development

This package is developed inside the [rovecode](https://github.com/9Code-Labs/rovecode) monorepo
(`packages/models`) and mirrored here with its full history. Issues and PRs are welcome on either
repository; the monorepo is where the code lands first.

```bash
bun test                          # the package's own suite
bun ../../scripts/build-model-index.mjs --check   # (from the monorepo) the index matches @opencode-ai/models
```
