/** The market catalog the site shows, built from the repository so nothing on the page is invented.
 *
 *    bun scripts/market.mjs   →  src/generated/market.json
 *
 *  It reads exactly the sources src/market/ calls static, in the shape src/market/types.ts defines
 *  (MarketItem: id, kind, title, publisher, description, source, version?, repository?, homepage?, tags,
 *  env, plus a flattened summary of `install` for display):
 *    mcp     src/mcp/market-catalog.ts CURATED — the curated shelf, imported, not re-parsed
 *    skill   src/market/catalogs/skills.json  \  the published catalogs, when they exist; until they do,
 *    plugin  src/market/catalogs/plugins.json /  the plugin manifests under plugins/ are read directly
 *
 *  The MCP registry half is deliberately absent: it is live, untrusted data, so a static page must not bake
 *  a snapshot of it — the page says the registry adds more at runtime instead.
 *
 *  Where an install lands is NOT baked in either: the target depends on scope and machine, so it comes from
 *  planInstall() at runtime. The page shows the scope pair as a sentence, not as a fact about the item.
 *
 *  Run under bun (it imports the TypeScript catalog). Behind VITE_MARKET=1, like docs: without it the file
 *  is written with `enabled: false` and prerender.mjs builds no market pages. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderItemDocs } from "./market-docs.mjs";

// SITE and REPO are overridable because the website moved to its own repository on 2026-09-06 while
// these generators stayed here, with the content they read. scripts/publish-site-data.sh points SITE at
// the site checkout and REPO at this one; with neither set they behave exactly as they did in the
// monorepo, so nothing else has to know the split happened.
const SITE = process.env.SITE_DIR ?? join(import.meta.dirname, "..");
const REPO = process.env.ROVECODE_REPO ?? join(SITE, "..");
const OUT = join(SITE, "src", "generated", "market.json");
const enabled = process.env.VITE_MARKET === "1";

/** one line, no markdown */
const clean = (s) => (s ?? "").replace(/\s*\n\s*/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").trim();
/** what a visitor types: the qualified id parseQualifiedId() accepts */
const install = (kind, id) => `rovecode market install ${kind}:${id}`;
const env = (v) => ({ name: v.name, required: !!v.required, secret: !!v.secret, description: clean(v.description) });

/** the MCP documentation sidecar (nimbus-24's mcp-docs.json), keyed by the curated entry's key. The CLI
 *  gets these attached by src/market/registry.ts; the site reads the same file directly, because it builds
 *  from the catalogs rather than through the registry. A missing file is simply no MCP documentation. */
function mcpDocsIndex() {
  const file = join(REPO, "src", "market", "catalogs", "mcp-docs.json");
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw.docs === "object" && raw.docs !== null ? raw.docs : {};
  } catch {
    return {};
  }
}

async function mcpItems() {
  const { CURATED } = await import(join(REPO, "src", "mcp", "market-catalog.ts"));
  const mcpDocs = mcpDocsIndex();
  return CURATED.map((e) => {
    // a curated entry can offer more than one way in (a remote endpoint and a local runtime); the first is
    // the one `mcp add` prefers, so it is the headline and the rest are named under it
    const [first, ...rest] = e.installs;
    const runtime = first?.kind === "http" ? "remote (http)" : (first?.runtime ?? "stdio");
    const vars = [...(first?.env ?? []), ...(first?.headers ?? [])].map(env);
    return {
      id: e.key,
      kind: "mcp",
      title: e.title ?? e.key,
      publisher: e.publisher ?? "unknown",
      description: clean(e.description),
      source: "curated",
      version: e.version ?? "",
      license: "",
      repository: e.repository ?? "",
      homepage: e.homepage ?? "",
      tags: [runtime, vars.some((v) => v.secret) ? "needs a key" : "no key"],
      env: vars,
      runs: first?.kind === "http" ? first.url : [first?.command, ...(first?.args ?? [])].join(" "),
      alternatives: rest.map((i) => (i.kind === "http" ? `remote ${i.url}` : `${i.runtime}: ${[i.command, ...(i.args ?? [])].join(" ")}`)),
      pending: (first?.pending ?? []).map(clean),
      install: install("mcp", e.key),
      from: "src/mcp/market-catalog.ts",
      docs: docsFor({ docs: mcpDocs[e.key] }),
    };
  });
}

/** a published catalog file, when nimbus-24's writer has produced one: { version: 1, items: [...] } */
function catalogItems(kind) {
  const file = join(REPO, "src", "market", "catalogs", `${kind === "skill" ? "skills" : "plugins"}.json`);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return (raw.items ?? []).map((i) => ({
    id: i.id,
    kind,
    title: i.title ?? i.id,
    publisher: i.publisher ?? "unknown",
    description: clean(i.description),
    source: "catalog",
    version: i.version ?? "",
    license: i.license ?? "",
    repository: i.repository ?? "",
    homepage: i.homepage ?? "",
    tags: [...new Set([...(i.tags ?? []).map((t) => String(t)), ...(i.license ? [i.license] : []), kind === "skill" ? "markdown" : "plugin"])],
    env: (i.env ?? []).map(env),
    // the catalog states its origin as `source: {git, subfolder}` (registry.ts turns that into the
    // InstallSpec); the page says what installing it will do, in that source's own words
    runs: i.source?.git
      ? `clone ${i.source.git}${i.source.subfolder ? ` (${i.source.subfolder})` : ""}`
      : Array.isArray(i.files) && i.files.length
        ? `${i.files.length} file(s), written verbatim — runs nothing`
        : "",
    alternatives: [],
    pending: (i.planNote ?? []).map(clean),
    install: install(kind, i.id),
    from: `src/market/catalogs/${kind === "skill" ? "skills" : "plugins"}.json`,
    // the item's own documentation, when the catalog carries one: rendered here (third-party markdown,
    // no raw HTML, links resolved against their source) and shipped as HTML for the page plus safe lines
    // for the terminal overlay. An item with no `docs` field simply has none — that is a quiet state.
    docs: docsFor(i),
  }));
}

/** the rendered documentation for one catalog item, or null when it carries none */
function docsFor(i) {
  const rendered = renderItemDocs(i.docs);
  if (!rendered) return null;
  return {
    html: rendered.html,
    markdown: rendered.markdown,
    toc: rendered.toc,
    source: rendered.source,
    truncated: rendered.truncated,
    words: rendered.words,
    /** the size before truncation, so the page can say how much is missing */
    bytes: typeof i.docs?.bytes === "number" ? i.docs.bytes : 0,
    shownBytes: typeof i.docs?.body === "string" ? Buffer.byteLength(i.docs.body, "utf8") : 0,
  };
}

/** name + description from a SKILL.md frontmatter block */
function frontmatter(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/i.exec(line.trim());
    if (kv) fm[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "");
  }
  return fm;
}

/** the fallback while the catalog files do not exist: the manifests that ship in this repository */
function repoPlugins() {
  const dir = join(REPO, "plugins");
  if (!existsSync(dir)) return { plugins: [], skills: [] };
  const plugins = [];
  const skills = [];
  for (const name of readdirSync(dir).sort()) {
    const root = join(dir, name);
    const manifestFile = join(root, "plugin.json");
    if (!statSync(root).isDirectory() || !existsSync(manifestFile)) continue;
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    // what the plugin carries, named from the manifest and counted from the folders it points at
    const carries = [];
    if (m.entry) carries.push("tools");
    const commandsDir = m.commands ? join(root, m.commands) : null;
    if (commandsDir && existsSync(commandsDir)) {
      const n = readdirSync(commandsDir).filter((f) => f.endsWith(".md")).length;
      if (n) carries.push(n === 1 ? "1 command" : `${n} commands`);
    }
    const skillsDir = m.skills ? join(root, m.skills) : null;
    let count = 0;
    if (skillsDir && existsSync(skillsDir)) {
      for (const s of readdirSync(skillsDir).sort()) {
        const file = join(skillsDir, s, "SKILL.md");
        if (!existsSync(file)) continue;
        count++;
        const fm = frontmatter(file);
        skills.push({
          id: fm.name ?? s,
          kind: "skill",
          title: fm.name ?? s,
          publisher: `plugin: ${m.name}`,
          description: clean(fm.description),
          source: "catalog",
          version: "",
          license: "",
          repository: "",
          homepage: "",
          tags: ["markdown", `plugin: ${m.name}`],
          env: [],
          runs: "nothing — a SKILL.md the model reads when it matches",
          alternatives: [],
          pending: [],
          install: install("skill", fm.name ?? s),
          from: `plugins/${name}/${m.skills}/${s}/SKILL.md`,
          docs: null,
        });
      }
      if (count) carries.push(count === 1 ? "1 skill" : `${count} skills`);
    }
    plugins.push({
      id: m.name ?? name,
      kind: "plugin",
      title: m.name ?? name,
      publisher: "rovecode",
      description: clean(m.description),
      source: "catalog",
      version: m.version ?? "",
      license: "",
      repository: "",
      homepage: "",
      tags: carries.length ? carries : ["manifest only"],
      env: [],
      runs: m.entry ? `${m.entry} (plugin api ${m.api ?? 1})` : `plugin.json (api ${m.api ?? 1})`,
      alternatives: [],
      pending: [],
      install: install("plugin", m.name ?? name),
      from: `plugins/${name}/plugin.json`,
      docs: null,
    });
  }
  return { plugins, skills };
}

const items = [];
if (enabled) {
  const fallback = repoPlugins();
  items.push(
    ...(await mcpItems()),
    ...(catalogItems("skill") ?? fallback.skills),
    ...(catalogItems("plugin") ?? fallback.plugins),
  );
}

// the site gives every item its own page at /market/<id>/, so an id shared by two kinds would be two
// pages at one URL. It has never happened; if a catalog ever does it, the build stops here rather than
// quietly dropping one of them.
const seen = new Map();
for (const item of items) {
  const first = seen.get(item.id);
  if (first) throw new Error(`market: two items share the id "${item.id}" (${first} and ${item.kind}) — the site needs one page per id`);
  seen.set(item.id, item.kind);
}

const kinds = ["mcp", "skill", "plugin"].map((k) => ({ kind: k, count: items.filter((e) => e.kind === k).length }));
const tags = [...new Set(items.flatMap((e) => e.tags))].sort();

mkdirSync(join(SITE, "src", "generated"), { recursive: true });
writeFileSync(OUT, JSON.stringify({ enabled, kinds, tags, entries: items }, null, 2) + "\n");
console.log(enabled ? `market: ${items.length} entries (${kinds.map((k) => `${k.kind} ${k.count}`).join(", ")}), ${tags.length} tags` : "market: off (set VITE_MARKET=1)");
