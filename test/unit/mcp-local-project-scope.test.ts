/** Install-once is USER scope only. The launch line it writes is this machine's absolute path under its
 *  ROVECODE_HOME (`node C:\Users\me\.rovecode\mcp\…\index.js`); a project mcp.json is shared with every clone of
 *  the repo, so that line would be a server nobody else can start. Pinned in all three faces: the offer is not
 *  made for --project, and an explicit --project --local is refused with the way out — before anything is asked,
 *  written or spawned. Found by reading the flow as a stranger before v0.3.0; not by a test that existed. */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMcp } from "../../src/cli/mcp-market-cmd.ts";
import { cmdMarket } from "../../src/cli/market-cmd.ts";
import { cmdMcp as tuiMcp } from "../../src/tui/mcp-cmd.ts";
import { planInstall } from "../../src/mcp/market-install.ts";
import type { MarketEntry } from "../../src/mcp/market.ts";
import type { PickItem, Renderer } from "../../src/tui/renderer.ts";
import { fakeNpm } from "../helpers/fake-npm.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const MEMORY: MarketEntry = { key: "memory", title: "Memory", description: "d", source: "curated", publisher: "acme",
  installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: [], pending: [] }] };
const REFUSAL = /install-once writes this machine's absolute path \(node <home>\/mcp\/…\), and a project file is shared with every clone — install it in user scope \(drop --project\) or keep the npx line$/;

test("planInstall: --local in project scope is an error naming the reason and the way out; the same entry in user scope plans fine", () => {
  const home = tmp("rovecode-scope-home-"), cwd = tmp("rovecode-scope-cwd-");
  const project = planInstall(MEMORY, { scope: "project", cwd, home, local: true });
  expect("error" in project && project.error).toMatch(REFUSAL);
  const user = planInstall(MEMORY, { scope: "user", cwd, home, local: true });
  expect("error" in user).toBe(false);
});

test("rovecode mcp add --project: no offer is asked on a terminal, the npx line is written; --project --local is refused before npm or the file", async () => {
  const home = tmp("rovecode-scope-home-"), cwd = tmp("rovecode-scope-cwd-");
  const npm = fakeNpm();
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const run = (args: string, plain: string[]) => { const a = [...plain]; return cmdMcp(args.split(" "), { cwd, home, tty: true, out: (l) => out.push(l), err: (l) => err.push(l), market: { offline: true, home }, spawn: npm.spawn,
    plain: async (p) => { prompts.push(p); return a.shift() ?? ""; }, secret: async () => "" }); };
  expect(await run("add memory --project", ["y"])).toBe(0);
  expect(prompts).toEqual(["install this? [y/N] "]);                  // straight to the plan's yes — no install-once question
  expect(out.some((l) => l.startsWith("  installs"))).toBe(false);
  const file = JSON.parse(require("node:fs").readFileSync(join(cwd, ".rovecode", "mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string }> };
  expect(file.mcpServers.memory!.command).toBe("npx");
  expect(npm.calls).toHaveLength(0);
  const before = out.length;
  expect(await run("add memory --project --local --yes --as mem2", [])).toBe(1);
  expect(err.at(-1)).toMatch(REFUSAL);
  expect(out.length).toBe(before);                                     // no plan was even shown
  expect(npm.calls).toHaveLength(0);
  expect((JSON.parse(require("node:fs").readFileSync(join(cwd, ".rovecode", "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.mem2).toBeUndefined();
});

test("rovecode market install --project: no offer on a terminal; --project --local is refused; user scope still gets both", async () => {
  const home = tmp("rovecode-scope-home-"), cwd = tmp("rovecode-scope-cwd-");
  writeFileSync(join(home, "skills.json"), JSON.stringify({ version: 1, items: [] }));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") }, mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [MEMORY], offline: true, home } };
  const npm = fakeNpm();
  const run = async (args: string, plain: string[]) => {
    const out: string[] = [], err: string[] = [], prompts: string[] = []; const a = [...plain];
    const code = await cmdMarket(args.split(" "), { cwd, home, registry, tty: true, out: (l) => out.push(l), err: (l) => err.push(l), run: { spawn: npm.spawn },
      plain: async (p) => { prompts.push(p); return a.shift() ?? ""; }, secret: async () => "", prereqEnv: { PATH: "", windows: false, exists: () => false } });
    return { code, out, err, prompts };
  };
  const proj = await run("install mcp:memory --project", ["y"]);
  expect(proj.code).toBe(0);
  expect(proj.prompts).toEqual(["install this? [y/N] "]);
  expect(proj.out.some((l) => l.startsWith("  installs"))).toBe(false);
  const refused = await run("install mcp:memory --project --local --yes --as mem2", []);
  expect(refused.code).toBe(1);
  expect(refused.err.at(-1)).toMatch(REFUSAL);
  expect(npm.calls).toHaveLength(0);
  expect(existsSync(join(home, "mcp"))).toBe(false);
  const user = await run("install mcp:memory", ["y", "y"]);
  expect(user.code).toBe(0);
  expect(user.prompts).toEqual(["install @modelcontextprotocol/server-memory once? [y/N] ", "install this? [y/N] "]);
  expect(npm.calls).toHaveLength(1);
});

test("tui /mcp --project: no how-to-start pick, the card is the npx plan", async () => {
  const home = tmp("rovecode-scope-home-"), cwd = tmp("rovecode-scope-cwd-");
  const pickCalls: string[] = [], approvals: string[] = [], notes: string[] = [];
  const picks = ["memory"];
  const renderer = {
    addSystemNote: (t: string) => { notes.push(t); },
    pickOne: async (_items: PickItem[], title?: string) => { pickCalls.push(title ?? ""); return picks.shift() ?? null; },
    askApproval: async (_tool: string, preview: string) => { approvals.push(preview); return "once" as const; },
  } as unknown as Renderer;
  await tuiMcp({ renderer, cwd, home, market: { offline: true }, spawn: fakeNpm().spawn }, "memory --project");
  expect(pickCalls).toEqual(["mcp market · memory"]);                 // no "Memory · how to start it"
  expect(approvals).toEqual(["memory ← npx -y @modelcontextprotocol/server-memory"]);
  expect(existsSync(join(cwd, ".rovecode", "mcp.json"))).toBe(true);
});
