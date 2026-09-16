/** `rovecode mcp list` shows what the files SAY, placeholders included and marked; the loader still refuses.
 *
 *  Found by trying to falsify the install flow on a clean checkout (2026-09-06): `market install mcp:filesystem
 *  --yes` off a terminal wrote `<directory the server may touch>` into args as designed, the loader refused the
 *  server by name as designed — and `mcp list`, the command docs/mcp-market.md points at for "every configured
 *  server", answered `no MCP servers configured`. configuredServers() parsed with the loader's rule and threw
 *  the warning away, so the entry a person had just been told to go and edit had no visible existence. */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMcp } from "../../src/cli/mcp-market-cmd.ts";
import { configuredServers, serverLine } from "../../src/mcp/market-install.ts";
import { loadMcpConfig, placeholderHoles } from "../../src/mcp/config.ts";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const HOLE = "<directory the server may touch>";

function seeded() {
  const cwd = tmp("rovecode-mcplist-cwd-"), home = tmp("rovecode-mcplist-home-");
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", HOLE] },
    memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  } }));
  return { cwd, home };
}

test("configuredServers keeps the placeholder entry and hands back the parse warnings it used to discard", () => {
  const { cwd, home } = seeded();
  mkdirSync(join(cwd, ".rovecode"));
  writeFileSync(join(cwd, ".rovecode", "mcp.json"), "{ this is not json");
  const warnings: string[] = [];
  const rows = configuredServers(cwd, home, warnings);
  expect(rows.map((r) => r.server.name).sort()).toEqual(["filesystem", "memory"]);
  expect(placeholderHoles(rows.find((r) => r.server.name === "filesystem")!.server)).toEqual([HOLE]);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("invalid JSON");
  // the loader's view is unchanged: the same entry is refused, by name, with the hole spelled out
  const loaderWarnings: string[] = [];
  expect(loadMcpConfig(cwd, loaderWarnings, { home }).map((c) => c.name)).toEqual(["memory"]);
  expect(loaderWarnings.some((w) => w.includes('server "filesystem" still has') && w.includes(HOLE))).toBe(true);
});

test("serverLine marks the entry; a launchable one gets no mark", () => {
  const { cwd, home } = seeded();
  const rows = configuredServers(cwd, home);
  const fs = serverLine(rows.find((r) => r.server.name === "filesystem")!.server);
  expect(fs).toContain(`  (fill in ${HOLE})`);
  expect(serverLine(rows.find((r) => r.server.name === "memory")!.server)).not.toContain("fill in");
});

test("`mcp list` prints the placeholder entry marked, and the parse warnings on stderr — never 'no MCP servers configured'", async () => {
  const { cwd, home } = seeded();
  mkdirSync(join(cwd, ".rovecode"));
  writeFileSync(join(cwd, ".rovecode", "mcp.json"), "[1, 2");
  const out: string[] = [], err: string[] = [];
  expect(await cmdMcp(["list"], { cwd, home, out: (l) => out.push(l), err: (l) => err.push(l), tty: false })).toBe(0);
  const text = out.join("\n");
  expect(text).not.toContain("no MCP servers configured");
  expect(text).toMatch(new RegExp(`^user\\s+filesystem\\s+stdio\\s+npx -y @modelcontextprotocol/server-filesystem ${HOLE.replace(/[<>]/g, "\\$&")}  \\(fill in ${HOLE.replace(/[<>]/g, "\\$&")}\\)$`, "m"));
  expect(text).toMatch(/^user\s+memory\s+stdio\s+npx -y @modelcontextprotocol\/server-memory$/m);
  expect(err.length).toBe(1);
  expect(err[0]).toContain("invalid JSON");
});
