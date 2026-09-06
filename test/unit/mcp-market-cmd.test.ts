/** The two faces of the MCP market: `rovecode mcp …` (cli/mcp-market-cmd.ts) and /mcp (tui/mcp-cmd.ts),
 *  driven with injected fetch, prompts and a fake Renderer — no process, no network, no terminal. What is
 *  pinned: nothing is written without a yes (no TTY + no --yes → nothing; "n" → nothing; a denied card →
 *  nothing); the plan the human sees names the exact command/URL, source and publisher; a secret is asked
 *  masked by NAME, never echoed to stdout, a value only in the user file and `${NAME}` in a project file;
 *  the TUI never asks and writes `${NAME}` with a note saying which names to set. */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMcp } from "../../src/cli/mcp-market-cmd.ts";
import { cmdMcp as tuiMcp } from "../../src/tui/mcp-cmd.ts";
import type { PickItem, Renderer } from "../../src/tui/renderer.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

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

function cli(cwd: string, home: string, opts: { tty?: boolean; secret?: string; plain?: string[] } = {}) {
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const plain = [...(opts.plain ?? [])];
  const run = (args: string) => cmdMcp(args.split(" ").filter(Boolean), {
    cwd, home, out: (l) => out.push(l), err: (l) => err.push(l), tty: opts.tty ?? false, market: { fetch: fetchStub, home },
    secret: async (p) => { prompts.push(`secret:${p}`); return opts.secret ?? ""; },
    plain: async (p) => { prompts.push(`plain:${p}`); return plain.shift() ?? ""; },
  });
  return { run, out, err, prompts };
}

test("cli: search lists curated then registry rows; info names publisher, the exact launch line and the secret by name; without a TTY nothing is written unless --yes AND every required secret can come from the environment", async () => {
  const cwd = tmp("rovecode-mcpc-cwd-"), home = tmp("rovecode-mcpc-home-");
  const h = cli(cwd, home);
  expect(await h.run("search github")).toBe(0);
  expect(h.out[0]).toMatch(/^github\s+curated\s+GitHub/);
  expect(await h.run("search widgets")).toBe(0);
  expect(h.out.some((l) => /^io\.github\.acme\/widgets\s+registry\s+Widgets 1\.2\.0 — Widgets for agents\./.test(l))).toBe(true);
  h.out.length = 0;
  expect(await h.run("info io.github.acme/widgets")).toBe(0);
  expect(h.out).toContain("  publisher  github.com/acme");
  expect(h.out).toContain("  install 0  runs     npx -y widgets-mcp@1.2.0 --mode fast");
  expect(h.out).toContain("             env WIDGET_TOKEN (secret) — API token");
  expect(h.out).toContain("             needs --root <value>");
  // no TTY, no --yes: the plan is shown, nothing is written
  h.out.length = 0;
  expect(await h.run("add io.github.acme/widgets")).toBe(1);
  expect(h.out).toContain("  runs       npx -y widgets-mcp@1.2.0 --mode fast");
  expect(h.err.at(-1)).toMatch(/nothing written: no terminal to confirm on/);
  expect(existsSync(join(home, "mcp.json"))).toBe(false);
  // --yes without a TTY and a required secret for the USER file: the entry is WRITTEN with `${NAME}` and
  // the name is said out loud. This face used to refuse (exit 1) while `rovecode market install` wrote it,
  // and one feature behaving differently through its two doors is worse than either behaviour. Unified on
  // the one that matches everything else here: write it, name it, and let the loader refuse to launch a
  // server whose variable is unset — the same rule as an unfilled <placeholder>.
  expect(await h.run("add io.github.acme/widgets --yes --as fromscript")).toBe(0);
  expect(h.err.join("\n")).toMatch(/WIDGET_TOKEN is not set — it will be written as \$\{WIDGET_TOKEN\}/);
  const scripted = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
  expect(scripted.mcpServers.fromscript!.env).toEqual({ WIDGET_TOKEN: "${WIDGET_TOKEN}" });
  expect(h.out).toContain("set WIDGET_TOKEN in your environment — the file only names them");
  // --yes without a TTY for a PROJECT file: the secret is a ${NAME} reference anyway → written
  expect(await h.run("add io.github.acme/widgets --yes --project --as wid")).toBe(0);
  const proj = JSON.parse(readFileSync(join(cwd, ".rovecode", "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  expect(proj.mcpServers.wid).toEqual({ command: "npx", args: ["-y", "widgets-mcp@1.2.0", "--mode", "fast", "--root", "<value>"], env: { WIDGET_TOKEN: "${WIDGET_TOKEN}" } });
  expect(h.out).toContain("set WIDGET_TOKEN in your environment — the file only names them");
  expect(h.out).toContain("fill in before use: --root <value> — edit the args in that file; until then this server is skipped");
  expect(h.prompts).toEqual([]); // no terminal: nothing was asked
  // usage errors are exit 2, one line: an unknown subcommand, no subcommand, a missing name, a flag the subcommand does not take
  expect(await h.run("nonsense")).toBe(2);
  expect(await h.run("")).toBe(2);
  expect(h.out.at(-1)).toMatch(/restart rovecode after add\/remove/);
  expect(await h.run("info")).toBe(2);
  expect(await h.run("show --project --yes")).toBe(2);
  expect(h.err.at(-1)).toBe('unknown flag --yes for "rovecode mcp show" — see: rovecode mcp help');
  expect(await h.run("add memory --yes --bogus")).toBe(2);
  expect(h.err.at(-1)).toBe('unknown flag --bogus for "rovecode mcp add" — see: rovecode mcp help');
  expect(await h.run("add memory --pick 0 --yes --as mem2")).toBe(0); // valued flags' values are not flags
  expect(await h.run("show --project")).toBe(0);
  expect(await h.run("list --project")).toBe(2);
});

test("cli: on a terminal add shows the plan, asks y/N, asks the secret MASKED by name, writes the value into the user file and never echoes it; a second add refuses without --force; list and remove round-trip", async () => {
  const cwd = tmp("rovecode-mcpc-cwd-"), home = tmp("rovecode-mcpc-home-");
  // An npx server on a terminal is asked ONE thing before the plan — install the package once, or npx as
  // today (the offer, mcp/local-package.ts) — and the plan it then reads is the one that runs. "n" keeps npx.
  // The approval itself is unchanged and comes after the plan; the offer never stands in for it.
  const no = cli(cwd, home, { tty: true, plain: ["n", "n"], secret: "s3cret" });
  expect(await no.run("add io.github.acme/widgets")).toBe(1);
  // "install this?" — the same words `rovecode market install` asks with; the two faces used to differ
  expect(no.prompts).toEqual(["plain:install widgets-mcp@1.2.0 once? [y/N] ", "plain:install this? [y/N] "]);
  expect(no.out.at(-1)).toBe("nothing written");
  expect(existsSync(join(home, "mcp.json"))).toBe(false);
  // the third plain answer is the `pending` one: a required argument only the human knows, asked in the
  // clear right after the masked secret rather than left as a hole in the file
  const yes = cli(cwd, home, { tty: true, plain: ["n", "y", "/srv/data"], secret: "s3cret" });
  expect(await yes.run("add io.github.acme/widgets")).toBe(0);
  // the offer came first, the plan BEFORE the yes, the secret prompt named the variable, and stdout never saw the value
  expect(yes.out.indexOf("Install it once instead?")).toBeLessThan(yes.out.indexOf("  runs       npx -y widgets-mcp@1.2.0 --mode fast"));
  expect(yes.out.indexOf("  runs       npx -y widgets-mcp@1.2.0 --mode fast")).toBeLessThan(yes.out.indexOf(`added "widgets" → ${join(home, "mcp.json")}`));
  expect(yes.out).toContain("  env        WIDGET_TOKEN (asked, masked, never shown)");
  expect(yes.prompts).toEqual(["plain:install widgets-mcp@1.2.0 once? [y/N] ", "plain:install this? [y/N] ", "secret:WIDGET_TOKEN (API token): ", "plain:--root <value>: "]);
  expect([...yes.out, ...yes.err].join("\n")).not.toContain("s3cret");
  const user = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
  expect(user.mcpServers.widgets!.env).toEqual({ WIDGET_TOKEN: "s3cret" });
  expect((user.mcpServers.widgets as unknown as { args: string[] }).args).toEqual(["-y", "widgets-mcp@1.2.0", "--mode", "fast", "--root", "/srv/data"]);
  expect(yes.out.join("\n")).not.toContain("fill in before use"); // it was filled in, at the prompt
  // two answers: the refused --yes run asks before it discovers the clash, the --force run asks again.
  // Answering both matters — a --force reinstall that left the argument blank would REPLACE a working
  // server with one the loader then skips.
  const again = cli(cwd, home, { tty: true, secret: "other", plain: ["/srv/data", "/srv/data"] });
  expect(await again.run("add io.github.acme/widgets --yes")).toBe(1);
  expect(again.err.at(-1)).toMatch(/already has a server named "widgets"/);
  expect(await again.run("add io.github.acme/widgets --yes --force")).toBe(0);
  const lst = cli(cwd, home);
  expect(await lst.run("list")).toBe(0);
  expect(lst.out).toEqual([
    expect.stringMatching(/^user\s+widgets\s+stdio\s+npx -y widgets-mcp@1\.2\.0 --mode fast --root \/srv\/data  env WIDGET_TOKEN$/), // names, never values
    // an npx row gets the install-once OFFER under the list — a sentence and a command, never a rewrite
    expect.stringMatching(/^1 server starts through npx, which re-resolves the package at every start \(~2 s each\): widgets\. To start in ~0\.4 s, reinstall with `rovecode mcp add <catalog name> --local --force` \(the name you installed it by; add `--as <server name>` if you renamed it;.*Nothing changes until you do\.$/),
  ]);
  expect(await lst.run("remove widgets --project")).toBe(1);
  expect(await lst.run("remove widgets")).toBe(0);
  expect(await lst.run("remove widgets")).toBe(1);
  lst.out.length = 0;
  expect(await lst.run("list")).toBe(0);
  expect(lst.out).toEqual(["no MCP servers configured — rovecode mcp search <query>"]);
});

/** a Renderer that answers pickOne from a queue and the approval card with one verdict, recording everything */
function fakeRenderer(picks: (string | null)[], verdict: "once" | "deny") {
  const notes: string[] = [], pickCalls: { title?: string; items: PickItem[] }[] = [], approvals: { tool: string; preview: string; detail?: string }[] = [];
  const renderer = {
    addSystemNote: (t: string) => { notes.push(t); },
    pickOne: async (items: PickItem[], title?: string) => { pickCalls.push({ title, items }); return picks.shift() ?? null; },
    askApproval: async (tool: string, preview: string, detail?: string) => { approvals.push({ tool, preview, detail }); return verdict; },
  } as unknown as Renderer;
  return { renderer, notes, pickCalls, approvals };
}

test("tui /mcp: the palette lists the market under a title, a second pick chooses the launch form, the approval card carries the exact URL + publisher, a yes writes ${NAME} (nothing is ever asked in the TUI) and says which names to set; a deny or an escape writes nothing", async () => {
  const cwd = tmp("rovecode-mcpt-cwd-"), home = tmp("rovecode-mcpt-home-");
  const ok = fakeRenderer(["github", "0"], "once");
  await tuiMcp({ renderer: ok.renderer, cwd, home, market: { offline: true } }, "github");
  expect(ok.pickCalls[0]!.title).toBe("mcp market · github");
  expect(ok.pickCalls[0]!.items[0]).toEqual({ value: "github", label: "GitHub", description: expect.stringMatching(/^curated · Issues, pull requests/) });
  expect(ok.pickCalls[1]!.title).toBe("GitHub · how");
  expect(ok.pickCalls[1]!.items.map((i) => i.label)).toEqual(["connect  https://api.githubcopilot.com/mcp/", "run  docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server"]);
  expect(ok.approvals).toEqual([{ tool: "mcp add", preview: "github ← https://api.githubcopilot.com/mcp/", detail: expect.stringContaining("  connects   https://api.githubcopilot.com/mcp/") }]);
  expect(ok.approvals[0]!.detail).toContain("  publisher  GitHub");
  expect(ok.approvals[0]!.detail).toContain("  header     Authorization: Bearer {GITHUB_PAT}  ← GITHUB_PAT (${GITHUB_PAT} — from your environment)");
  const file = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  expect(file.mcpServers.github).toEqual({ type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_PAT}" } });
  expect(ok.notes.some((n) => n.startsWith('mcp: added "github"') && n.includes("restart me"))).toBe(true);
  expect(ok.notes.some((n) => n.includes("set GITHUB_PAT in your environment") && n.includes("rovecode mcp add github"))).toBe(true);
  // deny: the card was shown, the file untouched
  const home2 = tmp("rovecode-mcpt-home-");
  // memory is an npx server, so one more pick comes first: install once, or npx as today. "npx" = today's line.
  const no = fakeRenderer(["memory", "npx"], "deny");
  await tuiMcp({ renderer: no.renderer, cwd, home: home2, market: { offline: true } }, "memory");
  expect(no.pickCalls[1]!.title).toBe("Memory · how to start it");
  expect(no.pickCalls[1]!.items.map((i) => i.value)).toEqual(["local", "npx"]);
  expect(no.pickCalls[1]!.items[0]!.description).toContain("runs npm install now");
  expect(no.approvals.length).toBe(1);
  expect(no.approvals[0]!.preview).toBe("memory ← npx -y @modelcontextprotocol/server-memory");
  expect(existsSync(join(home2, "mcp.json"))).toBe(false);
  expect(no.notes).toContain("mcp: nothing written");
  // escape out of the palette: no card, no file, no note
  const esc = fakeRenderer([null], "once");
  await tuiMcp({ renderer: esc.renderer, cwd, home: home2, market: { offline: true } }, "");
  expect(esc.pickCalls[0]!.title).toBe("mcp market");
  expect(esc.approvals).toEqual([]);
  expect(esc.notes).toEqual([]);
  // an OPTIONAL secret nobody answered is left out of the file and out of the closing note — the file works as written
  const opt = fakeRenderer(["context7", "0"], "once");
  await tuiMcp({ renderer: opt.renderer, cwd, home: home2, market: { offline: true } }, "context7");
  const c7 = (JSON.parse(readFileSync(join(home2, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.context7;
  expect(c7).toEqual({ type: "http", url: "https://mcp.context7.com/mcp" });
  expect(opt.notes.some((n) => n.includes("in your environment"))).toBe(false);
  // --project lands in the repo file
  const pr = fakeRenderer(["memory", "npx"], "once");
  await tuiMcp({ renderer: pr.renderer, cwd, home: home2, market: { offline: true } }, "memory --project");
  expect(existsSync(join(cwd, ".rovecode", "mcp.json"))).toBe(true);
  expect(pr.approvals[0]!.detail).toContain(`  writes     ${join(cwd, ".rovecode", "mcp.json")}  as "memory"`);
});
