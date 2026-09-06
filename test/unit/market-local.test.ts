/** `rovecode market install mcp:<id>` and the install-once offer (mcp/local-package.ts) through the market door.
 *  Pinned: the order (offer → plan → approval → npm → file → record), that --yes / no terminal / --json keep
 *  today's npx line without asking, that --local / --no-local pre-answer the offer, that --dry-run --local shows
 *  the install lines and runs nothing, that --offline refuses to install once, and that `update` keeps an
 *  install-once server on node (the record says so) instead of quietly putting it back on npx. */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket } from "../../src/cli/market-cmd.ts";
import type { MarketEntry } from "../../src/mcp/market.ts";
import { fakeNpm, FAKE_INTEGRITY } from "../helpers/fake-npm.ts";
import type { Spawn } from "../../src/mcp/local-package.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** a curated npx server and a docker one, so the offer has something to say yes to and something to refuse */
const CATALOG: MarketEntry[] = [
  { key: "widgets", title: "Widgets", description: "Widgets for agents.", version: "1.2.0", source: "curated", publisher: "acme",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "widgets-mcp@1.2.0", "--mode", "fast"], env: [], pending: [] }] },
  { key: "boxed", title: "Boxed", description: "Runs in docker.", source: "curated", publisher: "acme",
    installs: [{ kind: "stdio", runtime: "docker", command: "docker", args: ["run", "-i", "--rm", "acme/boxed"], env: [], pending: [] }] },
];

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-mlocal-cwd-")); dirs.push(cwd);
  const home = mkdtempSync(join(tmpdir(), "rovecode-mlocal-home-")); dirs.push(home);
  writeFileSync(join(home, "skills.json"), JSON.stringify({ version: 1, items: [] }));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: CATALOG, offline: true, home } };
  return { cwd, home, registry };
}

async function run(s: ReturnType<typeof scratch>, args: string[], o: { spawn?: Spawn; tty?: boolean; plain?: string[] } = {}) {
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const plain = [...(o.plain ?? [])];
  const code = await cmdMarket(args, {
    cwd: s.cwd, home: s.home, registry: s.registry, tty: o.tty ?? false,
    out: (l) => out.push(l), err: (l) => err.push(l),
    plain: async (p) => { prompts.push(p); return plain.shift() ?? ""; }, secret: async () => "",
    ...(o.spawn ? { run: { spawn: o.spawn } } : {}),
    prereqEnv: { PATH: "", windows: false, exists: () => false },   // no programs on this fake PATH: the requires row is deterministic
  });
  return { code, out, err, prompts, text: out.join("\n") };
}

type Written = { mcpServers: Record<string, { command: string; args: string[] }> };
type Manifest = { installs: { kind: string; id: string; installedBy: string; package?: { name: string; version: string; prefix: string; bin: string; integrity?: string; missing?: string[] } }[] };

test("install --local --yes: the plan names the node line, the npm command and that code lands; requires npm+node; npm runs; the file gets node + absolute bin; the record carries the integrity", async () => {
  const s = scratch();
  const npm = fakeNpm({ version: "1.2.0" });
  const r = await run(s, ["install", "mcp:widgets", "--local", "--yes"], { spawn: npm.spawn });
  expect(r.code).toBe(0);
  const prefix = join(s.home, "mcp");
  const bin = join(prefix, "node_modules", "widgets-mcp", "dist", "index.js");
  expect(r.out).toContain(`  runs       node ${join(prefix, "node_modules", "widgets-mcp")}${process.platform === "win32" ? "\\" : "/"}<its bin, read after the install> --mode fast`);
  expect(r.out).toContain("  requires   npm — not on PATH (install: comes with Node.js — nodejs.org)  ·  node — not on PATH (install: nodejs.org)");
  expect(r.out).toContain(`  installs   npm install --prefix ${prefix} --save --no-fund --no-audit --loglevel=error widgets-mcp@1.2.0`);
  expect(r.text).toContain("rovecode runs a package manager for you here");
  expect(r.text).toContain("puts their CODE on this machine");
  expect(r.out.some((l) => l.startsWith("  records    package name, version and npm's integrity hash"))).toBe(true);
  expect(r.prompts).toEqual([]);                       // --local pre-answered the offer, --yes the approval
  expect(npm.calls).toHaveLength(1);
  expect(r.out).toContain(`installed mcp:widgets → ${join(s.home, "mcp.json")}`);
  expect(r.out).toContain(`  package    widgets-mcp 1.2.0 → ${prefix}  (integrity recorded in installed.json)`);
  const file = JSON.parse(readFileSync(join(s.home, "mcp.json"), "utf8")) as Written;
  expect(file.mcpServers.widgets).toEqual({ command: "node", args: [bin, "--mode", "fast"] });
  const manifest = JSON.parse(readFileSync(join(s.home, "installed.json"), "utf8")) as Manifest;
  expect(manifest.installs).toEqual([expect.objectContaining({ kind: "mcp", id: "widgets", installedBy: "market",
    package: { name: "widgets-mcp", version: "1.2.0", prefix, bin, integrity: FAKE_INTEGRITY } })]);
});

test("the offer on a terminal: asked before the plan, 'y' then the approval 'n' runs no npm and writes nothing; 'n' then 'y' is today's npx line; --yes, --json and no terminal never ask", async () => {
  const s = scratch();
  const npm = fakeNpm();
  const swallow = await run(s, ["install", "mcp:widgets"], { spawn: npm.spawn, tty: true, plain: ["y", "n"] });
  expect(swallow.code).toBe(1);
  expect(swallow.prompts).toEqual(["install widgets-mcp@1.2.0 once? [y/N] ", "install this? [y/N] "]);
  expect(swallow.out.indexOf("Install it once instead?")).toBeLessThan(swallow.out.findIndex((l) => l.startsWith("  runs       node")));
  expect(swallow.out.at(-1)).toBe("nothing written");
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(s.home, "mcp.json"))).toBe(false);
  expect(existsSync(join(s.home, "mcp"))).toBe(false);
  const today = await run(s, ["install", "mcp:widgets"], { spawn: npm.spawn, tty: true, plain: ["n", "y"] });
  expect(today.code).toBe(0);
  expect(today.prompts).toEqual(["install widgets-mcp@1.2.0 once? [y/N] ", "install this? [y/N] "]);
  expect(today.out).toContain("  runs       npx -y widgets-mcp@1.2.0 --mode fast");
  expect(today.out.some((l) => l.startsWith("  installs"))).toBe(false);
  expect(npm.calls).toHaveLength(0);
  expect((JSON.parse(readFileSync(join(s.home, "mcp.json"), "utf8")) as Written).mcpServers.widgets!.command).toBe("npx");
  // scripts and pipes: no question, npx — exactly what they got yesterday
  const s2 = scratch();
  const yes = await run(s2, ["install", "mcp:widgets", "--yes"], { spawn: npm.spawn, tty: true });
  expect(yes.code).toBe(0); expect(yes.prompts).toEqual([]); expect(npm.calls).toHaveLength(0);
  expect((JSON.parse(readFileSync(join(s2.home, "mcp.json"), "utf8")) as Written).mcpServers.widgets!.command).toBe("npx");
  const s3 = scratch();
  const json = await run(s3, ["install", "mcp:widgets", "--json"], { spawn: npm.spawn, tty: true });
  expect(json.code).toBe(1); expect(json.prompts).toEqual([]);   // --json never prompts: needsApproval, as before
  const s4 = scratch();
  const pipe = await run(s4, ["install", "mcp:widgets"], { spawn: npm.spawn, tty: false });
  expect(pipe.code).toBe(1); expect(pipe.prompts).toEqual([]);
  // the docker entry gets no offer at all
  const s5 = scratch();
  const boxed = await run(s5, ["install", "mcp:boxed"], { spawn: npm.spawn, tty: true, plain: ["y"] });
  expect(boxed.code).toBe(0);
  expect(boxed.prompts).toEqual(["install this? [y/N] "]);
});

test("--dry-run --local shows the install lines and runs nothing; --offline --local is refused with a way out; --local on a docker entry is an error before anything is asked", async () => {
  const s = scratch();
  const npm = fakeNpm();
  const dry = await run(s, ["install", "mcp:widgets", "--local", "--dry-run"], { spawn: npm.spawn, tty: true });
  expect(dry.code).toBe(0);
  expect(dry.out.some((l) => l.startsWith("  installs   npm install"))).toBe(true);
  expect(dry.out.at(-1)).toMatch(/^nothing written — --dry-run/);
  expect(dry.prompts).toEqual([]);
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(s.home, "mcp.json"))).toBe(false);
  const off = await run(s, ["install", "mcp:widgets", "--local", "--yes", "--offline"], { spawn: npm.spawn });
  expect(off.code).toBe(1);
  expect(off.err.at(-1)).toMatch(/^--offline: installing widgets-mcp@1\.2\.0 once means npm fetching it now; drop --local/);
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(s.home, "mcp.json"))).toBe(false);
  const boxed = await run(s, ["install", "mcp:boxed", "--local", "--yes"], { spawn: npm.spawn, tty: true });
  expect(boxed.code).toBe(1);
  expect(boxed.err.at(-1)).toMatch(/^boxed cannot be installed once: its launch line is not a plain `npx <package>` \(docker run -i --rm acme\/boxed\) — drop --local/);
});

test("update keeps how a server starts: an install-once server is reinstalled with npm and stays on node; an npx one stays on npx and asks nothing", async () => {
  const s = scratch();
  const npm = fakeNpm({ version: "1.2.0" });
  expect((await run(s, ["install", "mcp:widgets", "--local", "--yes"], { spawn: npm.spawn })).code).toBe(0);
  expect(npm.calls).toHaveLength(1);
  const up = await run(s, ["update", "mcp:widgets", "--yes"], { spawn: npm.spawn, tty: true });
  expect(up.code).toBe(0);
  expect(up.prompts).toEqual([]);
  expect(npm.calls).toHaveLength(2);                                                     // npm ran again: that is what an update of a package is
  const file = JSON.parse(readFileSync(join(s.home, "mcp.json"), "utf8")) as Written;
  expect(file.mcpServers.widgets!.command).toBe("node");
  // and the other way round: a server on npx is updated on npx, no offer, no npm
  const s2 = scratch();
  const npm2 = fakeNpm();
  expect((await run(s2, ["install", "mcp:widgets", "--yes"], { spawn: npm2.spawn })).code).toBe(0);
  const up2 = await run(s2, ["update", "mcp:widgets"], { spawn: npm2.spawn, tty: true, plain: ["y"] });
  expect(up2.code).toBe(0);
  expect(up2.prompts).toEqual(["update this? [y/N] "]);                                  // no install-once question on an update
  expect(npm2.calls).toHaveLength(0);
  expect((JSON.parse(readFileSync(join(s2.home, "mcp.json"), "utf8")) as Written).mcpServers.widgets!.command).toBe("npx");
});
