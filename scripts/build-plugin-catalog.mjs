#!/usr/bin/env node
/** Regenerate src/market/catalogs/plugins.json from real, readable plugin manifests.
 *
 *  Why this catalog is SHORT, and should stay short until it earns being longer: rovecode's plugin format
 *  (`plugin.json`, `api: 1`) is days old, so no third party has published one yet. The three entries below
 *  are rovecode's own, read from `plugins/` in this repository — every field comes out of the manifest on
 *  disk. Claude Code's plugins are deliberately NOT listed: they use a different manifest
 *  (`.claude-plugin/plugin.json`, a different shape) and listing them would be claiming a compatibility
 *  that does not exist. A shelf, not a mirror — and an empty shelf beats a shelf of things that will not
 *  install.
 *
 *  Adding a third-party plugin later: put its git URL and subfolder in SOURCES, run this, and the manifest
 *  it actually publishes fills the row. If the manifest cannot be read, the entry is dropped with a warning.
 *
 *      node scripts/build-plugin-catalog.mjs            # write the catalog
 *      node scripts/build-plugin-catalog.mjs --check    # exit 1 if it would change (CI)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./lib/docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "market", "catalogs", "plugins.json");

/** `dir` is read from this checkout; `git` + `subfolder` are what a user's install will actually clone. */
const SOURCES = [
  {
    dir: join(ROOT, "plugins"),
    git: "https://github.com/9Code-Labs/rovecode",
    subfolderPrefix: "plugins",
    publisher: "9Code Labs",
    homepage: "https://github.com/9Code-Labs/rovecode",
    tags: ["first-party"],
    /** read from this repo's package.json, not asserted here */
    licenseFrom: join(ROOT, "package.json"),
  },
];

/** Which surfaces the manifest actually contributes — read from the manifest, not guessed. */
const contributionsOf = (m) => {
  const out = [];
  if (m.entry) out.push("tools", "hooks");   // an entry module may export either; the manifest cannot say which
  if (m.commands) out.push("commands");
  if (m.skills) out.push("skills");
  if (m.mcp) out.push("mcp");
  return out;
};

const items = [];
const warnings = [];

for (const src of SOURCES) {
  let license;
  if (src.licenseFrom && existsSync(src.licenseFrom)) {
    try { license = JSON.parse(readFileSync(src.licenseFrom, "utf8")).license; }
    catch { warnings.push(`${src.licenseFrom}: unreadable — licence left off these rows`); }
  }
  if (!license) warnings.push(`${src.git}: no licence found — rows carry none rather than a guess`);
  if (!existsSync(src.dir)) { warnings.push(`${src.dir}: not present — source skipped`); continue; }
  for (const name of readdirSync(src.dir).sort()) {
    const dir = join(src.dir, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, "plugin.json");
    if (!existsSync(file)) { warnings.push(`${name}: no plugin.json — skipped`); continue; }
    let m;
    try { m = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { warnings.push(`${name}: plugin.json is not valid JSON (${e.message}) — skipped`); continue; }
    if (m.api !== 1) { warnings.push(`${name}: declares api ${JSON.stringify(m.api)}, this rovecode speaks 1 — skipped`); continue; }
    if (typeof m.name !== "string" || !m.name) { warnings.push(`${name}: manifest has no name — skipped`); continue; }
    if (typeof m.version !== "string" || !m.version) { warnings.push(`${name}: manifest has no version — skipped`); continue; }
    if (m.name !== name) warnings.push(`${name}: manifest name "${m.name}" != folder name`);

    const contributes = contributionsOf(m);

    // The plugin's own README, read from THIS checkout — no network anywhere in this generator. The URL
    // recorded is where the same file lives upstream, so a reader can reach the original; relative links
    // inside it resolve against that URL, not against a path on this machine.
    const readme = join(dir, "README.md");
    const docUrl = `${src.git}/blob/${src.branch ?? "main"}/${src.subfolderPrefix}/${m.name}/README.md`;
    const docs = existsSync(readme) ? buildDocs(readFileSync(readme, "utf8"), docUrl) : null;
    // A plugin with no README is not an error; its description already carries the one line that matters.
    if (docs === null) warnings.push(`${name}: no README.md worth carrying — the row ships without docs`);

    items.push({
      id: m.name,
      title: m.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      publisher: src.publisher,
      description: String(m.description ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      version: m.version,
      apiVersion: m.api,
      ...(license ? { license } : {}),
      contributes,
      tags: src.tags,
      repository: src.git,
      homepage: src.homepage,
      install: { source: src.git, git: true, subfolder: `${src.subfolderPrefix}/${m.name}` },
      // said in the plugin's own terms, because "a plugin can run code" is the one thing a reader must not miss
      planNote: [
        contributes.includes("tools")
          ? "runs code: this plugin ships an entry module that rovecode imports in-process"
          : "no entry module: this plugin contributes files only (commands, skills), nothing is imported",
        `contributes: ${contributes.join(", ") || "nothing"}`,
      ],
      ...(docs ? { docs } : {}),
    });
  }
}

items.sort((a, b) => a.id.localeCompare(b.id));
const doc = {
  version: 1,
  generatedBy: "scripts/build-plugin-catalog.mjs",
  sources: SOURCES.map((s) => s.git),
  items,
};
const json = `${JSON.stringify(doc, null, 2)}\n`;

for (const w of warnings) console.error(`warn: ${w}`);

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing counts as changed */ }
  if (current === json) { console.log(`ok: ${items.length} plugins, catalog unchanged`); process.exit(0); }
  console.error("catalog is out of date — run: node scripts/build-plugin-catalog.mjs");
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);
console.log(`wrote ${OUT}: ${items.length} plugins`);
