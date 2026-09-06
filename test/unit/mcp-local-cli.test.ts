/** Install once through the two MCP-only faces — `rovecode mcp add` (cli/mcp-market-cmd.ts) and /mcp
 *  (tui/mcp-cmd.ts). What is pinned, because the market's approval ceremony is the thing at stake:
 *  the offer comes BEFORE the plan and the plan the human then reads is the one that runs; the offer can
 *  neither skip nor stand in for the approval; npm — a write to disk — runs only AFTER the yes; a deny or an
 *  Esc runs no npm and writes nothing; what landed is recorded with its integrity, and a hole in the record
 *  is said in words; `mcp list` offers install-once for npx rows and rewrites nothing. */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMcp } from "../../src/cli/mcp-market-cmd.ts";
import { cmdMcp as tuiMcp } from "../../src/tui/mcp-cmd.ts";
import type { PickItem, Renderer } from "../../src/tui/renderer.ts";
import type { Spawn } from "../../src/mcp/local-package.ts";
import { fakeNpm, FAKE_INTEGRITY } from "../helpers/fake-npm.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** the same registry fixture mcp-market-cmd.test.ts uses: an npx package with a required secret and a required argument */
const WIDGETS = {
  server: { name: "io.github.acme/widgets", title: "Widgets", description: "Widgets for agents.", version: "1.2.0", repository: { url: "https://github.com/acme/widgets", source: "github" },
    packages: [{ registryType: "npm", identifier: "widgets-mcp", version: "1.2.0", runtimeHint: "npx", transport: { type: "stdio" },
      packageArguments: [{ type: "named", name: "--root", isRequired: true }, { type: "named", name: "--mode", value: "fast" }],
      environmentVariables: [{ name: "WIDGET_TOKEN", isRequired: true, isSecret: true, description: "API token" }] }] },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
};
const fetchStub = ((input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/servers?")) return Promise.resolve(new Response(JSON.stringify({ servers: [WIDGETS], metadata: { count: 1 } })));
  if (url.includes("/versions/latest")) return Promise.resolve(new Response(JSON.stringify(WIDGETS)));
  return Promise.resolve(new Response("{}", { status: 404 }));
}) as unknown as typeof fetch;

function cli(cwd: string, home: string, spawn: Spawn, opts: { tty?: boolean; secret?: string; plain?: string[] } = {}) {
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const plain = [...(opts.plain ?? [])];
  const run = (args: string) => cmdMcp(args.split(" ").filter(Boolean), {
    cwd, home, out: (l) => out.push(l), err: (l) => err.push(l), tty: opts.tty ?? false, market: { fetch: fetchStub, home }, spawn,
    secret: async (p) => { prompts.push(`secret:${p}`); return opts.secret ?? ""; },
    plain: async (p) => { prompts.push(`plain:${p}`); return plain.shift() ?? ""; },
  });
  return { run, out, err, prompts };
}
function fakeRenderer(picks: (string | null)[], verdict: "once" | "deny") {
  const notes: string[] = [], pickCalls: { title?: string; items: PickItem[] }[] = [], approvals: { tool: string; preview: string; detail?: string }[] = [];
  const renderer = {
    addSystemNote: (t: string) => { notes.push(t); },
    pickOne: async (items: PickItem[], title?: string) => { pickCalls.push({ title, items }); return picks.shift() ?? null; },
    askApproval: async (tool: string, preview: string, detail?: string) => { approvals.push({ tool, preview, detail }); return verdict; },
  } as unknown as Renderer;
  return { renderer, notes, pickCalls, approvals };
}
type Written = { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
type Manifest = { installs: { kind?: string; id: string; installedBy: string; target?: string; package?: { name: string; version: string; prefix: string; bin: string; integrity?: string; resolved?: string; missing?: string[] } }[] };
const SEP = process.platform === "win32" ? "\\" : "/";

test("cli add --local --yes: the plan says node + npm + code lands; npm runs after it; the file gets `node <absolute bin>` + the server's args; installed.json records name/version/integrity by `mcp add`; list then offers nothing", async () => {
  const cwd = tmp("rovecode-mcpl-cwd-"), home = tmp("rovecode-mcpl-home-");
  const npm = fakeNpm({ version: "1.2.0" });
  const c = cli(cwd, home, npm.spawn, { tty: true, secret: "s3cret", plain: ["/srv/data"] });
  expect(await c.run("add io.github.acme/widgets --local --yes")).toBe(0);
  // --local answered the offer, --yes the approval; the pending value is still asked
  expect(c.prompts).toEqual(["secret:WIDGET_TOKEN (API token): ", "plain:--root <value>: "]);
  const prefix = join(home, "mcp");
  const bin = join(prefix, "node_modules", "widgets-mcp", "dist", "index.js");
  expect(c.out).toContain(`  runs       node ${join(prefix, "node_modules", "widgets-mcp")}${SEP}<its bin, read after the install> --mode fast`);
  expect(c.out).toContain(`  installs   npm install --prefix ${prefix} --save --no-fund --no-audit --loglevel=error widgets-mcp@1.2.0`);
  expect(c.out.some((l) => l.includes("rovecode runs a package manager for you here"))).toBe(true);
  expect(c.out.some((l) => l.includes("puts their CODE on this machine"))).toBe(true);
  expect(c.out.some((l) => l.startsWith("  records    package name, version and npm's integrity hash"))).toBe(true);
  // the plan was printed BEFORE npm ran: the install line is above the "added" line
  expect(c.out.findIndex((l) => l.startsWith("  installs"))).toBeLessThan(c.out.findIndex((l) => l.startsWith('added "widgets"')));
  expect(npm.calls).toHaveLength(1);
  expect(npm.calls[0]!.cmd.at(-1)).toBe("widgets-mcp@1.2.0");
  expect(c.out).toContain(`installed widgets-mcp 1.2.0 once → ${prefix}  (integrity recorded in installed.json)`);
  const file = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as Written;
  expect(file.mcpServers.widgets).toEqual({ command: "node", args: [bin, "--mode", "fast", "--root", "/srv/data"], env: { WIDGET_TOKEN: "s3cret" } });
  const manifest = JSON.parse(readFileSync(join(home, "installed.json"), "utf8")) as Manifest;
  expect(manifest.installs).toEqual([expect.objectContaining({ kind: "mcp", id: "io.github.acme/widgets", installedBy: "mcp add", target: join(home, "mcp.json"),
    package: { name: "widgets-mcp", version: "1.2.0", prefix, bin, integrity: FAKE_INTEGRITY, resolved: expect.stringContaining("registry.npmjs.org") } })]);
  expect(manifest.installs[0]!.package!.missing).toBeUndefined();   // nothing missing → no field, not an empty list
  // the row starts with node now, so `list` has no npx offer to make
  const lst = cli(cwd, home, npm.spawn);
  expect(await lst.run("list")).toBe(0);
  expect(lst.out).toHaveLength(1);
  expect(lst.out[0]).toMatch(/^user\s+widgets\s+stdio\s+node .*widgets-mcp.*index\.js --mode fast --root \/srv\/data  env WIDGET_TOKEN$/);
});

test("cli add: the offer can neither skip nor replace the approval — 'y' to install once then 'n' to the plan writes nothing and runs no npm; 'n' then 'y' is today's npx line and list offers install-once; --yes, no terminal and --no-local never ask", async () => {
  const cwd = tmp("rovecode-mcpl-cwd-"), home = tmp("rovecode-mcpl-home-");
  const npm = fakeNpm();
  // offer yes, approval NO: the approval is the gate, and npm is a write — it must not have run
  const swallow = cli(cwd, home, npm.spawn, { tty: true, secret: "s3cret", plain: ["y", "n"] });
  expect(await swallow.run("add io.github.acme/widgets")).toBe(1);
  expect(swallow.prompts).toEqual(["plain:install widgets-mcp@1.2.0 once? [y/N] ", "plain:install this? [y/N] "]);
  expect(swallow.out.some((l) => l.startsWith("  installs   npm install"))).toBe(true);   // the plan showed the install…
  expect(swallow.out.at(-1)).toBe("nothing written");                                       // …and the no stopped everything
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(home, "mcp.json"))).toBe(false);
  expect(existsSync(join(home, "mcp"))).toBe(false);                                        // not even the prefix folder
  // offer no, approval yes: exactly the pre-offer behaviour
  const asToday = cli(cwd, home, npm.spawn, { tty: true, secret: "s3cret", plain: ["n", "y", "/srv/data"] });
  expect(await asToday.run("add io.github.acme/widgets")).toBe(0);
  expect(npm.calls).toHaveLength(0);
  const file = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as Written;
  expect(file.mcpServers.widgets!.command).toBe("npx");
  expect(file.mcpServers.widgets!.args).toEqual(["-y", "widgets-mcp@1.2.0", "--mode", "fast", "--root", "/srv/data"]);
  expect(existsSync(join(home, "installed.json"))).toBe(false);                             // a config line records nothing, as before
  const lst = cli(cwd, home, npm.spawn);
  expect(await lst.run("list")).toBe(0);
  expect(lst.out).toHaveLength(2);
  expect(lst.out[1]).toMatch(/^1 server starts through npx.*widgets.*--local --force.*Nothing changes until you do\.$/);
  // no terminal: no offer question and no npm — a script gets the npx line, never an install it could not
  // approve. (It now exits 0: a required secret it cannot be asked for is written as ${NAME} and named,
  // the same on both CLI faces. What matters here is that the OFFER is silent and npm never ran.)
  const script = cli(cwd, tmp("rovecode-mcpl-home-"), npm.spawn, { tty: false });
  expect(await script.run("add io.github.acme/widgets --yes")).toBe(0);
  expect(script.prompts).toEqual([]);
  expect(npm.calls).toHaveLength(0);
  // --yes on a terminal: the approval is given, so the offer is not asked either — npx
  const yesTty = cli(cwd, tmp("rovecode-mcpl-home-"), npm.spawn, { tty: true, secret: "s", plain: ["/d"] });
  expect(await yesTty.run("add io.github.acme/widgets --yes")).toBe(0);
  expect(yesTty.prompts).toEqual(["secret:WIDGET_TOKEN (API token): ", "plain:--root <value>: "]);
  expect(npm.calls).toHaveLength(0);
  // --no-local on a terminal: straight to the plan and its yes
  const noLocal = cli(cwd, tmp("rovecode-mcpl-home-"), npm.spawn, { tty: true, secret: "s", plain: ["y", "/d"] });
  expect(await noLocal.run("add io.github.acme/widgets --no-local")).toBe(0);
  expect(noLocal.prompts[0]).toBe("plain:install this? [y/N] ");
  expect(npm.calls).toHaveLength(0);
});

test("cli add --local: npm failing writes nothing; an incomplete lockfile is recorded with `missing` and said on stderr; --local on a non-npx entry is refused", async () => {
  const cwd = tmp("rovecode-mcpl-cwd-"), home = tmp("rovecode-mcpl-home-");
  const failing = cli(cwd, home, fakeNpm({ fail: "npm ERR! 404 Not Found" }).spawn, { tty: true, secret: "s", plain: ["/d"] });
  expect(await failing.run("add io.github.acme/widgets --local --yes")).toBe(1);
  expect(failing.err.at(-1)).toMatch(/^npm install widgets-mcp@1\.2\.0 failed \(exit 1\): npm ERR! 404 Not Found/);
  expect(failing.out.at(-1)).toBe("nothing written");
  expect(existsSync(join(home, "mcp.json"))).toBe(false);
  const holes = cli(cwd, home, fakeNpm({ lock: "no-entry", version: "1.2.0" }).spawn, { tty: true, secret: "s", plain: ["/d"] });
  expect(await holes.run("add io.github.acme/widgets --local --yes")).toBe(0);
  expect(holes.out).toContain(`installed widgets-mcp 1.2.0 once → ${join(home, "mcp")}`);           // no "(integrity recorded" claim
  expect(holes.err).toContain(`record incomplete: integrity: ${join(home, "mcp", "package-lock.json")} has no entry for node_modules/widgets-mcp`);
  const manifest = JSON.parse(readFileSync(join(home, "installed.json"), "utf8")) as Manifest;
  expect(manifest.installs[0]!.package!.integrity).toBeUndefined();
  expect(manifest.installs[0]!.package!.missing).toEqual([`integrity: ${join(home, "mcp", "package-lock.json")} has no entry for node_modules/widgets-mcp`]);
  // github's second form is docker: not an npx package
  const notNpx = cli(cwd, home, fakeNpm().spawn, { tty: true });
  expect(await notNpx.run("add github --local --yes --pick 1")).toBe(1);
  expect(notNpx.err.at(-1)).toMatch(/^github cannot be installed once: its launch line is not a plain `npx <package>` \(docker run/);
});

test("tui /mcp install once: the pick comes before the card, the card says npm runs and code lands, a deny runs NO npm and writes nothing, Esc on the pick writes nothing, a yes installs, writes `node <bin>` and records", async () => {
  const cwd = tmp("rovecode-mcpl-cwd-"), home = tmp("rovecode-mcpl-home-");
  const npm = fakeNpm({ version: "2026.8.31" });
  // deny AFTER choosing install-once: the card is still the gate — npm has not run, no folder, no file
  const deny = fakeRenderer(["memory", "local"], "deny");
  await tuiMcp({ renderer: deny.renderer, cwd, home, market: { offline: true }, spawn: npm.spawn }, "memory");
  expect(deny.pickCalls.map((p) => p.title)).toEqual(["mcp market · memory", "Memory · how to start it"]);
  expect(deny.approvals).toHaveLength(1);
  expect(deny.approvals[0]!.preview).toBe("memory ← node @modelcontextprotocol/server-memory (installed once)");
  expect(deny.approvals[0]!.detail).toContain("  installs   npm install --prefix ");
  expect(deny.approvals[0]!.detail).toContain("rovecode runs a package manager for you here");
  expect(deny.approvals[0]!.detail).toContain("puts their CODE on this machine");
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(home, "mcp.json"))).toBe(false);
  expect(existsSync(join(home, "mcp"))).toBe(false);
  expect(deny.notes).toContain("mcp: nothing written");
  // Esc on the how-to-start pick: no card, nothing written, nothing run
  const esc = fakeRenderer(["memory", null], "once");
  await tuiMcp({ renderer: esc.renderer, cwd, home, market: { offline: true }, spawn: npm.spawn }, "memory");
  expect(esc.approvals).toEqual([]);
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(home, "mcp.json"))).toBe(false);
  // yes: npm ran once, AFTER the card; the file holds node + the absolute bin; the record is there
  const ok = fakeRenderer(["memory", "local"], "once");
  await tuiMcp({ renderer: ok.renderer, cwd, home, market: { offline: true }, spawn: npm.spawn }, "memory");
  expect(npm.calls).toHaveLength(1);
  const prefix = join(home, "mcp");
  const bin = join(prefix, "node_modules", "@modelcontextprotocol", "server-memory", "dist", "index.js");
  const file = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as Written;
  expect(file.mcpServers.memory).toEqual({ command: "node", args: [bin] });
  expect(ok.notes.some((n) => n.startsWith('mcp: added "memory"'))).toBe(true);
  expect(ok.notes).toContain(`mcp: installed @modelcontextprotocol/server-memory 2026.8.31 once → ${prefix} (integrity recorded in installed.json)`);
  const manifest = JSON.parse(readFileSync(join(home, "installed.json"), "utf8")) as Manifest;
  expect(manifest.installs).toEqual([expect.objectContaining({ id: "memory", installedBy: "mcp add",
    package: expect.objectContaining({ name: "@modelcontextprotocol/server-memory", version: "2026.8.31", bin, integrity: FAKE_INTEGRITY }) })]);
});
