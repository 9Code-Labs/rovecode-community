/** Install-once for npx MCP servers (src/mcp/local-package.ts). What is pinned: which launch lines are offered
 *  (a plain `npx [flags] <package> [args]` and nothing else); that the install runs npm into the shared prefix
 *  and reads back version, bin and the lockfile's integrity; that every way the record can fall short is
 *  written into `missing` in words; that the launch line is `node` + an ABSOLUTE bin path as ONE argv entry —
 *  proven against a real node under a directory with a space in its name, through the real McpManager. */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installLocalPackage, launchesViaNpx, localLaunch, localPrefix, npmInstallArgv, npxOfferLine, npxPackage, plannedLaunchLabel, readLocalPackage } from "../../src/mcp/local-package.ts";
import { McpManager } from "../../src/mcp/client.ts";
import type { MarketInstall } from "../../src/mcp/market.ts";
import { fakeNpm, FAKE_INTEGRITY } from "../helpers/fake-npm.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const npx = (...args: string[]): MarketInstall => ({ kind: "stdio", runtime: "npx", command: "npx", args, env: [], pending: [] });

describe("npxPackage: which launch lines get the offer", () => {
  test("a scoped package with a server argument", () => {
    expect(npxPackage(npx("-y", "@modelcontextprotocol/server-filesystem", "C:/Users/some one/repo")))
      .toEqual({ name: "@modelcontextprotocol/server-filesystem", spec: "@modelcontextprotocol/server-filesystem", rest: ["C:/Users/some one/repo"] });
  });
  test("a pinned version is kept in the spec and read out", () => {
    expect(npxPackage(npx("-y", "widgets-mcp@1.2.0", "--mode", "fast"))).toEqual({ name: "widgets-mcp", spec: "widgets-mcp@1.2.0", version: "1.2.0", rest: ["--mode", "fast"] });
  });
  test("no -y at all is still a package launch", () => {
    expect(npxPackage(npx("some-server"))?.name).toBe("some-server");
  });
  test("not offered: uvx, docker, http, a flag that takes a value, a git URL, a tarball, a path", () => {
    expect(npxPackage({ kind: "stdio", runtime: "uvx", command: "uvx", args: ["mcp-server-fetch"], env: [], pending: [] })).toBeUndefined();
    expect(npxPackage({ kind: "stdio", runtime: "docker", command: "docker", args: ["run", "x"], env: [], pending: [] })).toBeUndefined();
    expect(npxPackage({ kind: "http", url: "https://x/mcp", headers: [] })).toBeUndefined();
    expect(npxPackage(npx("-y", "-p", "tool", "cmd"))).toBeUndefined();       // -p takes a value: not our shape
    expect(npxPackage(npx("-y", "github:acme/widgets"))).toBeUndefined();
    expect(npxPackage(npx("-y", "https://example.com/w.tgz"))).toBeUndefined();
    expect(npxPackage(npx("-y", "./local/dir"))).toBeUndefined();
    expect(npxPackage(npx("-y"))).toBeUndefined();
  });
});

describe("installLocalPackage: npm into the shared prefix, then read back what landed", () => {
  test("the argv, the prefix's own package.json, and a complete record (version, absolute bin, integrity, nothing missing)", async () => {
    const home = tmp("rovecode-local-home-");
    const prefix = localPrefix(home);
    expect(prefix).toBe(join(home, "mcp"));
    const npm = fakeNpm({ version: "2026.8.31" });
    const pkg = npxPackage(npx("-y", "@modelcontextprotocol/server-memory"))!;
    const r = await installLocalPackage(pkg, prefix, { spawn: npm.spawn });
    expect(npm.calls).toHaveLength(1);
    expect(npm.calls[0]!.cmd).toEqual(["npm", "install", "--prefix", prefix, "--save", "--no-fund", "--no-audit", "--loglevel=error", "@modelcontextprotocol/server-memory"]);
    expect(npm.calls[0]!.cwd).toBe(prefix);
    expect(npm.calls[0]!.cmd).toEqual(npmInstallArgv(pkg, prefix)); // the plan shows exactly what runs
    // the prefix is a project of its own, so npm cannot wander up to a package.json above ~/.rovecode
    const own = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8")) as { name: string; private: boolean };
    expect(own).toMatchObject({ name: "rovecode-mcp-servers", private: true });
    if (!r.ok) throw new Error(r.error);
    expect(r.pkg).toEqual({
      name: "@modelcontextprotocol/server-memory", version: "2026.8.31",
      bin: join(prefix, "node_modules", "@modelcontextprotocol", "server-memory", "dist", "index.js"),
      integrity: FAKE_INTEGRITY, resolved: expect.stringContaining("registry.npmjs.org"), missing: [],
    });
    expect(existsSync(r.pkg.bin)).toBe(true);
    // a second read without npm sees the same thing — what `update` and a later audit rely on
    expect(readLocalPackage(pkg.name, prefix)).toEqual({ ok: true, pkg: r.pkg });
  });

  test("a lockfile without the entry: integrity absent AND `missing` says which file lacks what", async () => {
    const prefix = localPrefix(tmp("rovecode-local-home-"));
    const r = await installLocalPackage(npxPackage(npx("-y", "widgets-mcp@1.2.0"))!, prefix, { spawn: fakeNpm({ lock: "no-entry", version: "1.2.0" }).spawn });
    if (!r.ok) throw new Error(r.error);
    expect(r.pkg.integrity).toBeUndefined();
    expect(r.pkg.missing).toEqual([`integrity: ${join(prefix, "package-lock.json")} has no entry for node_modules/widgets-mcp`]);
  });

  test("no lockfile at all: `missing` says npm did not write one", async () => {
    const prefix = localPrefix(tmp("rovecode-local-home-"));
    const r = await installLocalPackage(npxPackage(npx("-y", "widgets-mcp"))!, prefix, { spawn: fakeNpm({ lock: "none" }).spawn });
    if (!r.ok) throw new Error(r.error);
    expect(r.pkg.missing).toEqual([`integrity: ${join(prefix, "package-lock.json")} was not written by npm`]);
  });

  test("npm failing is an error with npm's words, not a throw and not a half-record", async () => {
    const prefix = localPrefix(tmp("rovecode-local-home-"));
    const r = await installLocalPackage(npxPackage(npx("-y", "nope-mcp"))!, prefix, { spawn: fakeNpm({ fail: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope-mcp" }).spawn });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/^npm install nope-mcp failed \(exit 1\): npm ERR! 404 Not Found/) });
  });

  test("a package without a bin is refused — there is nothing for node to run", async () => {
    const prefix = localPrefix(tmp("rovecode-local-home-"));
    const r = await installLocalPackage(npxPackage(npx("-y", "lib-only"))!, prefix, { spawn: fakeNpm({ noBin: true }).spawn });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("lib-only declares no bin") });
  });

  test("a spawn that throws (no npm on PATH) is an error, not a crash", async () => {
    const prefix = localPrefix(tmp("rovecode-local-home-"));
    const r = await installLocalPackage(npxPackage(npx("-y", "x-mcp"))!, prefix, { spawn: async () => { throw new Error("spawn npm ENOENT"); } });
    expect(r).toEqual({ ok: false, error: "npm install x-mcp could not run: spawn npm ENOENT" });
  });
});

describe("the launch line", () => {
  test("node + the ABSOLUTE bin as one argv entry, the server's own args after it — a space in the path stays inside one argument", async () => {
    const home = join(tmp("rovecode-local-home-"), "Some One");   // a home directory with a space, like a Windows user name
    mkdirSync(home, { recursive: true });
    const prefix = localPrefix(home);
    const r = await installLocalPackage(npxPackage(npx("-y", "@modelcontextprotocol/server-filesystem", "C:/my repo"))!, prefix, { spawn: fakeNpm().spawn });
    if (!r.ok) throw new Error(r.error);
    const line = localLaunch(r.pkg, ["C:/my repo"]);
    expect(line.command).toBe("node");
    expect(line.args).toHaveLength(2);
    expect(line.args[0]).toBe(join(home, "mcp", "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js"));
    expect(line.args[0]).toContain("Some One");                  // the space is in there…
    expect(line.args[0]!.startsWith('"')).toBe(false);            // …and nothing tried to quote it: argv, not a shell string
    expect(line.args[1]).toBe("C:/my repo");
    // the plan's version of the same line, before the bin is known
    expect(plannedLaunchLabel(npxPackage(npx("-y", "@modelcontextprotocol/server-filesystem", "C:/my repo"))!, prefix))
      .toMatch(/^node .*Some One.*server-filesystem[\\/]<its bin, read after the install> C:\/my repo$/);
  });

  test("REAL node, REAL McpManager: a stdio server whose path has a space in it connects and lists its tool", async () => {
    // the smallest MCP server there is, written under "<tmp>/with space/", importing the SDK from this repo
    const root = tmp("rovecode-local-space-");
    const dir = join(root, "with space", "node_modules", "tiny-mcp", "dist");
    mkdirSync(dir, { recursive: true });
    const sdk = (p: string): string => pathToFileURL(join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", p)).href;
    writeFileSync(join(dir, "index.mjs"), [
      `import { McpServer } from ${JSON.stringify(sdk("mcp.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(sdk("stdio.js"))};`,
      `const server = new McpServer({ name: "tiny", version: "0.0.1" });`,
      `server.registerTool("ping", { description: "answers pong; argv[2] is " + (process.argv[2] ?? "(none)") }, async () => ({ content: [{ type: "text", text: "pong " + (process.argv[2] ?? "") }] }));`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n"));
    const bin = join(dir, "index.mjs");
    expect(bin).toContain("with space");
    const launch = localLaunch({ name: "tiny-mcp", version: "0.0.1", bin, missing: [] }, ["C:/also spaced arg"]);
    const m = new McpManager([{ name: "tiny", transport: "stdio", command: launch.command, args: launch.args }], { connectTimeoutMs: 15_000 });
    const res = await m.connect();
    expect(res.failed).toEqual([]);                                // mutation: quote the path → node cannot find the file → failed
    expect(res.connected).toEqual(["tiny"]);
    const tools = await m.listTools();
    expect(tools.map((t) => `${t.server}/${t.name}`)).toEqual(["tiny/ping"]);
    expect(tools[0]!.description).toContain("argv[2] is C:/also spaced arg");   // the second argument arrived whole too
    const call = await m.callTool("tiny", "ping", {});
    expect(call).toEqual({ ok: true, output: "pong C:/also spaced arg" });
    await m.close();
  }, 30_000);
});

describe("the offer under `mcp list`", () => {
  test("only enabled stdio rows launched by npx count; the line names them, the cost, the command, and that nothing changes by itself", () => {
    expect(launchesViaNpx({ name: "a", transport: "stdio", command: "npx", args: ["-y", "x"] })).toBe(true);
    expect(launchesViaNpx({ name: "b", transport: "stdio", command: "node", args: ["/x/dist/index.js"] })).toBe(false);
    expect(launchesViaNpx({ name: "c", transport: "stdio", command: "npx", args: ["-y", "x"], enabled: false })).toBe(false);
    expect(launchesViaNpx({ name: "d", transport: "http", url: "https://x" })).toBe(false);
    expect(npxOfferLine([])).toBeUndefined();
    const one = npxOfferLine(["memory"])!;
    expect(one).toMatch(/^1 server starts through npx/);
    expect(one).toContain("memory");
    expect(one).toContain("rovecode mcp add <catalog name> --local --force");   // the name `mcp add` takes, not the row's server name
    expect(one).toContain("add `--as <server name>` if you renamed it");
    expect(one).toContain("Nothing changes until you do.");
    expect(npxOfferLine(["memory", "filesystem"])).toMatch(/^2 servers start through npx.*memory, filesystem/);
  });
});
