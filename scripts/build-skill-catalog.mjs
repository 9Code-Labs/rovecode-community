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
import { buildDocs } from "./lib/docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Overridable so the tests can drive a real run against a throwaway copy. They used to write the shipped
 *  catalog and put it back afterwards, which is fine alone and wrong in a suite: bun runs test files
 *  concurrently, and another file reading `skills.json` during the `--allow-shrink` case saw a catalog with
 *  `xlsx` deliberately removed. A build script should not be the reason an unrelated test goes red. */
const OUT = process.env.ROVECODE_CATALOG_OUT || join(ROOT, "src", "market", "catalogs", "skills.json");

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

/** Optional, and only ever a rate limit lever: anonymous GitHub gives 60 requests an hour, a token gives
 *  5000, and this script makes ~40 — so in CI, where the runner's IP is shared with the world, running
 *  without one is choosing a flaky job. It reads NOTHING private; every URL here is public. A token that
 *  is expired or wrong comes back 401, which is "unreachable" above, so the bad case is a refusal to
 *  write, never a shrunken catalog. */
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const HEADERS = {
  "user-agent": "rovecode-catalog-build",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

const RETRIES = 3;
async function get(url) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;                       // an answer: nothing there
      if (r.ok) return await r.text();
      // 403 with a rate-limit header, 5xx, anything else: the host did not serve us
      const hint = r.status === 403 ? " (rate limited?)" : r.status === 401 ? " (GITHUB_TOKEN rejected — unset it to fall back to anonymous)" : "";
      last = new Error(`HTTP ${r.status}${hint} for ${url}`);
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

try {
  for (const src of SOURCES) {
    const [, owner, repo] = /github\.com\/([^/]+)\/([^/]+)/.exec(src.git);
    const tree = await api(`https://api.github.com/repos/${owner}/${repo}/git/trees/${src.branch}?recursive=1`);

    // Whether the publisher has stopped: read from the repository, never typed into this file. A
    // hand-written status is correct the day it is written and wrong every day after, and this is one
    // request per SOURCE (not per skill), so it costs nothing against the rate limit. The word follows
    // the flag — "archived on GitHub" is what the flag says; "abandoned" is a judgement GitHub never
    // made and we are in no position to make about someone else's work.
    const meta = await api(`https://api.github.com/repos/${owner}/${repo}`);
    const archived = meta.archived === true;
    if (archived) warnings.push(`${src.git}: archived on GitHub — its rows carry status "archived"`);
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

      // The documentation IS this file, which we already have: carrying it costs no extra request, and it
      // is why the skill catalog can hold a doc for every row without going near the rate limit.
      const docUrl = `${base}/${path}`;
      const docs = buildDocs(text, docUrl);
      if (docs === null) warnings.push(`${name}: SKILL.md has no body beyond its frontmatter — no docs`);

      items.push({
        id: name,
        title: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        publisher: src.publisher,
        description: fm["description"].replace(/\s+/g, " ").trim().slice(0, 500),
        ...(fm["version"] ? { version: fm["version"] } : {}),   // real files rarely carry one; never invented
        license: licence ?? "unknown",
        ...(archived ? { status: "archived" } : {}),
        tags: tagOf.get(name) ?? [],
        repository: src.git,
        homepage: src.homepage,
        source: { git: src.git, subfolder: `${src.root}/${name}`, branch: src.branch },
        bytes: text.length,
        ...(docs ? { docs } : {}),
      });
    }
  }

} catch (e) {
  // an unreachable host is not a catalog change: one line, and the shipped file is left alone
  if (!(e instanceof Unreachable)) throw e;
  console.error(`cannot reach the source: ${e.message}`);
  console.error("nothing was written — the shipped catalog is untouched. Try again, or check the network.");
  process.exit(1);
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

/** Four refusals, in the order they can happen. Each one leaves the existing catalog exactly as it is:
 *  a market that is a day stale is a small problem, a market that silently lost most of its shelf is not. */
function refuseToWrite() {
  // NOT overridable. A run that produced nothing is a broken run, never a shelf that legitimately emptied,
  // and `--allow-shrink` means "yes, that id really went" — not "write whatever you have over a good
  // catalog". While the flag covered this too, one bad run plus one impatient operator emptied the market.
  if (items.length === 0) return { reason: "produced no items at all", overridable: false };
  if (previous === null) return null;                       // first run: nothing to compare against
  const before = Array.isArray(previous.items) ? previous.items.length : 0;
  if (items.length < before) {
    const gone = previous.items.filter((p) => !items.some((i) => i.id === p.id)).map((p) => p.id);
    return { reason: `has ${items.length} items where the shipped one has ${before} (missing: ${gone.join(", ")})`, overridable: true };
  }
  // Losing documentation is the same failure wearing a different hat: every row still there, every row
  // now blank. The count check above would pass it without a word, and one rate-limited run would empty
  // every doc in the market. A row that HAD docs must still have them, or this is not a good run.
  const lost = previous.items.filter((p) => p.docs && !items.find((i) => i.id === p.id)?.docs).map((p) => p.id);
  if (lost.length > 0) return { reason: `drops the documentation of ${lost.length} row(s) that have it today (lost docs: ${lost.join(", ")})`, overridable: true };
  return null;
}

const refusal = refuseToWrite();
if (refusal !== null) {
  console.error(`refusing to write: the new catalog ${refusal.reason}.`);
  console.error("The shipped catalog is untouched.");
  if (!refusal.overridable) {
    console.error("This one has no override: an empty result is a broken run, not a shelf that emptied.");
    console.error("Check the network and the source, then run it again.");
    process.exit(1);
  }
  console.error("If the loss is real (a skill was withdrawn upstream, or its SKILL.md really is empty now),");
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
