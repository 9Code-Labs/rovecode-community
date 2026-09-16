/** `rovecode trust` through the real CLI (main.ts child, scratch cwd + scratch ROVECODE_HOME, env scrubbed) and the
 *  end-to-end proof the gate exists for: a checkout with ALL FIVE gated files planted, each carrying a marker-writing
 *  command, booted by `rovecode run … --output json` (mock provider, ROVECODE_VERIFY=1 so the verify gate is on) — exit 0,
 *  NO marker anywhere, and stderr names every ignored file once. Then `trust --yes`, and the same boot runs the hook. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
let cwd = "", home = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-trust-cli-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-trust-clihome-"));
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

function cli(args: string[], extra: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  env.HOME = home; env.USERPROFILE = home; env.ROVECODE_HOME = home;
  Object.assign(env, extra);
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000, killSignal: "SIGKILL" });
  if (r.exitCode === null) throw new Error(`rovecode ${args.join(" ")}: no exit within 120s`);
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
}

/** the five files, each able to leave a marker if it ever ran */
function plantAll(): { markers: string[] } {
  const m = (n: string) => join(cwd, `${n}.ran`);
  const bunWrite = (n: string) => JSON.stringify([process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(m(n))}, "ran")`]);
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({
    verify: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(m("verify"))}, 'ran')"`,
    lsp: `.ts=${process.execPath} -e "require('node:fs').writeFileSync(${JSON.stringify(m("lsp"))}, 'ran')"`,
    notify_command: bunWrite("notify"),
  }));
  writeFileSync(join(cwd, ".rovecode", "hooks.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(m("hooks-module"))}, "ran");\nexport default { version: 1, hooks: { session_open() { writeFileSync(${JSON.stringify(m("hooks-open"))}, "ran"); } } };\n`);
  writeFileSync(join(cwd, ".rovecode", "sandbox.json"), JSON.stringify({ rung: "docker", dockerImage: "evil/image" }));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(m("mcp"))}, "ran")`] } } }));
  return { markers: ["verify", "lsp", "notify", "hooks-module", "hooks-open", "mcp"].map(m) };
}

test("a checkout with all five gated files planted: `rovecode run` boots, exit 0, NO marker anywhere (nothing of the repo's ran), stderr names settings.json, hooks.ts, sandbox.json and .mcp.json once each; `trust show` lists them all untrusted with what they carry", () => {
  const { markers } = plantAll();
  const r = cli(["run", "say hi", "--output", "json"], { ROVECODE_MOCK: "1", ROVECODE_VERIFY: "1" });
  expect(r.code).toBe(0);
  expect((JSON.parse(r.stdout) as { status: string }).status).toBe("done");
  for (const m of markers) expect([m, existsSync(m)]).toEqual([m, false]); // MUTATION: any gate missing → its marker appears
  for (const f of [join(cwd, ".rovecode", "settings.json"), join(cwd, ".rovecode", "hooks.ts"), join(cwd, ".rovecode", "sandbox.json"), join(cwd, ".mcp.json")]) {
    expect(r.stderr.split(f).length - 1, f).toBe(1); // named once
    expect(r.stderr).toContain("not trusted on this machine");
  }
  const show = cli(["trust", "show"]);
  expect(show.code).toBe(0);
  const lines = show.stdout.trimEnd().split("\n");
  expect(lines.filter((l) => l.startsWith("· UNTRUSTED")).length).toBe(4);
  expect(show.stdout).toContain("verify: ");
  expect(show.stdout).toContain("rung: docker");
  expect(show.stdout).toContain("dockerImage: evil/image");
  expect(show.stdout).toContain("evil: ");
  expect(show.stdout).toContain("code imported in-process at boot");
  expect(existsSync(join(home, "plugins.json"))).toBe(false); // show changes nothing
}, 240_000);

test("`trust` off a TTY without --yes refuses and records nothing; `trust --yes` records all four in the home's plugins.json and the next boot IMPORTS the hooks file (its markers appear); one edited byte in hooks.ts re-asks; `trust untrust` withdraws", () => {
  const { markers } = plantAll();
  const refused = cli(["trust"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("--yes");
  expect(existsSync(join(home, "plugins.json"))).toBe(false);
  const yes = cli(["trust", "--yes"]);
  expect(yes.code).toBe(0);
  expect(yes.stdout.split("\n").filter((l) => l.startsWith("trusted ")).length).toBe(4);
  const state = JSON.parse(readFileSync(join(home, "plugins.json"), "utf8")) as { trusted: Record<string, string> };
  expect(Object.keys(state.trusted).length).toBe(4);
  expect(Object.values(state.trusted).every((d) => /^[0-9a-f]{64}$/.test(d))).toBe(true);
  // the hooks file now loads: its top level and session_open both leave their marks (the other markers need a real
  // edit / an unfocused TUI / a docker daemon to fire — the hooks one is the proof that the SAME store gates them all)
  const boot = cli(["run", "say hi", "--output", "json"], { ROVECODE_MOCK: "1", ROVECODE_SANDBOX: "direct" }); // the env beats the now-trusted docker choice, so no daemon is needed
  expect(boot.code).toBe(0);
  expect(existsSync(markers[3]!)).toBe(true);  // hooks-module
  expect(existsSync(markers[4]!)).toBe(true);  // hooks-open
  expect(boot.stderr).not.toContain("not trusted on this machine");
  writeFileSync(join(cwd, ".rovecode", "hooks.ts"), readFileSync(join(cwd, ".rovecode", "hooks.ts"), "utf8") + "// edited\n");
  const show = cli(["trust", "show"]);
  expect(show.stdout.split("\n").filter((l) => l.startsWith("· UNTRUSTED")).length).toBe(1);
  expect(show.stdout.split("\n").filter((l) => l.startsWith("✓ trusted")).length).toBe(3);
  const un = cli(["trust", "untrust"]);
  expect(un.code).toBe(0);
  expect(un.stdout.split("\n").filter((l) => l.startsWith("untrusted ")).length).toBe(4); // the edited hooks file's STALE entry goes too — withdrawing is by path, not by digest
  expect(Object.keys((JSON.parse(readFileSync(join(home, "plugins.json"), "utf8")) as { trusted: Record<string, string> }).trusted)).toEqual([]);
  const bad = cli(["trust", "frobnicate"]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("usage: rovecode trust");
}, 240_000);

test("a repo with nothing gated: `trust show` says so and `trust --yes` exits 1 with nothing to approve; `trust -h` prints the usage", () => {
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ permission: "auto", verify: false }));
  const show = cli(["trust", "show"]);
  expect(show.code).toBe(0);
  expect(show.stdout).toContain("no gated project files here");
  expect(cli(["trust", "--yes"]).code).toBe(1);
  expect(existsSync(join(home, "plugins.json"))).toBe(false);
  const h = cli(["trust", "-h"]);
  expect(h.code).toBe(0);
  expect(h.stdout).toContain("usage: rovecode trust");
}, 240_000);
