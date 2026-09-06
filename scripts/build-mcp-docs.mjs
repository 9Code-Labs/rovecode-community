#!/usr/bin/env node
/** Regenerate src/market/catalogs/mcp-docs.json — the documentation for the curated MCP shelf.
 *
 *  WHY A SIDECAR AND NOT A GENERATED CATALOG. `src/mcp/market-catalog.ts` is written by hand and stays
 *  that way: the publisher, the launch line, which secrets travel as environment variables and which as
 *  headers are human decisions, and a generator has no business making them. The documentation is the
 *  opposite — it is upstream's text, it goes stale, and checking it by hand does not scale. So the shelf
 *  stays hand-written and the docs are generated beside it, keyed by the curated entry's `key`.
 *  registry.ts joins the two at read time; a missing sidecar just means the MCP rows have no docs.
 *
 *  The one guess this script refuses to make is WHERE the README is. Nine of the entries live at the root
 *  of their own repository, seven share modelcontextprotocol/servers, and the folder layout there is not
 *  something to assume — so the monorepo's tree is read once and the paths come out of it.
 *
 *      node scripts/build-mcp-docs.mjs            # write the sidecar
 *      node scripts/build-mcp-docs.mjs --check    # exit 1 if it would change (CI)
 *      node scripts/build-mcp-docs.mjs --allow-shrink
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./lib/docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** overridable for the same reason as in build-skill-catalog.mjs: a test drives a real run against a
 *  throwaway copy rather than writing the shipped file and putting it back */
const OUT = process.env.ROVECODE_MCP_DOCS_OUT || join(ROOT, "src", "market", "catalogs", "mcp-docs.json");
const CURATED_FILE = join(ROOT, "src", "mcp", "market-catalog.ts");

/** The same distinction the other two generators are built on, and for the same reason:
 *    unreachable  — we do not know what is upstream. Never allowed to remove anything.
 *    absent (404) — upstream answered "there is nothing here". That is a fact we may act on. */
class Unreachable extends Error {}

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const HEADERS = { "user-agent": "rovecode-catalog-build", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const RETRIES = 3;

async function get(url) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (r.ok) return await r.text();
      const hint = r.status === 403 ? " (rate limited?)" : r.status === 401 ? " (GITHUB_TOKEN rejected — unset it to fall back to anonymous)" : "";
      last = new Error(`HTTP ${r.status}${hint} for ${url}`);
    } catch (e) { last = e; }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw new Unreachable(`${url}: ${last?.message ?? "unreachable"} (after ${RETRIES} attempts)`);
}

/** Read the curated keys and repositories out of the hand-written shelf.
 *
 *  Parsed rather than imported because the shelf is TypeScript that pulls in types from the rest of the
 *  tree; a build script that had to typecheck the app to read sixteen strings would be the wrong shape.
 *  Only two fields are taken, both plain string literals, and a `key` with no `repository` is fine. */
function curatedEntries() {
  const src = readFileSync(CURATED_FILE, "utf8");
  // Sliced between `key:` occurrences rather than matched as whole objects: an entry is formatted however
  // it reads best (some close with `] },` on the last line, some on their own), and a brace-counting regex
  // that has to know which is a promise to break on the next tidy-up.
  const marks = [...src.matchAll(/\bkey:\s*"([^"]+)"/g)];
  return marks.map((m, i) => {
    const body = src.slice(m.index, marks[i + 1]?.index ?? src.length);
    const repo = /repository:\s*"([^"]+)"/.exec(body);
    return { key: m[1], repository: repo ? repo[1] : null };
  });
}

/** compare a repository folder with a curated key without caring how either spells the word break */
const folderKey = (s) => s.toLowerCase().replace(/[-_]/g, "");

const gh = (url) => {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url ?? "");
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
};

/** raw.githubusercontent for a path, trying the branch names real repositories actually use. A 404 on
 *  both is an answer: there is no README there. */
async function readmeAt(owner, repo, path) {
  for (const branch of ["main", "master"]) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    const text = await get(url);
    if (text !== null) return { text, url };
  }
  return null;
}

const warnings = [];
const docs = {};

try {
  const entries = curatedEntries();
  if (entries.length === 0) throw new Error(`${CURATED_FILE}: no curated entries parsed — the shelf's shape changed, fix this script`);

  // The monorepo's layout is read, not assumed: one tree call, and every servers/* entry finds its own
  // README in it (or does not, which is an answer).
  const monorepo = entries.find((e) => gh(e.repository)?.repo === "servers");
  let tree = [];
  if (monorepo) {
    const { owner, repo } = gh(monorepo.repository);
    const t = await get(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`);
    if (t === null) warnings.push(`${owner}/${repo}: no main branch — its entries will have no docs`);
    else {
      try { tree = (JSON.parse(t).tree ?? []).filter((n) => n.type === "blob" && /README\.md$/i.test(n.path)).map((n) => n.path); }
      catch { throw new Unreachable(`${owner}/${repo} tree: response was not JSON`); }
    }
  }

  for (const e of entries) {
    const g = gh(e.repository);
    if (g === null) { warnings.push(`${e.key}: no GitHub repository on the entry — no docs, which is not an error`); continue; }

    let found;
    if (g.repo === "servers") {
      // <anything>/<folder>/README.md, matching the folder with hyphens and underscores ignored: our key
      // is `sequential-thinking` and the folder upstream is `sequentialthinking`. Matching literally made
      // that entry silently docs-less AND printed "no README in the monorepo", which was not true.
      // Shallowest match wins, so a nested example never beats the server's own folder.
      const path = tree.filter((p) => folderKey(p.split("/").at(-2) ?? "") === folderKey(e.key))
                       .sort((a, b) => a.split("/").length - b.split("/").length)[0];
      if (path === undefined) { warnings.push(`${e.key}: no folder matching "${e.key}" with a README.md in the monorepo — no docs`); continue; }
      const text = await get(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/main/${path}`);
      found = text === null ? null : { text, url: `https://raw.githubusercontent.com/${g.owner}/${g.repo}/main/${path}` };
    } else {
      found = await readmeAt(g.owner, g.repo, "README.md");
    }
    if (found === null) { warnings.push(`${e.key}: no README.md at ${e.repository} — no docs`); continue; }

    const d = buildDocs(found.text, found.url);
    if (d === null) { warnings.push(`${e.key}: README.md has no body worth carrying — no docs`); continue; }
    docs[e.key] = d;
  }
} catch (e) {
  if (!(e instanceof Unreachable)) throw e;
  console.error(`cannot reach the source: ${e.message}`);
  console.error("nothing was written — the shipped sidecar is untouched. Try again, or check the network.");
  process.exit(1);
}

const ordered = {};
for (const k of Object.keys(docs).sort()) ordered[k] = docs[k];
const json = `${JSON.stringify({ version: 1, generatedBy: "scripts/build-mcp-docs.mjs", docs: ordered }, null, 2)}\n`;

for (const w of warnings) console.error(`warn: ${w}`);

const previous = (() => {
  try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; }
})();

/** Same rule as the catalogs: a row that has documentation today must still have it, or this was a bad
 *  run rather than a real change. Without it one rate-limited build empties every MCP doc at once and the
 *  file still looks structurally fine. */
function refuseToWrite() {
  // not overridable, for the same reason as in build-skill-catalog.mjs: nothing at all is a broken run
  if (Object.keys(ordered).length === 0) return { reason: "produced no documentation at all", overridable: false };
  if (previous === null || typeof previous.docs !== "object" || previous.docs === null) return null;
  const gone = Object.keys(previous.docs).filter((k) => !(k in ordered));
  if (gone.length > 0) return { reason: `drops the documentation of ${gone.length} entr(y/ies) that have it today (lost docs: ${gone.join(", ")})`, overridable: true };
  return null;
}

const refusal = refuseToWrite();
if (refusal !== null) {
  console.error(`refusing to write: the new sidecar ${refusal.reason}.`);
  console.error("The shipped sidecar is untouched.");
  if (!refusal.overridable) {
    console.error("This one has no override: an empty result is a broken run, not a shelf that emptied.");
    console.error("Check the network and the source, then run it again.");
    process.exit(1);
  }
  console.error("If the loss is real (a README was removed upstream), re-run with --allow-shrink;");
  console.error("otherwise this was a bad fetch and running again is the fix.");
  if (!process.argv.includes("--allow-shrink")) process.exit(1);
  console.error("--allow-shrink given: writing anyway.");
}

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing counts as changed */ }
  if (current === json) { console.log(`ok: ${Object.keys(ordered).length} MCP docs, sidecar unchanged`); process.exit(0); }
  console.error("sidecar is out of date — run: node scripts/build-mcp-docs.mjs");
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
writeFileSync(tmp, json);
renameSync(tmp, OUT);          // atomic: a crash mid-write must not leave a truncated sidecar
console.log(`wrote ${OUT}: ${Object.keys(ordered).length} MCP docs`);
