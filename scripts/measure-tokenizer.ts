/** Measure our two estimators against a provider's own tokenizer, on text of the kinds we actually send.
 *
 *  We budget with two different guesses — `estimateTokens` (chars/4) drives compaction, `countTokens`
 *  (o200k) drives the reports — and neither is Anthropic's tokenizer. `rovecode context --exact` showed
 *  the gap is not small on this repository's prompt, so this script turns one observation into a table:
 *  for each sample, what each estimator says and what the provider counts.
 *
 *  It is a measuring instrument, not a build step. It spends the user's key, so it runs only when asked:
 *      bun scripts/measure-tokenizer.ts [--provider anthropic] [--model claude-sonnet-5] [--json]
 *
 *  The numbers it prints are the evidence for any scale factor rovecode applies. A multiplier chosen
 *  without a table like this one is a guess wearing a decimal point. */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { countPromptRemotely } from "../src/core/count-remote.ts";
import { countTokens } from "../src/core/usage.ts";
import { estimateTokens } from "../src/core/context.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createRuntime } from "../src/cli/runtime.ts";
import type { Message } from "../src/core/types.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : fallback;
};
const cwd = process.cwd();
const providerId = flag("provider", "anthropic");
const model = flag("model", "claude-sonnet-5");

const read = (p: string): string => readFileSync(join(cwd, p), "utf8");

/** the prompt's two fixed rows, taken from the runtime a real run would build.
 *  The runtime opens a session directory whether or not anything is written to it, so this removes the
 *  one it made: a measuring instrument that leaves a session behind would show up as the newest one in
 *  the next `rovecode context`, i.e. the tool would corrupt the thing it measures. */
function fixedRows(): { system: string; schemas: string } {
  const sessionId = `measure-tokenizer-${process.pid}`;
  try {
    const rt = createRuntime({ cwd, stream: null, sessionId });
    const schemas = JSON.stringify(rt.registry.list().map((t) => t.schema));
    const def = rt.buildDef({ provider: providerId, model, effort: "auto" });
    const system = typeof def.systemPrompt === "string" ? def.systemPrompt : def.systemPrompt({});
    return { system, schemas };
  } finally {
    rmSync(join(cwd, ".rovecode", "sessions", sessionId), { recursive: true, force: true });
  }
}

const { system, schemas } = fixedRows();

/** Market and skill documentation: headings, bullets, fenced code and tables in one document. This is
 *  the text that actually lands in a window when a model opens a skill, and it tokenizes worse than
 *  either prose or code alone — nimbus-24 measured 19 skill bodies and found ratios above the ceiling
 *  the first six samples produced. A sample set that omits the most common content is not conservative,
 *  it is simply wrong in the expensive direction. */
function marketDocs(count: number): { name: string; text: string }[] {
  try {
    // The site lives in its own repository (9Code-Labs/rovecode-site) since 2026-09-06, so the catalog
    // is not in this checkout. SITE_DIR points at it; the default is the sibling clone that
    // scripts/publish-site-data.sh already assumes.
    const siteDir = process.env.SITE_DIR ?? `${process.cwd()}/../rovecode-site`;
    const cat = JSON.parse(read(`${siteDir}/src/generated/market.json`)) as { entries?: { id: string; docs?: { markdown?: string } }[] };
    return (cat.entries ?? [])
      .filter((e): e is { id: string; docs: { markdown: string } } => typeof e.docs?.markdown === "string" && e.docs.markdown.length > 4_000)
      .sort((a, b) => b.docs.markdown.length - a.docs.markdown.length)
      .slice(0, count)
      .map((e) => ({ name: `market doc: ${e.id}`, text: e.docs.markdown }));
  } catch {
    return []; // the catalog is a build artefact; measuring without it is worse than measuring wrong
  }
}

// The kinds of text a session is actually made of. Prose, code, JSON, markdown documentation and diffs
// tokenize differently — a single ratio measured on one of them would be a fact about that sample,
// not about the tokenizer.
const SAMPLES: { name: string; text: string }[] = [
  { name: "system prompt", text: system },
  { name: "tool schemas (json)", text: schemas },
  { name: "typescript source", text: read("src/core/loop.ts") },
  { name: "english prose (docs)", text: read("docs/context.md") },
  { name: "turkish prose (readme)", text: read("README.md").slice(0, 20_000) },
  { name: "tool result (file listing)", text: read("package.json") + "\n" + read("tsconfig.json") },
  ...marketDocs(14),
];

const provider = new ProviderRegistry(cwd).get(providerId);
if (!provider) {
  console.error(`no provider "${providerId}" configured here`);
  process.exit(1);
}

interface Row { name: string; chars: number; chars4: number; o200k: number; actual?: number; reason?: string }
const rows: Row[] = [];

// One request per sample, each carrying only that sample as a single user turn: the provider's own
// per-request overhead is then the same constant in every row and cannot be mistaken for a difference
// between the samples.
for (const s of SAMPLES) {
  const messages: Message[] = [{ id: "s", role: "user", parts: [{ kind: "text", text: s.text }], parentId: null, createdAt: 1 }];
  const r = await countPromptRemotely({
    provider: { baseUrl: provider.baseUrl, protocol: provider.protocol, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}) },
    model,
    messages,
  });
  rows.push({
    name: s.name,
    chars: s.text.length,
    chars4: estimateTokens(s.text),
    o200k: countTokens(s.text),
    ...(r.ok ? { actual: r.inputTokens } : { reason: r.reason }),
  });
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ provider: providerId, model, rows }, null, 2));
} else {
  const n = (v: number) => v.toLocaleString("en-US");
  const ratio = (est: number, actual: number) => `${(actual / est).toFixed(3)}×`;
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`${providerId}/${model} — what our estimators say, and what the provider counts\n`);
  console.log(`${"sample".padEnd(w)}  ${"chars".padStart(8)}  ${"chars/4".padStart(8)}  ${"o200k".padStart(8)}  ${"actual".padStart(8)}   scale needed`);
  for (const r of rows) {
    if (r.actual === undefined) {
      console.log(`${r.name.padEnd(w)}  ${n(r.chars).padStart(8)}  ${n(r.chars4).padStart(8)}  ${n(r.o200k).padStart(8)}  ${"—".padStart(8)}   ${r.reason}`);
      continue;
    }
    console.log(
      `${r.name.padEnd(w)}  ${n(r.chars).padStart(8)}  ${n(r.chars4).padStart(8)}  ${n(r.o200k).padStart(8)}  ${n(r.actual).padStart(8)}   chars/4 ${ratio(r.chars4, r.actual)} · o200k ${ratio(r.o200k, r.actual)}`,
    );
  }
  const ok = rows.filter((r) => r.actual !== undefined) as Required<Row>[];
  if (ok.length > 1) {
    const worst = (f: (r: Required<Row>) => number) => Math.max(...ok.map(f));
    console.log(
      `\nacross ${ok.length} samples the scale a budget would need is at most ` +
        `${worst((r) => r.actual / r.chars4).toFixed(3)}× for chars/4 and ${worst((r) => r.actual / r.o200k).toFixed(3)}× for o200k — ` +
        `the maximum, not the mean, because underestimating the window is the failure that rejects a request`,
    );
  }
}
