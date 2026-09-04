/** `rovecode plugin …` driven without a process: list rows and statuses, add from a folder (user and
 *  --project), the restart reminder, remove, enable/disable, trust refusing a broken plugin and
 *  approving a good one, show listing files without running anything, usage + exit codes. */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPlugin, PLUGIN_USAGE } from "../../src/plugins/cli.ts";
import { discoverPlugins } from "../../src/plugins/discover.ts";

function rig(): { cwd: string; home: string; src: string; out: string[]; err: string[]; run: (args: string[]) => Promise<number>; done: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-pcli-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-pcli-home-"));
  const src = mkdtempSync(join(tmpdir(), "rovecode-pcli-src-"));
  const out: string[] = [], err: string[] = [];
  return {
    cwd, home, src, out, err,
    run: (args) => cmdPlugin(args, { cwd, home, out: (l) => out.push(l), err: (l) => err.push(l) }),
    done: () => { for (const d of [cwd, home, src]) rmSync(d, { recursive: true, force: true }); },
  };
}
function folder(root: string, name: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ api: 1, name, version: "1.2.3", description: "does a thing", ...manifest }));
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}

test("plugin list: the empty hint, then one row per plugin with scope and status; warnings go to stderr", async () => {
  const r = rig();
  try {
    expect(await r.run([])).toBe(0);
    expect(r.out[0]).toContain("no plugins. add one: rovecode plugin add <folder|git-url>");
    r.out.length = 0;
    folder(join(r.home, "plugins"), "alpha", { version: "0.4.0" });
    folder(join(r.cwd, ".rovecode", "plugins"), "beta");
    mkdirSync(join(r.home, "plugins", "bad")); writeFileSync(join(r.home, "plugins", "bad", "plugin.json"), "{");
    expect(await r.run(["list"])).toBe(0);
    expect(r.out).toEqual([
      "alpha@0.4.0                  user     active    — does a thing",
      "bad                          user     broken",
      "beta@1.2.3                   project  untrusted — does a thing",
    ]);
    expect(r.err.some((l) => l.startsWith("warning: ") && l.includes("not valid JSON"))).toBe(true);
  } finally { r.done(); }
});

test("plugin add / remove / enable / disable: the verbs and their messages, --project trusts at once, usage on a missing argument", async () => {
  const r = rig();
  try {
    folder(r.src, "acme", { entry: "index.ts", commands: "cmds" }, { "index.ts": "export default { api: 1 };", "cmds/x.md": "hi" });
    expect(await r.run(["add", join(r.src, "acme")])).toBe(0);
    expect(r.out[0]).toBe(`added acme@1.2.3 (user) → ${join(r.home, "plugins", "acme")}`);
    expect(r.out.slice(1)).toEqual(["  code: index.ts", "  commands: cmds/", "restart rovecode to load it — plugins are read once per process, like hooks"]);
    expect(await r.run(["add", join(r.src, "acme")])).toBe(1); // duplicate
    expect(r.err.at(-1)).toContain("already exists");
    r.out.length = 0;
    expect(await r.run(["add", join(r.src, "acme"), "--project", "--force"])).toBe(0);
    expect(r.out[0]).toContain("(project)");
    expect(r.out.some((l) => l.includes("trusted on this machine"))).toBe(true);
    expect(discoverPlugins(r.cwd, { home: r.home }).plugins.find((p) => p.scope === "project")!.status).toBe("active");
    expect(await r.run(["add"])).toBe(2); expect(r.err.at(-1)).toBe(PLUGIN_USAGE);
    expect(await r.run(["add", join(r.src, "missing")])).toBe(1);
    r.out.length = 0;
    expect(await r.run(["disable", "acme"])).toBe(0);
    expect(r.out[0]).toMatch(/^acme disabled \(.*plugins\.json\)$/);
    expect(discoverPlugins(r.cwd, { home: r.home }).plugins.every((p) => p.status === "disabled")).toBe(true);
    expect(await r.run(["enable", "acme"])).toBe(0);
    expect(await r.run(["enable", "ghost"])).toBe(0); // recorded with a warning, not an error
    expect(r.err.at(-1)).toContain('no installed plugin named "ghost"');
    expect(await r.run(["remove", "acme", "--project"])).toBe(0);
    expect(existsSync(join(r.cwd, ".rovecode", "plugins", "acme"))).toBe(false);
    expect(existsSync(join(r.home, "plugins", "acme"))).toBe(true); // the user copy stays
    expect(await r.run(["remove", "acme", "--project"])).toBe(1);
    expect(await r.run(["bogus"])).toBe(2); expect(r.err.at(-1)).toContain('unknown plugin command "bogus"');
    expect(await r.run(["help"])).toBe(0); expect(r.out.at(-1)).toBe(PLUGIN_USAGE);
  } finally { r.done(); }
});

test("plugin trust / untrust / show: show lists every file without importing any; trust refuses a broken plugin, approves a good one and reports the digest; a user plugin cannot be 'trusted' (it already is)", async () => {
  const r = rig();
  try {
    const dir = folder(join(r.cwd, ".rovecode", "plugins"), "proj", { entry: "index.ts", skills: "sk" }, { "index.ts": "throw new Error('must not run');", "sk/one/SKILL.md": "---\nname: one\ndescription: d\n---\nb" });
    expect(await r.run(["show", "proj"])).toBe(0);
    expect(r.out[0]).toContain("project  untrusted");
    expect(r.out).toContain(`  folder:  ${dir}`);
    expect(r.out.filter((l) => l.startsWith("  - ")).sort()).toEqual(["  - index.ts", "  - plugin.json", "  - sk/one/SKILL.md"]);
    expect(r.out.at(-1)).toBe("  run `rovecode plugin trust proj` after reading the files above");
    r.out.length = 0;
    expect(await r.run(["trust", "proj"])).toBe(0);
    expect(r.out[0]).toMatch(/^trusted proj@1\.2\.3 — 3 files, digest [0-9a-f]{12}…$/);
    expect(r.out).toContain("  code: index.ts");
    expect(discoverPlugins(r.cwd, { home: r.home }).plugins[0]!.status).toBe("active");
    expect(await r.run(["untrust", "proj"])).toBe(0); expect(r.out.at(-1)).toBe("untrusted proj");
    expect(await r.run(["untrust", "proj"])).toBe(0); expect(r.out.at(-1)).toBe("proj was not trusted");
    mkdirSync(join(r.cwd, ".rovecode", "plugins", "broken")); writeFileSync(join(r.cwd, ".rovecode", "plugins", "broken", "plugin.json"), JSON.stringify({ api: 3, name: "broken", version: "1" }));
    expect(await r.run(["trust", "broken"])).toBe(1);
    expect(r.err.at(-2)).toContain('"broken" is broken — fix it first');
    expect(r.err.at(-1)).toContain("plugin API version 3 is not supported");
    folder(join(r.home, "plugins"), "mine");
    expect(await r.run(["trust", "mine"])).toBe(1); // user scope needs no trust; the verb is for project plugins
    expect(r.err.at(-1)).toContain('no project plugin "mine"');
    expect(await r.run(["show", "nope"])).toBe(1);
  } finally { r.done(); }
});
