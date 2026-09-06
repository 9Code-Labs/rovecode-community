/** Install once from the /market overlay (draw-market.ts chooser + market-source.ts) — the same ceremony as the
 *  two CLI faces and /mcp: the choice is shown BEFORE the plan card, the plan the human then reads is the one
 *  that runs, the card is still the gate, and npm runs only after Enter on that card. Pinned here: Enter on an
 *  npx row opens the chooser (not a plan, not an install); ↑↓ toggle; Esc backs out to the list with nothing
 *  asked for; Enter asks for the plan WITH the answer; a non-npx row skips the chooser; the plan carries `local`
 *  into the install request; the deny path (Esc on the card) reaches no install and runs no npm; and through
 *  the real market module: the install-once plan says npm + code, the install writes `node <bin>` + the record,
 *  "as today" writes the npx line and never calls npm. */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHOICE_LINES, drawMarket, onMarketKey, openMarket, type MarketPlan, type MarketViewRow } from "../../src/sextant/draw-market.ts";
import { install, loadMarket, planFor } from "../../src/sextant/market-source.ts";
import { handleInput } from "../../src/sextant/keys.ts";
import type { HitZone, SextantState } from "../../src/sextant/types.ts";
import { key, makeLayout, spyCtx } from "../helpers/sextant-fixtures-keys.ts";
import { GridScreen, THEME, baseState } from "../helpers/sextant-grid.ts";
import { fakeNpm, FAKE_INTEGRITY } from "../helpers/fake-npm.ts";

const dirs: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const L = makeLayout(150, 40);
function render(s: SextantState, hits?: HitZone[]): string {
  const g = new GridScreen(L.w, L.h, " ");
  drawMarket(g, L, THEME, s, undefined, hits);
  return g.toText();
}

const npxRow: MarketViewRow = {
  id: "memory", kind: "mcp", title: "Memory", publisher: "modelcontextprotocol (Anthropic)", description: "A knowledge graph the model keeps between sessions.",
  runs: "npx -y @modelcontextprotocol/server-memory", env: [], localOffer: "@modelcontextprotocol/server-memory",
};
const httpRow: MarketViewRow = {
  id: "github", kind: "mcp", title: "GitHub", publisher: "GitHub", description: "Issues, pull requests and code search.",
  runs: "remote https://api.githubcopilot.com/mcp/", env: [],
};

function open(rows: MarketViewRow[] = [npxRow, httpRow]) {
  const s = baseState();
  openMarket(s, rows);
  return s;
}

describe("the chooser, in the key handler", () => {
  test("Enter on an npx row opens the chooser and asks for nothing yet; the card names both ways and the trade under each", () => {
    const s = open();
    expect(onMarketKey(s, key("enter"))).toEqual({ kind: "none" });
    expect(s.market!.choice).toEqual({ row: npxRow, sel: 0 });
    expect(s.market!.plan).toBeNull();
    const text = render(s);
    expect(text).toContain("how to start it");
    expect(text).toContain("Memory · @modelcontextprotocol/server-memory");
    expect(text).toContain(`● ${CHOICE_LINES[0]!.label}`);
    expect(text).toContain(`○ ${CHOICE_LINES[1]!.label}`);
    expect(text).toContain("npm install runs now, AFTER the plan is approved");
    expect(text).toContain("nothing is installed now");
    expect(text).toContain("⏎ show the plan");
  });

  test("↑↓ toggle the answer; Esc backs out to the list with no plan and no install asked for", () => {
    const s = open();
    onMarketKey(s, key("enter"));
    expect(onMarketKey(s, key("down"))).toEqual({ kind: "none" });
    expect(s.market!.choice!.sel).toBe(1);
    expect(render(s)).toContain(`● ${CHOICE_LINES[1]!.label}`);
    onMarketKey(s, key("up"));
    expect(s.market!.choice!.sel).toBe(0);
    expect(onMarketKey(s, key("escape"))).toEqual({ kind: "none" });
    expect(s.market!.choice).toBeNull();
    expect(s.market!.plan).toBeNull();
    expect(s.market).not.toBeNull();                                   // the overlay itself stays open
  });

  test("Enter on the chooser asks for the plan WITH the answer: install once → local: true, as today → local: false", () => {
    const s = open();
    onMarketKey(s, key("enter"));
    expect(onMarketKey(s, key("enter"))).toEqual({ kind: "plan", row: npxRow, local: true });
    expect(s.market!.choice).toBeNull();
    onMarketKey(s, key("enter"));                                     // open again
    onMarketKey(s, key("down"));
    expect(onMarketKey(s, key("enter"))).toEqual({ kind: "plan", row: npxRow, local: false });
  });

  test("a row that does not start through npx skips the chooser: Enter is the plan request, exactly as before", () => {
    const s = open();
    s.market!.sel = 1;
    expect(onMarketKey(s, key("enter"))).toEqual({ kind: "plan", row: httpRow });
    expect(s.market!.choice).toBeNull();
  });

  test("a click on a chooser row selects it; Enter still decides", () => {
    const s = open();
    onMarketKey(s, key("enter"));
    const hits: HitZone[] = [];
    render(s, hits);
    // the option zones are the one-row zones at the card's text column: card w = min(84, L.w-8) = 84 → x = 33, text at x+3,
    // width w-6 (the tab strip's zones are one row too, but sit at the overlay's own left edge)
    const options = hits.filter((h) => h.rect.h === 1 && h.rect.x === 36 && h.rect.w === 78);
    expect(options).toHaveLength(2);
    options[1]!.onClick();
    expect(s.market!.choice!.sel).toBe(1);
    options[0]!.onClick();
    expect(s.market!.choice!.sel).toBe(0);
    expect(s.market!.plan).toBeNull();                                // a click never asks for the plan; Enter does
  });
});

describe("the plan is the gate, with the answer attached", () => {
  test("through handleInput: the chooser's answer reaches marketPlan; the approved card's `local` reaches marketInstall; Esc on the card reaches nothing", () => {
    const s = open();
    const spy = spyCtx();
    handleInput(s, key("enter"), spy.ctx, 0);                         // opens the chooser
    expect(spy.market).toEqual([]);
    handleInput(s, key("enter"), spy.ctx, 0);                         // install once → the plan is asked for with local
    expect(spy.market).toEqual(["plan:mcp:memory:local"]);
    // the renderer answers (asynchronously in production) with the plan it drew for `node <bin>`
    const plan: MarketPlan = { row: npxRow, title: "mcp:memory — Memory", target: "~/.rovecode/mcp.json", scope: "user", preview: ["  runs       node …", "  installs   npm install …"], asks: [], pending: [], local: true };
    s.market!.plan = { ...plan };
    // DENY: Esc on the card — no install request, so nothing downstream ever runs npm
    handleInput(s, key("escape"), spy.ctx, 0);
    expect(s.market!.plan).toBeNull();
    expect(spy.market).toEqual(["plan:mcp:memory:local"]);
    // YES: the card's own `local` travels with the install request — never re-derived from the row or the chooser
    s.market!.plan = { ...plan };
    handleInput(s, key("enter"), spy.ctx, 0);
    expect(spy.market).toEqual(["plan:mcp:memory:local", "install:mcp:memory:local"]);
    // and a card drawn for "as today" installs as today
    s.market!.plan = { ...plan, local: false, preview: ["  runs       npx -y …"] };
    handleInput(s, key("enter"), spy.ctx, 0);
    expect(spy.market.at(-1)).toBe("install:mcp:memory");
  });
});

describe("through the real market module (curated shelf, offline)", () => {
  const ctx = (home: string) => ({ scope: "user" as const, cwd: tmp("rovecode-mlocal-cwd-"), home });

  test("loadMarket marks the npx rows with the offer and leaves the others alone", async () => {
    const home = tmp("rovecode-mlocal-home-");
    const { rows } = await loadMarket(process.cwd(), home, { offline: true });
    const memory = rows.find((r) => r.kind === "mcp" && r.id === "memory");
    const github = rows.find((r) => r.kind === "mcp" && r.id === "github");
    expect(memory?.localOffer).toBe("@modelcontextprotocol/server-memory");
    expect(github?.localOffer).toBeUndefined();
  });

  test("planFor with the answer draws the install-once plan (node line, npm command, code lands) and remembers it; without it, today's npx plan", async () => {
    const home = tmp("rovecode-mlocal-home-");
    const c = ctx(home);
    const local = await planFor(npxRow, c, true);
    if ("error" in local) throw new Error(local.error);
    expect(local.local).toBe(true);
    expect(local.preview.some((l) => l.startsWith("  runs       node "))).toBe(true);
    expect(local.preview.some((l) => l.startsWith(`  installs   npm install --prefix ${join(home, "mcp")}`))).toBe(true);
    expect(local.preview.some((l) => l.includes("rovecode runs a package manager for you here"))).toBe(true);
    expect(local.preview.some((l) => l.includes("puts their CODE on this machine"))).toBe(true);
    const today = await planFor(npxRow, c);
    if ("error" in today) throw new Error(today.error);
    expect(today.local).toBeUndefined();
    expect(today.preview).toContain("  runs       npx -y @modelcontextprotocol/server-memory");
    expect(today.preview.some((l) => l.startsWith("  installs"))).toBe(false);
    expect(existsSync(join(home, "mcp.json"))).toBe(false);          // a plan writes nothing
    expect(existsSync(join(home, "mcp"))).toBe(false);
  });

  test("install with local runs npm (the seam), writes `node <absolute bin>` and the record; install as today writes the npx line and never calls npm", async () => {
    const home = tmp("rovecode-mlocal-home-");
    const c = ctx(home);
    const npm = fakeNpm({ version: "2026.8.31" });
    const once = await install(npxRow, c, { local: true, deps: { spawn: npm.spawn } });
    expect(once.ok).toBe(true);
    expect(npm.calls).toHaveLength(1);
    const prefix = join(home, "mcp");
    const bin = join(prefix, "node_modules", "@modelcontextprotocol", "server-memory", "dist", "index.js");
    expect(once.text).toContain(`@modelcontextprotocol/server-memory 2026.8.31 installed once → ${prefix} (integrity recorded)`);
    const file = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(file.mcpServers.memory).toEqual({ command: "node", args: [bin] });
    const manifest = JSON.parse(readFileSync(join(home, "installed.json"), "utf8")) as { installs: { id: string; package?: { integrity?: string; bin: string } }[] };
    expect(manifest.installs).toEqual([expect.objectContaining({ id: "memory", package: expect.objectContaining({ bin, integrity: FAKE_INTEGRITY }) })]);
    // as today, into a fresh home: npx, no npm, no record
    const home2 = tmp("rovecode-mlocal-home-");
    const today = await install(npxRow, ctx(home2), { deps: { spawn: npm.spawn } });
    expect(today.ok).toBe(true);
    expect(npm.calls).toHaveLength(1);                                // unchanged
    const file2 = JSON.parse(readFileSync(join(home2, "mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(file2.mcpServers.memory).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] });
    expect(existsSync(join(home2, "installed.json"))).toBe(true);    // the market records every install it makes (as before)…
    const manifest2 = JSON.parse(readFileSync(join(home2, "installed.json"), "utf8")) as { installs: { id: string; package?: unknown }[] };
    expect(manifest2.installs[0]!.package).toBeUndefined();          // …but a config line has no package to record
  });
});
