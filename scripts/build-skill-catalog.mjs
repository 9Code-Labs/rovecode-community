#!/usr/bin/env node
/** Regenerate src/market/catalogs/skills.json from the upstream repositories.
 *
 *  The catalog is GENERATED, never hand-written, because the rule for it is "a shelf, not a mirror" and
 *  the only way to keep that honest is to make every entry re-checkable: run this and the file either
 *  comes back identical or the upstream really changed. Nothing here invents a field — name, description
 *  and licence are read from the skill's own SKILL.md and LICENSE.txt, and a source that 404s is dropped
 *  with a warning rather than guessed at.
 *
 *      node scripts/build-skill-catalog.mjs            # write the catalog
 *      node scripts/build-skill-catalog.mjs --check    # exit 1 if it would change (CI)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "market", "catalogs", "skills.json");

/** Every source is a public git repository laid out as <subfolder>/<name>/SKILL.md. Add one only after
 *  opening it: the publisher must be nameable and the layout must be the standard one. */
const SOURCES = [
  {
    git: "https://github.com/anthropics/skills",
    branch: "main",
    root: "skills",
    publisher: "Anthropic",
    homepage: "https://github.com/anthropics/skills",
    /** the repo's own grouping file: tags come from how the publisher groups its skills, never from us
     *  guessing a category from the description */
    groups: ".claude-plugin/marketplace.json",
  },
];

/** Fetch with a small retry, and a HARD distinction the rest of this script depends on:
 *
 *    unreachable  — the network or the host failed us. We do not know what is upstream.
 *    absent (404) — we reached the host and it says there is nothing there. That is an answer.
 *
 *  Only the second is allowed to shrink the catalog. Without that line a rate-limited run (GitHub gives
 *  60 anonymous requests an hour, and this script makes ~40) would quietly write a catalog of four
 *  skills over a good one of nineteen, and the next person would see a market that had lost most of its
 *  shelf with no error anywhere. */
class Unreachable extends Error {}

const RETRIES = 3;
async function get(url) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "rovecode-catalog-build" } });
      if (r.status === 404) return null;                       // an answer: nothing there
      if (r.ok) return await r.text();
      // 403 with a rate-limit header, 5xx, anything else: the host did not serve us
      last = new Error(`HTTP ${r.status}${r.status === 403 ? " (rate limited?)" : ""} for ${url}`);
    } catch (e) {
      last = e;                                                // DNS, TLS, connection reset, timeout
    }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw new Unreachable(`${url}: ${last?.message ?? "unreachable"} (after ${RETRIES} attempts)`);
}

const api = async (url) => {
  const t = await get(url);
  if (t === null) throw new Unreachable(`${url}: 404 — the repository or branch does not exist`);
  try { return JSON.parse(t); } catch { throw new Unreachable(`${url}: response was not JSON`); }
};
const raw = get;

/** The same frontmatter rules src/skills/index.ts uses, including block scalars. */
function frontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const lines = text.slice(4, end).split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line)) continue;
    const c = line.indexOf(":");
    if (c === -1) continue;
    const k = line.slice(0, c).trim();
    if (!k) continue;
    const rest = line.slice(c + 1).trim();
    const m = /^([|>])([+-]?)$/.exec(rest);
    if (m === null) { fm[k] = rest.replace(/^["']|["']$/g, ""); continue; }
    const owned = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() !== "" && !/^\s/.test(next)) break;
      owned.push(next.replace(/^\s+/, ""));
      i++;
    }
    while (owned.length > 0 && owned.at(-1) === "") owned.pop();
    fm[k] = m[1] === ">" ? owned.join(" ").replace(/\s+/g, " ").trim() : owned.join("\n");
  }
  return fm;
}

const licenceOf = (text) =>
  text === null ? null
  : /Apache License/i.test(text) ? "Apache-2.0"
  : /All rights reserved/i.test(text) ? "source-available"
  : "unknown";

const items = [];
const warnings = [];

/** An unreachable host is not a catalog change: say so in one line and leave the shipped file alone. */
process.on("unhandledRejection", (e) => {
  if (e instanceof Unreachable) {
    console.error(`cannot reach the source: ${e.message}`);
    console.error("nothing was written — the shipped catalog is untouched. Try again, or check the network.");
    process.exit(1);
  }
  throw e;
});

for (const src of SOURCES) {
  const [, owner, repo] = /github\.com\/([^/]+)\/([^/]+)/.exec(src.git);
  const tree = await api(`https://api.github.com/repos/${owner}/${repo}/git/trees/${src.branch}?recursive=1`);
  const skillFiles = tree.tree
    .filter((t) => t.type === "blob" && t.path.startsWith(`${src.root}/`) && t.path.endsWith("/SKILL.md"))
    .map((t) => t.path)
    .sort();

  // tags: the publisher's own grouping, read from the repo. No group -> no tag; nothing is invented.
  const tagOf = new Map();
  if (src.groups) {
    const gtext = await raw(`https://raw.githubusercontent.com/${owner}/${repo}/${src.branch}/${src.groups}`);
    if (gtext === null) warnings.push(`${src.groups}: unreadable — entries will carry no tags`);
    else {
      try {
        for (const g of JSON.parse(gtext).plugins ?? []) {
          for (const s of g.skills ?? []) {
            const n = String(s).split("/").pop();
            if (n && g.name && g.name !== n) tagOf.set(n, [String(g.name)]);
          }
        }
      } catch { warnings.push(`${src.groups}: not valid JSON — entries will carry no tags`); }
    }
  }

  for (const path of skillFiles) {
    const name = path.slice(src.root.length + 1, -"/SKILL.md".length);
    if (name.includes("/")) { warnings.push(`${path}: nested deeper than <root>/<name>/SKILL.md — skipped`); continue; }
    const base = `https://raw.githubusercontent.com/${owner}/${repo}/${src.branch}`;
    const text = await raw(`${base}/${path}`);
    if (text === null) { warnings.push(`${path}: unreadable — skipped`); continue; }
    const fm = frontmatter(text);
    if (!fm || !fm["name"] || !fm["description"]) { warnings.push(`${path}: no usable frontmatter — skipped`); continue; }
    if (fm["name"] !== name) warnings.push(`${path}: frontmatter name "${fm["name"]}" != folder "${name}"`);
    const licence = licenceOf(await raw(`${base}/${src.root}/${name}/LICENSE.txt`));
    if (licence === null) warnings.push(`${name}: no LICENSE.txt — licence recorded as unknown`);

    items.push({
      id: name,
      title: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      publisher: src.publisher,
      description: fm["description"].replace(/\s+/g, " ").trim().slice(0, 500),
      ...(fm["version"] ? { version: fm["version"] } : {}),   // real files rarely carry one; never invented
      license: licence ?? "unknown",
      tags: tagOf.get(name) ?? [],
      repository: src.git,
      homepage: src.homepage,
      source: { git: src.git, subfolder: `${src.root}/${name}`, branch: src.branch },
      bytes: text.length,
    });
  }
}

items.sort((a, b) => a.id.localeCompare(b.id));
const doc = {
  version: 1,
  generatedBy: "scripts/build-skill-catalog.mjs",
  sources: SOURCES.map((s) => s.git),
  items,
};
const json = `${JSON.stringify(doc, null, 2)}\n`;

for (const w of warnings) console.error(`warn: ${w}`);

/** Read what ships today, so a bad run can be compared against a good one rather than trusted blindly. */
const previous = (() => {
  try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; }
})();

/** Three refusals, in the order they can happen. Each one leaves the existing catalog exactly as it is:
 *  a market that is a day stale is a small problem, a market that silently lost most of its shelf is not. */
function refuseToWrite() {
  if (items.length === 0) return "produced no items at all";
  if (previous === null) return null;                       // first run: nothing to compare against
  const before = Array.isArray(previous.items) ? previous.items.length : 0;
  if (items.length < before) {
    const gone = previous.items.filter((p) => !items.some((i) => i.id === p.id)).map((p) => p.id);
    return `has ${items.length} items where the shipped one has ${before} (missing: ${gone.join(", ")})`;
  }
  return null;
}

const refusal = refuseToWrite();
if (refusal !== null) {
  console.error(`refusing to write: the new catalog ${refusal}.`);
  console.error("The shipped catalog is untouched. If the shrink is real (a skill was withdrawn upstream),");
  console.error("re-run with --allow-shrink; otherwise this was a bad fetch and running again is the fix.");
  if (!process.argv.includes("--allow-shrink")) process.exit(1);
  console.error("--allow-shrink given: writing anyway.");
}

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing counts as changed */ }
  if (current === json) { console.log(`ok: ${items.length} skills, catalog unchanged`); process.exit(0); }
  console.error("catalog is out of date — run: node scripts/build-skill-catalog.mjs");
  process.exit(1);
}

// atomic: a crash or a full disk mid-write must not leave a truncated catalog where a good one was
mkdirSync(dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp-${process.pid}`;
writeFileSync(tmp, json);
renameSync(tmp, OUT);
console.log(`wrote ${OUT}: ${items.length} skills from ${SOURCES.length} source(s)`);
