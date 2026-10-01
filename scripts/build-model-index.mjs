#!/usr/bin/env bun
/** Trim the models.dev snapshot down to the fields rovecode actually reads, and split it by how
 *  likely rovecode is to read it.
 *
 *   bun scripts/build-model-index.mjs            regenerate the three files under src/providers/
 *   bun scripts/build-model-index.mjs --check    fail if the committed files are not what this produces
 *
 *  WHY THIS EXISTS, measured rather than assumed. `@opencode-ai/models/snapshot` is 4.26 MB of JSON —
 *  213 providers, 7,527 models, each with modalities, knowledge cutoffs, release dates, weights and so
 *  on. Parsing it costs **55 MB resident**, and it is parsed on the FIRST `ModelCatalog.lookup()` — which
 *  in a TUI session is the first status update, about a second in. So every rovecode session was paying
 *  55 MB to answer "what is this model's context window and price".
 *
 *  Of that database rovecode reads six things per model — `limit.context`, `limit.output`, `cost`,
 *  `tool_call`, `reasoning` and `modalities.input` — and one thing per provider, `env[0]`, for the
 *  environment variable a key is read from. Kept to those, the same data is 1.4 MB and parses in ~12 ms.
 *
 *  WHY THREE FILES. The trimmed 1.4 MB was still ten times what a session touches: catalog.ts resolves a
 *  provider through provider-map.ts, and that table plus the built-ins name **17 providers / 678 models /
 *  138 KB — 9% of the index, 1.7 ms to parse**. The other 196 providers were shipped, embedded in the
 *  single binary, and unreachable: resolve() had no candidate for an id the table did not translate, so
 *  `provider add kilo` priced nothing at all. Both halves of that were wrong, so:
 *
 *    models-manifest.json       every provider's env name and model count (12 KB, ~0.7 ms). auth.ts
 *                               keyNameFor reads this — it wants ONE string and was parsing 1.4 MB for it
 *    models-index.json          the mapped providers, with full model rows. The catalog's common path
 *    models-index-extra.json    the other 196, same rows. Loaded on the first lookup that misses the hot
 *                               file — reachable now that resolve() tries the provider id itself
 *
 *  The hot set is IMPORTED from provider-map.ts and provider-config.ts rather than restated here, so the
 *  partition cannot drift from the table that decides reachability. `--check` is the guard on the other
 *  axis: it fails when the committed files and the installed package disagree, so an upgrade cannot
 *  quietly leave the catalog describing the previous release. That is why this script runs under bun —
 *  it imports TypeScript, and node cannot.
 *
 *  The list of kept fields is exact and it is load-bearing: the first version of this script omitted
 *  `modalities.input` and vision detection quietly began answering "unknown" for every model. If you add
 *  a field to the catalog's reader, add it here, and trust the tests rather than this comment to tell you.
 *
 *  The output deliberately keeps the SHAPE of the upstream snapshot rather than a tidier one of its own:
 *  `toModelInfo` in catalog.ts and everything downstream of it then work unchanged, and the diff that
 *  introduced this is a one-line change of where the data is read from. A nicer schema would have been a
 *  bigger change for no gain a user could see.
 *
 *  Regenerate it when `@opencode-ai/models` is upgraded, or when provider-map.ts gains an entry. */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mappedProviderKeys } from "../packages/models/src/provider-map.ts";
import { BUILTIN_PROVIDERS } from "../src/providers/provider-config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = {
  manifest: join(HERE, "..", "packages", "models", "src", "models-manifest.json"),
  hot: join(HERE, "..", "packages", "models", "src", "models-index.json"),
  extra: join(HERE, "..", "packages", "models", "src", "models-index-extra.json"),
};
const CHECK = process.argv.includes("--check");

const require_ = createRequire(import.meta.url);
// the package does not export ./package.json, so its version is read off disk rather than imported
const pkgPath = join(HERE, "..", "node_modules", "@opencode-ai", "models", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const { providers } = require_("@opencode-ai/models/snapshot");

/** the five per-model fields and the one per-provider field, and nothing else */
function trim(providers) {
  const out = {};
  for (const [pid, p] of Object.entries(providers)) {
    const models = {};
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      const e = {};
      const limit = {};
      if (m.limit?.context !== undefined) limit.context = m.limit.context;
      if (m.limit?.output !== undefined) limit.output = m.limit.output;
      if (Object.keys(limit).length > 0) e.limit = limit;
      if (m.cost) {
        const cost = {};
        for (const k of ["input", "output", "cache_read", "cache_write"]) if (m.cost[k] !== undefined) cost[k] = m.cost[k];
        if (Object.keys(cost).length > 0) e.cost = cost;
      }
      if (m.tool_call !== undefined) e.tool_call = m.tool_call;
      if (m.reasoning !== undefined) e.reasoning = m.reasoning;
      // only `input` — supportsImages (catalog.ts) asks whether "image" is an accepted input modality,
      // and nothing reads `output`. This field was missed on the first pass and the wire-messages test
      // caught it: vision detection silently answered "unknown" for every model.
      if (Array.isArray(m.modalities?.input)) e.modalities = { input: m.modalities.input };
      models[mid] = e;
    }
    const entry = { models };
    // env is what keyNameFor answers with; only the first name is ever read, so only it is kept
    if (Array.isArray(p.env) && p.env[0]) entry.env = [p.env[0]];
    out[pid] = entry;
  }
  return out;
}

/** which providers ship in the hot file: everything the catalog's tables can name, plus every built-in
 *  id (a built-in that models.dev later gains must not start life behind the lazy parse). Sorted, and
 *  intersected with the snapshot below — an id neither has is simply absent from both files. */
const HOT_IDS = [...new Set([...mappedProviderKeys(), ...BUILTIN_PROVIDERS.map((b) => b.id)])].sort();

const trimmed = trim(providers);

/** the partition. Disjoint and exhaustive by construction, which is what lets catalog.ts skip the extra
 *  file whenever the hot one HAS the key: a key can never be in both. */
const hot = {};
const extra = {};
for (const [pid, entry] of Object.entries(trimmed)) (HOT_IDS.includes(pid) ? hot : extra)[pid] = entry;

const manifest = {};
for (const [pid, entry] of Object.entries(trimmed)) {
  manifest[pid] = { ...(entry.env ? { env: entry.env } : {}), models: Object.keys(entry.models).length };
}

const count = (o) => Object.values(o).reduce((n, p) => n + Object.keys(p.models).length, 0);
const provenance = (which) => ({
  // provenance in the file itself: a generated artefact that cannot say what produced it is a liability
  generatedFrom: `@opencode-ai/models@${pkg.version}`,
  generatedBy: "scripts/build-model-index.mjs",
  note: which,
});

const files = [
  { path: OUT.manifest, text: JSON.stringify({ ...provenance("Every provider's env var name and model count, for auth.ts keyNameFor and for surfaces that report a provider's size without loading its models. Regenerate after upgrading @opencode-ai/models; --check guards it."), providers: manifest }) + "\n" },
  { path: OUT.hot, text: JSON.stringify({ ...provenance(`The ${Object.keys(hot).length} providers provider-map.ts and the built-in table can name — the catalog's common path, loaded on the first lookup. Trimmed to the fields rovecode reads. Regenerate after upgrading @opencode-ai/models or editing provider-map.ts; --check guards it.`), providers: hot }) + "\n" },
  { path: OUT.extra, text: JSON.stringify({ ...provenance(`The other ${Object.keys(extra).length} providers, same shape, same trimming. catalog.ts loads this only when a lookup's provider key is absent from models-index.json — a hand-registered vendor id. Never read by a session that stays on the built-ins.`), providers: extra }) + "\n" },
];

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const summary = `manifest ${Object.keys(manifest).length} providers (${kb(files[0].text.length)}) · hot ${Object.keys(hot).length} providers / ${count(hot)} models (${kb(files[1].text.length)}) · extra ${Object.keys(extra).length} providers / ${count(extra)} models (${kb(files[2].text.length)})`;

if (CHECK) {
  const stale = [];
  for (const f of files) {
    let current = "";
    try { current = readFileSync(f.path, "utf8"); } catch { /* missing counts as different */ }
    if (current !== f.text) stale.push(f.path.replace(/\\/g, "/").split("/").pop());
  }
  if (stale.length === 0) {
    console.log(`model index is current: ${summary} (from @opencode-ai/models@${pkg.version})`);
    process.exit(0);
  }
  console.error(`${stale.join(", ")} does not match @opencode-ai/models@${pkg.version} and the tables in packages/models/src/provider-map.ts — run: bun scripts/build-model-index.mjs`);
  process.exit(1);
}

for (const f of files) writeFileSync(f.path, f.text);
console.log(`model index: ${summary} (from @opencode-ai/models@${pkg.version})`);
