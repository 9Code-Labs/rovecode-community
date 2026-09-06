/** `rovecode market install mcp:<id>` closes the way `rovecode mcp add` does when a placeholder stayed in the
 *  file: it names the hole and does NOT say "restart rovecode" (a restart changes nothing for an entry the
 *  loader skips). When the prompt was answered, the restart line is back and no placeholder is named. The --json
 *  document carries the same fact as `fillIn`. */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket } from "../../src/cli/market-cmd.ts";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const HOLE = "<directory the server may touch>";
const HOLEY = { key: "holey", title: "Holey", description: "A server that needs a directory.", source: "curated" as const, publisher: "test",
  installs: [{ kind: "stdio" as const, runtime: "npx" as const, command: "npx", args: ["-y", "holey-mcp"], env: [], pending: [HOLE] }] };

function scratch() {
  const cwd = tmp("rovecode-fillin-cwd-"), home = tmp("rovecode-fillin-home-");
  writeFileSync(join(home, "skills.json"), JSON.stringify({ version: 1, items: [] }));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [HOLEY], offline: true, home } };
  return { cwd, home, registry };
}

async function install(s: ReturnType<typeof scratch>, args: string[], tty: boolean, answer?: string) {
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const code = await cmdMarket(["install", "mcp:holey", "--yes", ...args], {
    cwd: s.cwd, home: s.home, registry: s.registry, tty,
    out: (l) => out.push(l), err: (l) => err.push(l),
    plain: async (p) => { prompts.push(p); return answer ?? ""; },
    secret: async (p) => { prompts.push(`SECRET:${p}`); return ""; },
  });
  const raw = JSON.parse(readFileSync(join(s.home, "mcp.json"), "utf8")) as { mcpServers: Record<string, { args: string[] }> };
  return { code, out: out.join("\n"), err: err.join("\n"), prompts, args: raw.mcpServers.holey!.args };
}

test("off a terminal the placeholder stays: the closing line names it and there is no 'restart' to chase", async () => {
  const s = scratch();
  const r = await install(s, [], false);
  expect(r.code).toBe(0);
  expect(r.prompts).toEqual([]);
  expect(r.args).toEqual(["-y", "holey-mcp", HOLE]);
  expect(r.out).toContain(`fill in before use: ${HOLE} — edit the args in ${join(s.home, "mcp.json")}; until then this server is skipped`);
  expect(r.out).not.toContain("restart");
});

test("on a terminal the directory is asked for under the placeholder's own text; answered, the file holds it and the closing line is the restart", async () => {
  const s = scratch();
  const r = await install(s, [], true, "D:/shared");
  expect(r.code).toBe(0);
  expect(r.prompts).toEqual([`${HOLE}: `]);
  expect(r.args).toEqual(["-y", "holey-mcp", "D:/shared"]);
  expect(r.out).not.toContain("fill in before use");
  expect(r.out).toContain("restart rovecode to connect");
});

test("--json: the document carries `fillIn` when a placeholder stayed, and lacks it when the prompt was answered", async () => {
  const s = scratch();
  const hole = await install(s, ["--json"], false);
  const doc = JSON.parse(hole.out) as { ok: boolean; fillIn?: string[]; next: string };
  expect(doc.ok).toBe(true);
  expect(doc.fillIn).toEqual([HOLE]);
  expect(doc.next).toContain("fill in before use");
  const filled = await install(s, ["--json", "--force"], true, "D:/shared");
  const doc2 = JSON.parse(filled.out) as { ok: boolean; fillIn?: string[]; next: string };
  expect(doc2.ok).toBe(true);
  expect("fillIn" in doc2).toBe(false);
  expect(doc2.next).toContain("restart rovecode to connect");
});
