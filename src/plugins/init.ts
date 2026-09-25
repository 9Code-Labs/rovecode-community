/** `rovecode plugin init` + `rovecode plugin test` (F4, sdk-blueprint.md §6).
 *
 *  init: scaffolds a plugin folder (manifest with an empty permissions declaration, a
 *  tool+hook entry, a bun:test file, a README) into <cwd>/<name> — or straight into a
 *  scope with --project. Nothing is installed; `plugin add` is the install step.
 *
 *  test: the development loop — parse the manifest, activate the plugin in a dry harness
 *  (activatePlugins against a synthetic discovery entry, cwd = a throwaway tmp dir so a
 *  misbehaving module cannot touch the repo), report every contribution and warning, then
 *  run the plugin's own plugin.test.ts under `bun test` when present. Exit codes: 2 usage,
 *  1 validation/activation problems or failing tests, 0 clean. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseManifest, contributions, PLUGIN_API_VERSION, MANIFEST_FILE, type PluginManifest } from "./manifest.ts";
import { activatePlugins } from "./load.ts";
import type { DiscoveredPlugin } from "./discover.ts";

interface Out { cwd: string; out: (l: string) => void; err: (l: string) => void }

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ENTRY_TS = `/** <name> — a rovecode plugin. The default export is the whole contract:
 *  api (PLUGIN_API_VERSION), tools (Tool[] or a factory), hooks (HookSet).
 *  Docs: docs/design/sdk-blueprint.md §6 */
import type { Tool, HookSet } from "rovecode/core"; // resolved by rovecode at load time

const hello: Tool = {
  schema: {
    name: "<tool>_hello",
    description: "Says hello from the <name> plugin.",
    args: { type: "object", properties: { who: { type: "string" } } },
  },
  kind: "read", // read = no workspace effect; kinds map to policy actions (see plugin.json permissions)
  // sequential: false — concurrent with siblings in a batch; only stateful tools go sequential
  async execute(args) {
    const a = args as { who?: string };
    return { ok: true, output: \`hello, \${typeof a.who === "string" ? a.who : "world"}!\` };
  },
};

const hooks: HookSet = {
  // pre_tool: async ({ tool }) => tool === "bash" ? { deny: "nope" } : undefined,
};

export default { api: ${PLUGIN_API_VERSION}, tools: [hello], hooks };
`;

const TEST_TS = `/** The plugin's own tests — \`rovecode plugin test\` runs this file under bun:test. */
import { test, expect } from "bun:test";
import plugin from "./index.ts";

test("module shape", () => {
  expect(plugin.api).toBe(${PLUGIN_API_VERSION});
  expect(Array.isArray(plugin.tools)).toBe(true);
});

test("hello tool", async () => {
  const tool = (plugin.tools ?? [])[0]!;
  const out = await tool.execute({ who: "tests" }, {} as never);
  expect(out.ok).toBe(true);
  expect(out.output).toContain("hello, tests!");
});
`;

const README_MD = (name: string): string => `# ${name}

A rovecode plugin.

- \\\"permissions\\\" in plugin.json declares the policy actions its tools may take
  (file.read, file.write, shell.exec, spawn, memory.write, net.fetch). A tool whose
  kind is not declared is refused at run time — the list is a promise, not a comment.
- Develop: \\\`rovecode plugin test .\\\` in this folder.
- Install: \\\`rovecode plugin add .\\\` (user scope) or \\\`rovecode plugin add . --project\\\`.
`;

export async function cmdPluginInit(words: string[], o: Out): Promise<number> {
  const name = words[0];
  if (!name || !NAME_RE.test(name)) { o.err(`plugin init: name must match ${NAME_RE}`); return 2; }
  const dir = join(o.cwd, name);
  if (existsSync(dir)) { o.err(`plugin init: ${dir} already exists`); return 1; }
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name,
    version: "0.1.0",
    description: `${name} plugin`,
    api: PLUGIN_API_VERSION,
    entry: "index.ts",
    permissions: [] as string[],
  };
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "index.ts"), ENTRY_TS.replaceAll("<name>", name).replaceAll("<tool>", name.replaceAll("-", "_")));
  writeFileSync(join(dir, "plugin.test.ts"), TEST_TS);
  writeFileSync(join(dir, "README.md"), README_MD(name));
  o.out(`scaffolded ${name} at ${dir}`);
  o.out(`next: rovecode plugin test ${dir}   ·   rovecode plugin add ${dir}`);
  return 0;
}

export async function cmdPluginTest(path: string | undefined, o: { cwd: string; home: string; out: (l: string) => void; err: (l: string) => void }): Promise<number> {
  const dir = resolve(o.cwd, path ?? ".");
  const mf = join(dir, MANIFEST_FILE);
  if (!existsSync(mf)) { o.err(`plugin test: no ${MANIFEST_FILE} in ${dir}`); return 2; }
  const warnings: string[] = [];
  const manifest = parseManifest(readFileSync(mf, "utf8"), mf, warnings);
  if (!manifest) { for (const w of warnings) o.err(w); return 1; }
  o.out(`manifest ok: ${manifest.name}@${manifest.version} (api ${manifest.api})`);
  for (const c of contributions(manifest)) o.out(`  ${c}`);

  // dry activation: cwd is a throwaway dir, so a module that writes "to the project" writes nowhere real
  const scratch = mkdtempSync(join(tmpdir(), "rovecode-plugintest-"));
  try {
    const discovered: DiscoveredPlugin = {
      dir, name: manifest.name, scope: "project", status: "active", manifest,
      digest: null, problems: [], commandsDir: null, skillsDir: null, mcp: [],
    };
    const { plugins, warnings: aw } = await activatePlugins([discovered], { cwd: scratch, home: scratch });
    for (const w of aw) o.err(`warning: ${w}`);
    const p = plugins[0];
    const tools = p?.tools ?? [];
    o.out(`activated: ${tools.length} tool(s)${tools.length ? ` [${tools.map((t) => `${t.schema.name}:${t.kind}`).join(", ")}]` : ""}, hooks ${p?.hooks ? "yes" : "none"}`);
    if (aw.length > 0) return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const testFile = join(dir, "plugin.test.ts");
  if (existsSync(testFile)) {
    o.out(`running ${testFile} …`);
    const proc = Bun.spawn([process.execPath, "test", testFile], { cwd: dir, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) { o.err(`plugin.test.ts failed (exit ${code})`); return 1; }
  } else {
    o.out("no plugin.test.ts — add one for `plugin test` to exercise behavior, not just shape");
  }
  o.out("plugin test: ok");
  return 0;
}
