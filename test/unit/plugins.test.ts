/** Plugins seam. Pins: manifest parsing (the api version gate, the name rule, paths that escape the
 *  folder, field-by-field drops); discovery over the two roots (status active / disabled / untrusted /
 *  broken, project shadows user, folder-vs-manifest name mismatch, ROVECODE_NO_PLUGINS); the trust
 *  digest (moves on any byte, ignores node_modules/.git, recorded in the USER home never the checkout);
 *  activation (entry import, module api gate, tool + hook validation, the tools() factory ctx, a
 *  throwing module and a hanging one cost one warning each, declarative dirs, MCP entries); install
 *  verbs (add from a folder and from a stubbed git clone, --force, --project trust, remove drops the
 *  trust record, enable/disable); loadPlugins end to end and the boot summary line. */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION, insidePlugin, parseManifest, contributions } from "../../src/plugins/manifest.ts";
import { discoverPlugins, pluginRoots } from "../../src/plugins/discover.ts";
import { activatePlugins } from "../../src/plugins/load.ts";
import { loadPlugins, summarizePlugins } from "../../src/plugins/index.ts";
import { loadState, pluginDigest, saveState, statePath, trustKey } from "../../src/plugins/state.ts";
import { addPlugin, isGitSource, removePlugin, setPluginEnabled, trustPlugin, untrustPlugin } from "../../src/plugins/install.ts";

interface Rig { cwd: string; home: string; done: () => void }
function rig(): Rig {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-plug-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-plug-home-"));
  return { cwd, home, done: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
/** a plugin folder under `root`: manifest fields over the api/name/version defaults, plus files */
function plugin(root: string, name: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ api: 1, name, version: "1.0.0", ...manifest }));
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const userRoot = (r: Rig): string => join(r.home, "plugins");
const projRoot = (r: Rig): string => join(r.cwd, ".rovecode", "plugins");
const TOOL = (name: string, kind = "read"): string => `{ kind: ${JSON.stringify(kind)}, schema: { name: ${JSON.stringify(name)}, description: "d", args: { type: "object" } }, async execute() { return { ok: true, output: ${JSON.stringify(name)} }; } }`;

// ---------- manifest ----------

test("manifest: the api version is a hard gate, the name rule and non-empty version are hard, everything else drops field by field with a warning", () => {
  const w: string[] = [];
  const ok = parseManifest(JSON.stringify({ api: 1, name: "safety-net", version: "0.1.0", description: "  a   plugin ", entry: "index.ts", commands: "cmds", skills: "skills", mcp: { fs: { command: "x" } }, colour: 1 }), "p.json", w);
  expect(ok).toMatchObject({ name: "safety-net", version: "0.1.0", description: "a plugin", api: 1, entry: "index.ts", commands: "cmds", skills: "skills" });
  expect(ok!.mcp).toEqual({ fs: { command: "x" } });
  expect(w).toEqual(['p.json: unknown field "colour" ignored']);
  for (const [api, shown] of [[undefined, "missing"], ["1", '"1"'], [2, "2"]] as const) {
    const ww: string[] = [];
    expect(parseManifest(JSON.stringify({ api, name: "x", version: "1" }), "p.json", ww)).toBeNull();
    expect(ww[0]).toContain(`plugin API version ${shown} is not supported (this rovecode speaks ${PLUGIN_API_VERSION})`);
  }
  expect(parseManifest(JSON.stringify({ api: 1, name: "Bad Name", version: "1" }), "p.json", [])).toBeNull();
  expect(parseManifest(JSON.stringify({ api: 1, name: "x", version: "" }), "p.json", [])).toBeNull();
  expect(parseManifest("{ not json", "p.json", [])).toBeNull();
  expect(parseManifest("[1]", "p.json", [])).toBeNull();
  // paths must stay inside the folder; entry must be a module; description bounded; mcp must be an object
  const w2: string[] = [];
  const m = parseManifest(JSON.stringify({ api: 1, name: "x", version: "1", entry: "../../.rovecode/hooks.ts", commands: "/etc", skills: "a\\..\\b", mcp: [1], description: "y".repeat(300) }), "p.json", w2);
  expect(m).toMatchObject({ name: "x" });
  expect(m!.entry).toBeUndefined(); expect(m!.commands).toBeUndefined(); expect(m!.skills).toBeUndefined(); expect(m!.mcp).toBeUndefined();
  expect(m!.description).toHaveLength(200);
  expect(w2.filter((x) => x.includes("inside the plugin"))).toHaveLength(3);
  expect(w2.some((x) => x.includes('"mcp" must be an object'))).toBe(true);
  const w3: string[] = [];
  expect(parseManifest(JSON.stringify({ api: 1, name: "x", version: "1", entry: "index.md" }), "p.json", w3)!.entry).toBeUndefined();
  expect(w3[0]).toContain(".ts or .js");
  expect([insidePlugin("a/b.ts"), insidePlugin("a\\b.ts"), insidePlugin("../x"), insidePlugin("a/../../x"), insidePlugin("/abs"), insidePlugin("C:\\x"), insidePlugin("")]).toEqual([true, true, false, false, false, false, false]);
  expect(contributions(ok!)).toEqual(["code: index.ts", "commands: cmds/", "skills: skills/", "mcp: fs"]);
});

// ---------- discovery + trust ----------

test("discovery: user plugins are active, a project plugin is untrusted until its digest is approved in the USER home, disabled wins, broken lists its problems, project shadows user, folder/manifest name mismatch is a problem", () => {
  const r = rig();
  try {
    plugin(userRoot(r), "alpha");
    const projDir = plugin(projRoot(r), "beta", {}, { "index.ts": "export default { api: 1 };" });
    plugin(projRoot(r), "alpha", { version: "2.0.0" }); // same name as the user one
    plugin(userRoot(r), "gamma");
    mkdirSync(join(userRoot(r), "broken")); writeFileSync(join(userRoot(r), "broken", "plugin.json"), "{ nope");
    mkdirSync(join(userRoot(r), "not-a-plugin")); writeFileSync(join(userRoot(r), "not-a-plugin", "readme.md"), "x"); // no manifest: skipped silently
    mkdirSync(join(userRoot(r), "misnamed")); writeFileSync(join(userRoot(r), "misnamed", "plugin.json"), JSON.stringify({ api: 1, name: "renamed", version: "1" }));
    writeFileSync(join(userRoot(r), "stray.txt"), "x");
    saveState(r.home, { disabled: ["gamma"], trusted: {} });
    const d = discoverPlugins(r.cwd, { home: r.home });
    const by = Object.fromEntries(d.plugins.map((p) => [p.name, p]));
    expect(Object.keys(by).sort()).toEqual(["alpha", "beta", "broken", "gamma", "renamed"]);
    expect(by["alpha"]).toMatchObject({ scope: "project", status: "untrusted" }); // the project copy shadows, and is not yet trusted
    expect(by["alpha"]!.manifest!.version).toBe("2.0.0");
    expect(d.warnings.some((w) => w.includes('plugin "alpha" shadows'))).toBe(true);
    expect(by["beta"]).toMatchObject({ scope: "project", status: "untrusted" });
    expect(by["gamma"]).toMatchObject({ scope: "user", status: "disabled" });
    expect(by["broken"]).toMatchObject({ status: "broken", manifest: null });
    expect(by["broken"]!.problems[0]).toContain("not valid JSON");
    expect(by["renamed"]!.problems.some((p) => p.includes('differs from its folder "misnamed"'))).toBe(true);
    // trust: the record lives in the user home, keyed by the folder and its content digest
    const t = trustPlugin("beta", { cwd: r.cwd, home: r.home });
    expect(t).toMatchObject({ ok: true, dir: projDir });
    expect(existsSync(join(r.cwd, ".rovecode", "settings.json"))).toBe(false); // never inside the checkout
    expect(loadState(r.home).trusted[trustKey(projDir)]).toBe(pluginDigest(projDir));
    expect(discoverPlugins(r.cwd, { home: r.home }).plugins.find((p) => p.name === "beta")!.status).toBe("active");
    // any changed byte asks again
    writeFileSync(join(projDir, "index.ts"), "export default { api: 1 }; // edited");
    expect(discoverPlugins(r.cwd, { home: r.home }).plugins.find((p) => p.name === "beta")!.status).toBe("untrusted");
    expect(untrustPlugin("beta", { cwd: r.cwd, home: r.home })).toBe(true);
    expect(untrustPlugin("beta", { cwd: r.cwd, home: r.home })).toBe(false);
    // trusting a broken plugin is refused by the CLI, and the install verb reports a missing one
    expect(trustPlugin("nope", { cwd: r.cwd, home: r.home })).toMatchObject({ ok: false });
    // the kill switch
    process.env.ROVECODE_NO_PLUGINS = "1";
    try { expect(discoverPlugins(r.cwd, { home: r.home }).plugins).toEqual([]); } finally { delete process.env.ROVECODE_NO_PLUGINS; }
    // the home IS <cwd>/.rovecode (rovecode run inside its own config dir's parent with ROVECODE_HOME there): one root, scanned once
    expect(pluginRoots(r.cwd, join(r.cwd, ".rovecode"))).toEqual([["project", join(r.cwd, ".rovecode", "plugins")]]);
    expect(pluginRoots(r.cwd, r.home)).toEqual([["user", join(r.home, "plugins")], ["project", join(r.cwd, ".rovecode", "plugins")]]);
  } finally { r.done(); }
});

test("digest: the same folder hashes the same, one byte moves it, node_modules and .git do not count", () => {
  const r = rig();
  try {
    const dir = plugin(userRoot(r), "d", {}, { "a.txt": "1", "sub/b.txt": "2" });
    const d1 = pluginDigest(dir);
    expect(pluginDigest(dir)).toBe(d1);
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true }); writeFileSync(join(dir, "node_modules", "x", "i.js"), "junk");
    mkdirSync(join(dir, ".git")); writeFileSync(join(dir, ".git", "HEAD"), "ref");
    expect(pluginDigest(dir)).toBe(d1);
    writeFileSync(join(dir, "sub", "b.txt"), "3");
    expect(pluginDigest(dir)).not.toBe(d1);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  } finally { r.done(); }
});

// ---------- activation ----------

test("activation: an entry module contributes validated tools and hooks; the factory sees its ctx; bad tools and unknown hooks are dropped by name; declarative dirs resolve or warn; MCP entries normalize", async () => {
  const r = rig();
  try {
    const dir = plugin(userRoot(r), "full", { entry: "index.ts", commands: "cmds", skills: "sk", mcp: { fs: { command: "npx", args: ["-y", "fs"] }, bad: 5 } }, {
      "cmds/hi.md": "---\ndescription: hi\n---\nsay hi $ARGUMENTS\n",
      "sk/one/SKILL.md": "---\nname: one\ndescription: d\n---\nbody\n",
      "index.ts": `export default { api: 1, extra: 1,
        tools: (ctx) => [${TOOL("good_tool", "memory")}, ${TOOL("Bad-Name")}, ${TOOL("bad_kind", "root")}, { kind: "read", schema: { name: "no_exec", description: "d", args: {} } }, { kind: "read", schema: { name: "no_desc", description: "", args: {} }, execute() {} }, ${TOOL("good_tool")}, { kind: "read", schema: { name: "ctx_tool", description: ctx.pluginDir + "|" + ctx.cwd + "|" + ctx.home, args: {} }, async execute() { return { ok: true, output: "" }; } }],
        hooks: { pre_tool() {}, made_up() {}, post_run: 3 } };`,
    });
    plugin(userRoot(r), "nodir", { commands: "missing" });
    const d = discoverPlugins(r.cwd, { home: r.home });
    const a = await activatePlugins(d.plugins, { cwd: r.cwd, home: r.home });
    const full = a.plugins.find((p) => p.name === "full")!;
    expect(full.tools.map((t) => t.schema.name)).toEqual(["good_tool", "ctx_tool"]);
    expect(full.tools[1]!.schema.description).toBe(`${dir}|${r.cwd}|${r.home}`);
    expect(Object.keys(full.hooks!)).toEqual(["pre_tool"]);
    expect(full.commandsDir).toBe(join(dir, "cmds"));
    expect(full.skillsDir).toBe(join(dir, "sk"));
    expect(full.mcp.map((m) => [m.name, m.transport, m.command])).toEqual([["fs", "stdio", "npx"]]);
    // code findings come from activation, declarative ones (a missing dir, a bad MCP entry) from discovery — no code ran for those
    const w = a.warnings.join("\n"), dw = d.warnings.join("\n");
    for (const needle of ['tool name "Bad-Name"', 'kind "root" is not one of', 'tool "no_exec" has no execute()', 'tool "no_desc" needs a description', 'tool "good_tool" declared twice', 'unknown hook "made_up"', 'hook "post_run" is not a function', 'unknown member "extra"']) {
      expect(w).toContain(needle);
    }
    for (const needle of ['plugin nodir: commands directory "missing" does not exist', 'server "bad"']) expect(dw).toContain(needle);
    expect(d.plugins.find((p) => p.name === "full")!.commandsDir).toBe(join(dir, "cmds")); // resolved before any import
    // the tool runs — it is a real Tool object the registry can take
    expect(await full.tools[0]!.execute({}, {} as never)).toEqual({ ok: true, output: "good_tool" });
  } finally { r.done(); }
});

test("activation: the module api gate, a missing entry, a throwing module and a hanging one each cost one warning and never the other plugins; non-active plugins carry no contributions", async () => {
  const r = rig();
  try {
    plugin(userRoot(r), "old", { entry: "i.ts" }, { "i.ts": "export default { api: 0, tools: [] };" });
    plugin(userRoot(r), "gone", { entry: "i.ts" });
    plugin(userRoot(r), "throws", { entry: "i.ts" }, { "i.ts": "throw new Error('boom at import');" });
    plugin(userRoot(r), "hangs", { entry: "i.ts" }, { "i.ts": "await new Promise((r) => setTimeout(r, 400));\nexport default { api: 1 };" });
    plugin(userRoot(r), "slowtools", { entry: "i.ts" }, { "i.ts": "export default { api: 1, tools: () => new Promise((r) => setTimeout(() => r([]), 400)) };" });
    plugin(userRoot(r), "notdefault", { entry: "i.ts" }, { "i.ts": "export const x = 1;" });
    plugin(userRoot(r), "fine", { entry: "i.ts" }, { "i.ts": `export default { api: 1, tools: [${TOOL("fine_tool")}] };` });
    plugin(userRoot(r), "off", { entry: "i.ts" }, { "i.ts": `export default { api: 1, tools: [${TOOL("off_tool")}] };` });
    saveState(r.home, { disabled: ["off"], trusted: {} });
    const d = discoverPlugins(r.cwd, { home: r.home });
    const a = await activatePlugins(d.plugins, { cwd: r.cwd, home: r.home, timeoutMs: 80 });
    const by = Object.fromEntries(a.plugins.map((p) => [p.name, p]));
    expect(by["fine"]!.tools.map((t) => t.schema.name)).toEqual(["fine_tool"]);
    expect(by["off"]).toMatchObject({ status: "disabled", tools: [], hooks: null }); // never imported
    for (const n of ["old", "gone", "throws", "hangs", "slowtools", "notdefault"]) expect(by[n]!.tools).toEqual([]);
    const w = a.warnings;
    expect(w.find((x) => x.startsWith("plugin old:"))).toContain("declares api 0; this rovecode speaks 1");
    expect(w.find((x) => x.startsWith("plugin gone:"))).toContain("entry i.ts does not exist");
    expect(w.find((x) => x.startsWith("plugin throws:"))).toContain("boom at import");
    expect(w.find((x) => x.startsWith("plugin hangs:"))).toContain("load timed out after 80ms");
    expect(w.find((x) => x.startsWith("plugin slowtools:"))).toContain("tools() timed out after 80ms");
    expect(w.find((x) => x.startsWith("plugin notdefault:"))).toContain("must `export default { api: 1, tools?, hooks? }`");
    expect(w.filter((x) => x.startsWith("plugin fine:"))).toEqual([]);
  } finally { r.done(); }
});

// ---------- install verbs ----------

test("install: add copies a folder into the scope root (node_modules/.git left behind), refuses a duplicate without --force, replaces with it; --project records trust; a git source is cloned through the injected spawn; remove drops folder and trust; enable/disable edit plugins.json", async () => {
  const r = rig();
  const src = mkdtempSync(join(tmpdir(), "rovecode-plug-src-"));
  try {
    plugin(src, "acme", { version: "1.0.0", entry: "index.ts" }, { "index.ts": "export default { api: 1 };", "node_modules/x/i.js": "junk", ".git/HEAD": "ref" });
    const a1 = await addPlugin(join(src, "acme"), { cwd: r.cwd, home: r.home, scope: "user" });
    expect(a1).toMatchObject({ ok: true, name: "acme", scope: "user", dir: join(userRoot(r), "acme") });
    expect(existsSync(join(userRoot(r), "acme", "index.ts"))).toBe(true);
    expect(existsSync(join(userRoot(r), "acme", "node_modules"))).toBe(false);
    expect(existsSync(join(userRoot(r), "acme", ".git"))).toBe(false);
    expect(await addPlugin(join(src, "acme"), { cwd: r.cwd, home: r.home, scope: "user" })).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    writeFileSync(join(src, "acme", "plugin.json"), JSON.stringify({ api: 1, name: "acme", version: "1.1.0", entry: "index.ts" }));
    const a2 = await addPlugin(join(src, "acme"), { cwd: r.cwd, home: r.home, scope: "user", force: true });
    expect(a2.ok && a2.manifest.version).toBe("1.1.0");
    // a folder that is not a plugin never lands
    expect(await addPlugin(src, { cwd: r.cwd, home: r.home, scope: "user" })).toMatchObject({ ok: false, error: expect.stringContaining("no plugin.json") });
    expect(await addPlugin(join(src, "nowhere"), { cwd: r.cwd, home: r.home, scope: "user" })).toMatchObject({ ok: false, error: expect.stringContaining("not a directory") });
    // project scope: the human ran the command, so the copy is trusted at once
    const a3 = await addPlugin(join(src, "acme"), { cwd: r.cwd, home: r.home, scope: "project" });
    expect(a3).toMatchObject({ ok: true, scope: "project", dir: join(projRoot(r), "acme") });
    expect(loadState(r.home).trusted[trustKey(join(projRoot(r), "acme"))]).toBe(pluginDigest(join(projRoot(r), "acme")));
    expect(discoverPlugins(r.cwd, { home: r.home }).plugins.find((p) => p.scope === "project")!.status).toBe("active");
    // git: the injected spawn stands in for `git clone` and writes a plugin into the clone dir
    const seen: string[][] = [];
    // git clone <url> <dir> puts the repo ROOT at <dir>: the manifest sits directly in the clone folder
    const spawn = async (cmd: string[], cwd: string) => { seen.push(cmd); plugin(cwd, cmd[cmd.length - 1]!, { name: "remote", version: "9.9.9" }); return { code: 0, stderr: "" }; };
    expect(isGitSource("https://github.com/x/y.git")).toBe(true); expect(isGitSource("git@github.com:x/y.git")).toBe(true); expect(isGitSource(src)).toBe(false);
    const g = await addPlugin("https://github.com/x/remote.git", { cwd: r.cwd, home: r.home, scope: "user", spawn });
    expect(g).toMatchObject({ ok: true, name: "remote" });
    expect(seen[0]!.slice(0, 5)).toEqual(["git", "clone", "--depth", "1", "--quiet"]);
    expect(readFileSync(join(userRoot(r), "remote", "plugin.json"), "utf8")).toContain("9.9.9");
    const bad = await addPlugin("https://github.com/x/none.git", { cwd: r.cwd, home: r.home, scope: "user", spawn: async () => ({ code: 128, stderr: "fatal: repository not found\n" }) });
    expect(bad).toMatchObject({ ok: false, error: "git clone failed (exit 128): fatal: repository not found" });
    // enable/disable, remove
    expect(setPluginEnabled("acme", false, r.home)).toBe(statePath(r.home));
    expect(loadState(r.home).disabled).toEqual(["acme"]);
    setPluginEnabled("acme", true, r.home);
    expect(loadState(r.home).disabled).toEqual([]);
    const rm = removePlugin("acme", { cwd: r.cwd, home: r.home, scope: "project" });
    expect(rm).toMatchObject({ ok: true });
    expect(existsSync(join(projRoot(r), "acme"))).toBe(false);
    expect(loadState(r.home).trusted).toEqual({});
    expect(removePlugin("acme", { cwd: r.cwd, home: r.home, scope: "project" })).toMatchObject({ ok: false });
  } finally { r.done(); rmSync(src, { recursive: true, force: true }); }
});

test("loadPlugins end to end + the boot summary line", async () => {
  const r = rig();
  try {
    plugin(userRoot(r), "a", { entry: "i.ts" }, { "i.ts": `export default { api: 1, tools: [${TOOL("a_tool")}] };` });
    plugin(projRoot(r), "p");
    plugin(userRoot(r), "x", {}, {}); saveState(r.home, { disabled: ["x"], trusted: {} });
    mkdirSync(join(userRoot(r), "b")); writeFileSync(join(userRoot(r), "b", "plugin.json"), "nope");
    const l = await loadPlugins(r.cwd, { home: r.home });
    expect(l.plugins.map((p) => [p.name, p.status, p.tools.length])).toEqual([["a", "active", 1], ["b", "broken", 0], ["p", "untrusted", 0], ["x", "disabled", 0]]);
    expect(summarizePlugins(l.plugins)).toBe("plugins: 1 active (a) · 1 untrusted (p) · 1 disabled (x) · 1 broken (b)");
    expect(summarizePlugins([])).toBeNull();
    expect(l.warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
  } finally { r.done(); }
});

/** Every real plugin lives in a subfolder of a repository that publishes several: rovecode's own three
 *  are `plugins/safety-net`, `plugins/notes` and `plugins/conventional-commits`. While `add` looked only
 *  at the clone root, a catalog could not install any of them — which is why the plugin catalog stayed
 *  empty until this landed. */
test("install --subfolder: takes the plugin out of a monorepo, and refuses one that climbs out of it", async () => {
  const r = rig();
  const src = mkdtempSync(join(tmpdir(), "rovecode-plug-mono-"));
  try {
    // a repo that ships two plugins, neither at the root
    mkdirSync(join(src, "plugins"), { recursive: true });
    plugin(join(src, "plugins"), "alpha", { version: "2.0.0" });
    plugin(join(src, "plugins"), "beta");
    writeFileSync(join(src, "README.md"), "a monorepo, no manifest at the root");

    // without a subfolder the root has no manifest — the old behaviour, unchanged
    expect(await addPlugin(src, { cwd: r.cwd, home: r.home, scope: "user" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("no plugin.json") });

    const ok = await addPlugin(src, { cwd: r.cwd, home: r.home, scope: "user", subfolder: "plugins/alpha" });
    expect(ok).toMatchObject({ ok: true, name: "alpha" });
    // it lands under its own name, not the repository's, and carries the subfolder's manifest
    expect(existsSync(join(userRoot(r), "alpha", "plugin.json"))).toBe(true);
    expect(existsSync(join(userRoot(r), "plugins"))).toBe(false);
    expect((ok as { manifest: { version: string } }).manifest.version).toBe("2.0.0");
    // and only that one: a sibling in the same repo is not dragged along
    expect(existsSync(join(userRoot(r), "beta"))).toBe(false);

    // a subfolder is a path inside the source, and nothing else
    for (const bad of ["../outside", "plugins/../../etc", "/etc", "C:\\Windows"]) {
      expect(await addPlugin(src, { cwd: r.cwd, home: r.home, scope: "user", subfolder: bad }))
        .toMatchObject({ ok: false, error: expect.stringContaining("escapes the source") });
    }
    // a subfolder that is simply not there says so, rather than falling back to the root
    expect(await addPlugin(src, { cwd: r.cwd, home: r.home, scope: "user", subfolder: "plugins/nope" }))
      .toMatchObject({ ok: false, error: expect.stringContaining('no folder "plugins/nope"') });

    // the same through a git source: clone, then take the subfolder out of the clone
    const spawn = async (cmd: string[], cwd: string) => {
      const dir = join(cwd, cmd[cmd.length - 1]!);
      mkdirSync(join(dir, "plugins"), { recursive: true });
      plugin(join(dir, "plugins"), "remote", { version: "3.1.0" });
      return { code: 0, stderr: "" };
    };
    const g = await addPlugin("https://github.com/x/mono.git", { cwd: r.cwd, home: r.home, scope: "user", subfolder: "plugins/remote", spawn });
    expect(g).toMatchObject({ ok: true, name: "remote" });
    expect(existsSync(join(userRoot(r), "remote", "plugin.json"))).toBe(true);
  } finally {
    rmSync(src, { recursive: true, force: true });
    r.done();
  }
});

/** The symlink filter, tested through BEHAVIOUR rather than through the helper that implements it.
 *
 *  This exists because the filter was committed and then silently disappeared: `isSymlink` stayed in the
 *  file, its only call site did not, and nothing said a word — tsc does not object to a function nobody
 *  calls, and no test named the effect. A test that imported `isSymlink` and checked it returns true for a
 *  link would have stayed green through the entire regression, because the helper was never what broke.
 *  So this one installs a plugin whose folder contains a link pointing OUT of it and asks the only
 *  question that matters: did the thing on the other side come along?
 *
 *  Junctions, not file symlinks, on Windows: creating a file symlink there needs Developer Mode or an
 *  elevated shell (EPERM on this machine), while a directory junction needs neither and `lstat` reports it
 *  as a symbolic link just the same — so the test runs everywhere instead of skipping exactly where the
 *  filter is least exercised. */
function linkTo(target: string, path: string, kind: "file" | "dir"): boolean {
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  try { symlinkSync(target, path, kind === "dir" ? "junction" : "file"); return true; }
  catch { return false; }
}

test("a link pointing out of the source is not copied, so an install cannot drag in what it aims at", async () => {
  const r = rig();
  try {
    const outside = mkdtempSync(join(tmpdir(), "rovecode-outside-"));
    writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");

    const src = plugin(r.cwd, "linky", { entry: "index.ts" }, { "index.ts": "export default { api: 1 };" });
    const linked = linkTo(outside, join(src, "stolen"), "dir");
    expect(linked, "could not create a junction; this platform cannot run the test at all").toBe(true);

    const out = await addPlugin(src, { cwd: r.cwd, home: r.home, scope: "user" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // the plugin's own files are there — the filter drops links, not everything
    expect(existsSync(join(out.dir, "plugin.json"))).toBe(true);
    expect(existsSync(join(out.dir, "index.ts"))).toBe(true);
    // and the link, with whatever it pointed at, is not
    expect(existsSync(join(out.dir, "stolen"))).toBe(false);
    expect(existsSync(join(out.dir, "stolen", "id_rsa"))).toBe(false);

    rmSync(outside, { recursive: true, force: true });
  } finally { r.done(); }
});
