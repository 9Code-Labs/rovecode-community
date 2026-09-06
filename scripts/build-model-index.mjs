/** Trim the models.dev snapshot down to the fields rovecode actually reads.
 *
 *   node scripts/build-model-index.mjs            regenerate src/providers/models-index.json
 *   node scripts/build-model-index.mjs --check    fail if the committed file is not what this produces
 *
 *  Why this exists, measured rather than assumed. `@opencode-ai/models/snapshot` is 4.26 MB of JSON —
 *  213 providers, 7,527 models, each with modalities, knowledge cutoffs, release dates, weights and so
 *  on. Parsing it costs **55 MB resident**, and it is parsed on the FIRST `ModelCatalog.lookup()` — which
 *  in a TUI session is the first status update, about a second in. So every rovecode session was paying
 *  55 MB to answer "what is this model's context window and price".
 *
 *  Of that database rovecode reads six things per model — `limit.context`, `limit.output`, `cost`,
 *  `tool_call`, `reasoning` and `modalities.input` — and one thing per provider, `env[0]`, for the
 *  environment variable a key is read from. Kept to those, the same data is about a megabyte.
 *
 *  The list is exact and it is load-bearing: the first version of this script omitted `modalities.input`
 *  and vision detection quietly began answering "unknown" for every model. If you add a field to the
 *  catalog's reader, add it here, and trust the tests rather than this comment to tell you.
 *
 *  The output deliberately keeps the SHAPE of the upstream snapshot rather than a tidier one of its own:
 *  `toModelInfo` in catalog.ts and everything downstream of it then work unchanged, and the diff that
 *  introduced this is a one-line change of where the data is read from. A nicer schema would have been a
 *  bigger change for no gain a user could see.
 *
 *  Regenerate it when `@opencode-ai/models` is upgraded. `--check` is the guard: it fails when the
 *  committed file and the installed package disagree, so an upgrade cannot quietly leave the catalog
 *  describing the previous release. */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "providers", "models-index.json");
const CHECK = process.argv.includes("--check");

const require_ = createRequire(import.meta.url);
// the package does not export ./package.json, so its version is read off disk rather than imported
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@opencode-ai", "models", "package.json");
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

const trimmed = trim(providers);
const modelCount = Object.values(trimmed).reduce((n, p) => n + Object.keys(p.models).length, 0);
const doc = {
  // provenance in the file itself: a generated artefact that cannot say what produced it is a liability
  generatedFrom: `@opencode-ai/models@${pkg.version}`,
  generatedBy: "scripts/build-model-index.mjs",
  note: "Trimmed to the fields rovecode reads. Regenerate after upgrading @opencode-ai/models; --check guards it.",
  providers: trimmed,
};
const text = JSON.stringify(doc) + "\n";

if (CHECK) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing counts as different */ }
  if (current === text) {
    console.log(`models-index.json is current: ${Object.keys(trimmed).length} providers, ${modelCount} models, ${(text.length / 1024).toFixed(0)} KB`);
    process.exit(0);
  }
  console.error("models-index.json does not match @opencode-ai/models@" + pkg.version + " — run: node scripts/build-model-index.mjs");
  process.exit(1);
}

writeFileSync(OUT, text);
console.log(`models-index.json: ${Object.keys(trimmed).length} providers, ${modelCount} models, ${(text.length / 1024).toFixed(0)} KB (from @opencode-ai/models@${pkg.version})`);
