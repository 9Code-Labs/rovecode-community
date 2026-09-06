/** The trust gate for PROJECT MCP files, through the real runtime (cli/runtime.ts bootRuntime) like
 *  plugins-runtime.test.ts. Pinned: (1) an unapproved .rovecode/mcp.json or .mcp.json contributes NOTHING —
 *  no manager, no mcp_* tool — and leaves exactly one `mcp:` warning per file naming it and the command;
 *  (2) the user file is never gated; (3) `mcp add --project` into a fresh file is trusted as approved and the
 *  NEXT runtime loads it with no warning, but adding into a file that already holds unapproved strangers does
 *  NOT bless them; (4) one changed byte flips a file back to untrusted; (5) `mcp trust` / `/mcp trust` are the
 *  manual path, `untrust` undoes. Network-free: http entries on 127.0.0.1:9 (connect fails, nothing spawns). */

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootRuntime } from "../../src/cli/runtime.ts";
import { cmdMcp } from "../../src/cli/mcp-market-cmd.ts";
import { cmdMcp as tuiMcp } from "../../src/tui/mcp-cmd.ts";
import { loadMcpConfig, untrustedNote } from "../../src/mcp/config.ts";
import { mcpTrustStatus, trustedPredicate, trustMcpFile } from "../../src/mcp/trust.ts";
import { loadState } from "../../src/plugins/state.ts";
import type { MarketEntry } from "../../src/mcp/market.ts";
import type { Renderer } from "../../src/tui/renderer.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = prev; }
}
const LOCAL: MarketEntry[] = [
  { key: "local", title: "Local", description: "a test server", source: "curated", publisher: "test", installs: [{ kind: "http", url: "http://127.0.0.1:9/local", headers: [] }] },
  { key: "second", title: "Second", description: "another", source: "curated", publisher: "test", installs: [{ kind: "http", url: "http://127.0.0.1:9/second", headers: [] }] },
];
const cli = (cwd: string, home: string) => {
  const out: string[] = [], err: string[] = [];
  const run = (args: string) => cmdMcp(args.split(" ").filter(Boolean), { cwd, home, out: (l) => out.push(l), err: (l) => err.push(l), tty: false, market: { offline: true, catalog: LOCAL, home } });
  return { run, out, err };
};
const mcpWarnings = (rt: { plugins: { warnings: readonly string[] } }) => rt.plugins.warnings.filter((w) => w.startsWith("mcp: "));

test("gate through bootRuntime: unapproved project files contribute nothing and warn once each; the user file is never gated; `add --project` on a fresh file is trusted as approved and loads next time, but does not bless strangers already in a file; one byte flips it back; trust/untrust round-trip", async () => {
  const cwd = tmp("rovecode-trust-cwd-"), home = tmp("rovecode-trust-home-");
  const project = join(cwd, ".rovecode", "mcp.json"), harvest = join(cwd, ".mcp.json");
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(project, JSON.stringify({ mcpServers: { evil: { url: "http://127.0.0.1:9/evil" } } }));
  writeFileSync(harvest, JSON.stringify({ mcpServers: { harvested: { command: "never-run-me" } } }));
  await withHome(home, async () => {
    // (1) nothing of theirs: no manager, no mcp tools, one warning per file with the exact command
    const rt = await bootRuntime({ cwd, stream: null });
    try {
      expect(rt.mcp).toBeNull();
      expect(rt.registry.list().map((t) => t.schema.name)).not.toContain("mcp_list");
      expect(mcpWarnings(rt)).toEqual([`mcp: ${untrustedNote(harvest, 1)}`, `mcp: ${untrustedNote(project, 1)}`]);
      expect(mcpWarnings(rt)[0]).toContain("rovecode mcp trust");
    } finally { await rt.hooks.close(); }
    // (2) the user file loads with no gate while the project ones stay off
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { mine: { url: "http://127.0.0.1:9/mine" } } }));
    const rt2 = await bootRuntime({ cwd, stream: null });
    try {
      expect(rt2.mcp!.serverNames()).toEqual(["mine"]);
      expect(mcpWarnings(rt2).length).toBe(2);
    } finally { await rt2.mcp?.close().catch(() => {}); await rt2.hooks.close(); }
    // (3a) adding into the file that already holds "evil" (unapproved) writes the entry but trusts nothing
    const h = cli(cwd, home);
    expect(await h.run("add local --project --yes")).toBe(0);
    expect(h.out.at(-2)).toMatch(/^NOT trusted yet: that file already held servers you have not approved/);
    expect(mcpTrustStatus(home, project)).toBe("untrusted");
    expect(Object.keys((JSON.parse(readFileSync(project, "utf8")) as { mcpServers: object }).mcpServers)).toEqual(["evil", "local"]);
    const rt3 = await bootRuntime({ cwd, stream: null });
    try { expect(rt3.mcp!.serverNames()).toEqual(["mine"]); } finally { await rt3.mcp?.close().catch(() => {}); await rt3.hooks.close(); }
    // (3b) a fresh checkout: `add --project` is the human's own approval → trusted as written, loads next time, no warning
    const cwd2 = tmp("rovecode-trust-cwd2-");
    const h2 = cli(cwd2, home);
    expect(await h2.run("add local --project --yes")).toBe(0);
    expect(h2.out).toContain(`added "local" → ${join(cwd2, ".rovecode", "mcp.json")}  (trusted on this machine as written)`);
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("trusted");
    const rt4 = await bootRuntime({ cwd: cwd2, stream: null });
    try {
      expect(rt4.mcp!.serverNames().sort()).toEqual(["local", "mine"]);
      expect(mcpWarnings(rt4)).toEqual([]);
    } finally { await rt4.mcp?.close().catch(() => {}); await rt4.hooks.close(); }
    // a second add into the now-trusted file stays trusted; a remove too
    expect(await h2.run("add second --project --yes")).toBe(0);
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("trusted");
    expect(await h2.run("remove second --project")).toBe(0);
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("trusted");
    // (4) one byte by hand → untrusted again, the warning is back
    appendFileSync(join(cwd2, ".rovecode", "mcp.json"), " ");
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("untrusted");
    const rt5 = await bootRuntime({ cwd: cwd2, stream: null });
    try {
      expect(rt5.mcp!.serverNames()).toEqual(["mine"]);
      expect(mcpWarnings(rt5)).toEqual([`mcp: ${untrustedNote(join(cwd2, ".rovecode", "mcp.json"), 1)}`]);
    } finally { await rt5.mcp?.close().catch(() => {}); await rt5.hooks.close(); }
    // (5) the manual path: show lists the file with its trust and its servers (names only); trust needs a yes; untrust undoes
    h2.out.length = 0;
    expect(await h2.run("show --project")).toBe(0);
    expect(h2.out[0]).toBe(`${join(cwd2, ".rovecode", "mcp.json")}  — NOT trusted: nothing in it loads until \`rovecode mcp trust\``);
    expect(h2.out[1]).toMatch(/^  local\s+http\s+http:\/\/127\.0\.0\.1:9\/local$/);
    expect(await h2.run("trust")).toBe(1); // no TTY, no --yes
    expect(h2.err.at(-1)).toMatch(/nothing trusted: no terminal to confirm on/);
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("untrusted");
    expect(await h2.run("trust --yes")).toBe(0);
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("trusted");
    // the store is the plugin store, keyed by the file's path: one "trust this project" decision
    const key = join(cwd2, ".rovecode", "mcp.json").replace(/\\/g, "/");
    expect(loadState(home).trusted[key]).toMatch(/^[0-9a-f]{64}$/);
    expect(await h2.run("untrust")).toBe(0);
    expect(mcpTrustStatus(home, join(cwd2, ".rovecode", "mcp.json"))).toBe("untrusted");
    expect(await h2.run("list")).toBe(0);
    expect(h2.out.at(-1)).toMatch(/^project\s+local\s+http\s+http:\/\/127\.0\.0\.1:9\/local  \(file not trusted — off; rovecode mcp trust\)$/);
  });
});

test("loadMcpConfig alone: no predicate → project files load as before; a false predicate → nothing from them + the one note; trustMcpFile records the current bytes and the predicate flips with any change", () => {
  const cwd = tmp("rovecode-trust-cwd-"), home = tmp("rovecode-trust-home-");
  const project = join(cwd, ".rovecode", "mcp.json");
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(project, JSON.stringify({ mcpServers: { a: { url: "http://127.0.0.1:9/a" }, b: { url: "http://127.0.0.1:9/b" } } }));
  expect(loadMcpConfig(cwd).map((c) => c.name)).toEqual(["a", "b"]); // existing callers see no change
  const w: string[] = [];
  expect(loadMcpConfig(cwd, w, { trusted: () => false })).toEqual([]);
  expect(w).toEqual([untrustedNote(project, 2)]);
  expect(w[0]).toContain("its 2 MCP servers stay off");
  const r = trustMcpFile(home, project);
  expect(r.ok).toBe(true);
  const pred = trustedPredicate(loadState(home));
  expect(loadMcpConfig(cwd, [], { trusted: pred }).map((c) => c.name)).toEqual(["a", "b"]);
  appendFileSync(project, "\n");
  expect(loadMcpConfig(cwd, [], { trusted: pred })).toEqual([]);
  expect(trustMcpFile(home, join(cwd, "nope.json"))).toEqual({ ok: false, reason: `${join(cwd, "nope.json")}: no such file` });
});

test("/mcp trust in the TUI: one approval card per project file — the file as preview, its servers as detail (names only) — a yes trusts, a deny leaves it off", async () => {
  const cwd = tmp("rovecode-trust-cwd-"), home = tmp("rovecode-trust-home-");
  const project = join(cwd, ".rovecode", "mcp.json");
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(project, JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["-y", "x"], env: { TOKEN: "hunter2" } } } }));
  const make = (verdict: "once" | "deny") => {
    const notes: string[] = [], approvals: { tool: string; preview: string; detail?: string }[] = [];
    const renderer = { addSystemNote: (t: string) => { notes.push(t); }, askApproval: async (tool: string, preview: string, detail?: string) => { approvals.push({ tool, preview, detail }); return verdict; } } as unknown as Renderer;
    return { renderer, notes, approvals };
  };
  const no = make("deny");
  await tuiMcp({ renderer: no.renderer, cwd, home, market: { offline: true } }, "trust");
  expect(no.approvals).toEqual([{ tool: "mcp trust", preview: project, detail: expect.stringMatching(/^srv\s+stdio\s+npx -y x  env TOKEN$/) }]);
  expect(no.approvals[0]!.detail).not.toContain("hunter2");
  expect(mcpTrustStatus(home, project)).toBe("untrusted");
  expect(no.notes).toEqual([`mcp: ${project} stays untrusted — nothing in it loads`]);
  const yes = make("once");
  await tuiMcp({ renderer: yes.renderer, cwd, home, market: { offline: true } }, "trust");
  expect(mcpTrustStatus(home, project)).toBe("trusted");
  expect(yes.notes[0]).toBe(`mcp: trusted ${project} — restart me to connect; an edit asks again`);
  const again = make("once");
  await tuiMcp({ renderer: again.renderer, cwd, home, market: { offline: true } }, "trust");
  expect(again.approvals).toEqual([]);
  expect(again.notes).toEqual([`mcp: ${project} is already trusted as it is now`]);
});
