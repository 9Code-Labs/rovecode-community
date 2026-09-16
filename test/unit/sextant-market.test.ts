/** The market overlay: what it shows, what the keys do, and — the part that matters — that the three
 *  not-ready states never read alike and that nothing installs without the plan card being confirmed. */

import { describe, expect, test } from "bun:test";
import {
  closeMarket, drawMarket, marketCounts, marketVisible, onMarketKey, openMarket, rewrap, rowBadge, statusLine, wrap,
  type MarketPlan, type MarketStatus, type MarketViewRow,
} from "../../src/sextant/draw-market.ts";
import { statusFrom, toViewRow } from "../../src/sextant/market-source.ts";
import { key, makeLayout, mouse, spyCtx } from "../helpers/sextant-fixtures-keys.ts";
import { GridScreen, THEME, baseState } from "../helpers/sextant-grid.ts";
import { handleInput } from "../../src/sextant/keys.ts";
import type { HitZone, SextantState } from "../../src/sextant/types.ts";

const L = makeLayout(150, 40);
/** paint the overlay onto a grid and read it back as text */
function render(s: SextantState, hits?: HitZone[]): string {
  const g = new GridScreen(L.w, L.h, " ");
  drawMarket(g, L, THEME, s, undefined, hits);
  return g.toText();
}

/** paint and keep the click zones the frame registered */
function renderWith(s: SextantState, hits: HitZone[]): void {
  drawMarket(new GridScreen(L.w, L.h, " "), L, THEME, s, undefined, hits);
}

const row = (over: Partial<MarketViewRow> = {}): MarketViewRow => ({
  id: "filesystem", kind: "mcp", title: "Filesystem", publisher: "modelcontextprotocol (Anthropic)",
  description: "Read, write, search and move files under the directories you name.",
  runs: "npx -y @modelcontextprotocol/server-filesystem", env: [], ...over,
});

const ROWS: MarketViewRow[] = [
  row(),
  row({ id: "github", title: "GitHub", publisher: "GitHub", description: "Issues, pull requests and code search.", runs: "remote https://api.githubcopilot.com/mcp/", env: [{ name: "Authorization", required: true, secret: true, description: "a GitHub personal access token" }] }),
  row({ id: "conventional-commits", kind: "skill", title: "conventional-commits", publisher: "plugin: conventional-commits", description: "Conventional Commits: types, one scope, imperative subject.", runs: "a SKILL.md the model reads when it matches" }),
  row({ id: "notes", kind: "plugin", title: "notes", publisher: "rovecode", description: "A scratchpad that survives the session.", runs: "copy plugins/notes", installed: { path: "~/.rovecode/plugins/notes", scope: "user", version: "0.1.0" } }),
];

function open(rows = ROWS, status: MarketStatus = { kind: "ready" }) {
  const s = baseState();
  openMarket(s, rows, status);
  return s;
}

describe("market overlay · rows", () => {
  test("the tab strip counts the whole catalog, not the filtered list", () => {
    const s = open();
    s.market!.query = "github";
    expect(marketCounts(s.market!)).toEqual({ all: 4, mcp: 2, skill: 1, plugin: 1 });
  });

  test("a tab narrows to its kind and the query ranks inside it", () => {
    const s = open();
    s.market!.tab = "mcp";
    expect(marketVisible(s.market!).map((r) => r.id)).toEqual(["filesystem", "github"]);
    s.market!.query = "github";
    expect(marketVisible(s.market!).map((r) => r.id)).toEqual(["github"]);
  });

  test("the badge comes from `installed` alone, and says which kind of installed", () => {
    expect(rowBadge(row())).toBeNull();
    expect(rowBadge(row({ installed: { path: "p", scope: "user" } }))?.text).toBe("installed");
    expect(rowBadge(row({ installed: { path: "p", scope: "user", updateAvailable: true } }))?.text).toBe("update");
    expect(rowBadge(row({ installed: { path: "p", scope: "project", trusted: false } }))?.text).toBe("not approved");
  });
});

describe("market overlay · the three not-ready states", () => {
  test("empty, offline and error are three different sentences", () => {
    const empty = statusLine({ ...open([]).market!, status: { kind: "ready" } }, 0);
    const offline = statusLine(open(ROWS, { kind: "offline", note: "showing cached results, 4m old" }).market!, 4);
    const error = statusLine(open([], { kind: "error", reason: "mcp:registry: connect ETIMEDOUT" }).market!, 0);
    expect(empty?.text).toBe("the catalog is empty");
    expect(offline?.text).toContain("cached");
    expect(error?.text).toContain("ETIMEDOUT");
    expect(new Set([empty?.tone, offline?.tone, error?.tone]).size).toBe(3);
  });

  test("no matches is not the same as an empty catalog", () => {
    const s = open();
    s.market!.query = "zzzz";
    expect(statusLine(s.market!, 0)?.text).toContain('nothing matches "zzzz"');
  });

  test("a source that failed is an error even when other sources produced rows", () => {
    expect(statusFrom({ "mcp:curated": { ok: true, from: "curated" }, "mcp:registry": { ok: false, reason: "connect ETIMEDOUT" } }))
      .toEqual({ kind: "error", reason: "mcp:registry: connect ETIMEDOUT" });
  });

  test("a cache hit is offline with its age; a skipped source says why, verbatim", () => {
    const cached = statusFrom({ "mcp:registry": { ok: true, from: "cache", ageMs: 240_000 } });
    expect(cached).toEqual({ kind: "offline", note: "showing cached results, 4m old" });
    const skipped = statusFrom({ "mcp:registry": { ok: true, from: "skipped", why: "an empty query does not ask the registry" } });
    expect(skipped).toEqual({ kind: "offline", note: "an empty query does not ask the registry" });
  });

  test("every source ok and nothing skipped is simply ready", () => {
    expect(statusFrom({ skills: { ok: true, from: "curated" }, plugins: { ok: true, from: "curated" } })).toEqual({ kind: "ready" });
  });
});

describe("market overlay · keys", () => {
  test("↑↓ wrap, ⇥ cycles the kinds, typing filters and resets the selection", () => {
    const s = open();
    onMarketKey(s, key("down"));
    expect(s.market!.sel).toBe(1);
    onMarketKey(s, key("up"));
    onMarketKey(s, key("up"));
    expect(s.market!.sel).toBe(3); // wrapped to the end
    onMarketKey(s, key("tab"));
    expect(s.market!.tab).toBe("mcp");
    expect(s.market!.sel).toBe(0);
    onMarketKey(s, key("shift-tab"));
    expect(s.market!.tab).toBe("all");
    for (const ch of "git") onMarketKey(s, key(ch));
    expect(s.market!.query).toBe("git");
    expect(marketVisible(s.market!)[0]!.id).toBe("github");
    onMarketKey(s, key("backspace"));
    expect(s.market!.query).toBe("gi");
  });

  test("Enter asks for a plan — it does not install", () => {
    const s = open();
    const req = onMarketKey(s, key("enter"));
    expect(req).toEqual({ kind: "plan", row: ROWS[0]! });
    expect(s.market!.plan).toBeNull();
  });

  test("nothing installs until the plan card is confirmed, and esc backs out of it", () => {
    const s = open();
    const plan: MarketPlan = { row: ROWS[0]!, title: "mcp:filesystem — Filesystem", target: "~/.rovecode/mcp.json", scope: "user", preview: ["writes one server entry"], asks: [], pending: [] };
    s.market!.plan = plan;
    expect(onMarketKey(s, key("escape"))).toEqual({ kind: "none" });
    expect(s.market!.plan).toBeNull();
    s.market!.plan = { ...plan };
    const req = onMarketKey(s, key("enter"));
    expect(req.kind).toBe("install");
    expect(s.market!.plan!.running).toBe(true);
    // a second Enter while it runs must not start a second install
    expect(onMarketKey(s, key("enter"))).toEqual({ kind: "none" });
  });

  test("Enter on a finished plan dismisses the card", () => {
    const s = open();
    s.market!.plan = { row: ROWS[0]!, title: "t", target: "p", scope: "user", preview: [], asks: [], pending: [], outcome: { ok: true, text: "installed into ~/.rovecode/mcp.json" } };
    onMarketKey(s, key("enter"));
    expect(s.market!.plan).toBeNull();
  });

  test("esc closes the overlay when no card is open", () => {
    const s = open();
    onMarketKey(s, key("escape"));
    expect(s.market).toBeNull();
  });

  test("the overlay swallows keys through handleInput and asks the renderer for the plan", () => {
    const s = open();
    const spy = spyCtx();
    handleInput(s, key("down"), spy.ctx, 0);
    handleInput(s, key("enter"), spy.ctx, 0);
    expect(spy.market).toEqual(["plan:mcp:github"]);
    expect(spy.submits).toEqual([]); // nothing reached the agent
  });

  test("closeMarket clears the state", () => {
    const s = open();
    closeMarket(s);
    expect(s.market).toBeNull();
  });
});

describe("market overlay · painting", () => {
  test("the frame carries the title, the tabs with counts, the selected row and its detail", () => {
    const s = open();
    const text = render(s);
    expect(text).toContain("market");
    expect(text).toContain("all 4");
    expect(text).toContain("mcp 2");
    expect(text).toContain("Filesystem");
    expect(text).toContain("npx -y @modelcontextprotocol/server-filesystem");
    expect(text).toContain("what it runs");
    expect(text).toContain("⏎ install");
    expect(text).toContain("esc closes");
  });

  test("a secret variable is drawn with its lock and its sentence", () => {
    const s = open();
    s.market!.sel = 1;
    const text = render(s);
    expect(text).toContain("Authorization");
    expect(text).toContain("Authorization · secret");
    expect(text).toContain("personal access token");
  });

  test("an installed row shows its badge and where it landed", () => {
    const s = open();
    s.market!.sel = 3;
    const text = render(s);
    expect(text).toContain("installed");
    expect(text).toContain("~/.rovecode/plugins/notes");
  });

  test("the plan card covers the list and says what confirming does", () => {
    const s = open();
    s.market!.plan = { row: ROWS[0]!, title: "mcp:filesystem — Filesystem", target: "~/.rovecode/mcp.json", scope: "user", preview: ["writes one server entry", "runs npx on launch"], asks: [{ name: "TOKEN", required: true, secret: true }], pending: ["<directory the server may touch>"] };
    const text = render(s);
    expect(text).toContain("install plan");
    expect(text).toContain("user scope · ~/.rovecode/mcp.json");
    expect(text).toContain("writes one server entry");
    expect(text).toContain("asks TOKEN (secret, masked)");
    expect(text).toContain("you supply <directory the server may touch>");
    expect(text).toContain("⏎ install");
    expect(text).toContain("esc cancel");
  });

  test("the error state names the source and still offers the way out", () => {
    const s = open([], { kind: "error", reason: "mcp:registry: connect ETIMEDOUT" });
    const text = render(s);
    expect(text).toContain("connect ETIMEDOUT");
    expect(text).toContain("the curated shelf still works offline");
  });

  test("a click on a row selects it and carries Enter; a click outside closes", () => {
    const s = open();
    const hits: HitZone[] = [];
    render(s, hits);
    const rowHit = hits.filter((h) => h.key?.name === "enter").at(-1)!;
    rowHit.onClick();
    expect(s.market!.sel).toBeGreaterThan(0);
    hits[0]!.onClick(); // the full-screen zone, registered first
    expect(s.market).toBeNull();
  });
});

describe("market overlay · helpers", () => {
  test("wrap breaks on words and cuts a word longer than the column", () => {
    expect(wrap("one two three", 9)).toEqual(["one two", "three"]);
    expect(wrap("supercalifragilistic", 6)).toEqual(["superc"]);
    expect(wrap("", 10)).toEqual([]);
  });

  test("toViewRow flattens an mcp item's first install form and names the rest", () => {
    const view = toViewRow({
      id: "github", kind: "mcp", title: "GitHub", publisher: "GitHub", description: "d", tags: [], env: [],
      install: { kind: "mcp", entry: { installs: [
        { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
        { kind: "stdio", runtime: "docker", command: "docker", args: ["run", "ghcr.io/github/github-mcp-server"] },
      ] } },
    } as Parameters<typeof toViewRow>[0]);
    expect(view.runs).toBe("remote https://api.githubcopilot.com/mcp/");
    expect(view.alternatives).toEqual(["docker: docker run ghcr.io/github/github-mcp-server"]);
  });

  test("toViewRow keeps a skill's honest 'runs nothing' line", () => {
    const view = toViewRow({
      id: "s", kind: "skill", title: "s", publisher: "p", description: "d", tags: [], env: [],
      install: { kind: "skill", files: [{ path: "SKILL.md", text: "" }] },
    } as Parameters<typeof toViewRow>[0]);
    expect(view.runs).toContain("runs nothing");
  });
});

describe("market overlay · the plan card is the decision", () => {
  test("installing runs the plan the human approved, not whatever is selected now", () => {
    // the plan arrives asynchronously: an arrow key after Enter used to move the selection under the card,
    // and the install then wrote the OTHER item
    const s = open();
    const spy = spyCtx();
    handleInput(s, key("enter"), spy.ctx, 0); // asks for a plan for row 0
    s.market!.plan = { row: ROWS[0]!, title: "mcp:filesystem — Filesystem", target: "~/.rovecode/mcp.json", scope: "user", preview: ["writes one server entry"], asks: [], pending: [] };
    s.market!.sel = 2; // the human moved on while the card was opening
    handleInput(s, key("enter"), spy.ctx, 0);
    expect(spy.market).toEqual(["plan:mcp:filesystem", "install:mcp:filesystem"]);
  });

  test("a list row takes no clicks while the card is up", () => {
    const s = open();
    s.market!.plan = { row: ROWS[0]!, title: "t", target: "p", scope: "user", preview: [], asks: [], pending: [] };
    const hits: HitZone[] = [];
    renderWith(s, hits);
    // the only zones left are the overlay's own backdrop and the card; no row may move the selection
    const before = s.market!.sel;
    for (const h of hits) if (h.key?.name === "enter") h.onClick();
    expect(s.market!.sel).toBe(before);
  });

  test("esc cannot walk away from an install that is already running", () => {
    const s = open();
    s.market!.plan = { row: ROWS[0]!, title: "t", target: "p", scope: "user", preview: [], asks: [], pending: [], running: true };
    onMarketKey(s, key("escape"));
    expect(s.market!.plan).not.toBeNull(); // the write is happening; the card stays until it answers
    expect(s.market!.plan!.running).toBe(true);
    s.market!.plan!.running = false;
    s.market!.plan!.outcome = { ok: true, text: "installed into ~/.rovecode/mcp.json" };
    onMarketKey(s, key("escape"));
    expect(s.market!.plan).toBeNull(); // once it has answered, esc dismisses it
  });

  test("a bare d is a search letter, not a shortcut", () => {
    const s = open();
    for (const ch of "docker") onMarketKey(s, key(ch));
    expect(s.market!.query).toBe("docker");
    expect(s.market!.docs).toBe(false);
  });
});

/** Four defects an independent audit reproduced against this code. Each is pinned by what a user would
 *  notice, not by the line that changed — the point is that the surface stays honest however the
 *  routing is refactored later. */
describe("market overlay · what the audit found", () => {
  const withCard = (s: SextantState) => {
    s.card = { kind: "approval", tool: "write", detail: "", verdicts: ["allow", "deny"], sel: 0, resolve: () => {} } as unknown as SextantState["card"];
    return s;
  };

  test("a ctrl chord does not open an overlay on top of a live card", () => {
    // a card is a decision a tool is blocked on. An overlay painted over it registers its hit zones
    // first, so the card stops answering the mouse and the caller waits on a surface nobody can reach.
    for (const name of ["m", "k", "p", "b"]) {
      const s = withCard(baseState());
      handleInput(s, { ...key(name), ctrl: true }, spyCtx(L).ctx, 0);
      expect(s.market).toBeNull();
      expect(s.palette).toBeNull();
      expect(s.card).not.toBeNull(); // and the card is still there to be answered
    }
  });

  test("ctrl-c still reaches the card — the guard is about overlays, not about ctrl", () => {
    const s = withCard(baseState());
    handleInput(s, { ...key("c"), ctrl: true }, spyCtx(L).ctx, 0);
    expect(s.card).toBeNull();
  });

  test("clicking the backdrop cannot walk away from an install that is already running", () => {
    // esc has refused this since the plan card was written; the mouse had its own way out, and the
    // outcome that arrived afterwards was then discarded — the user never learned what happened
    const s = open();
    s.market!.plan = { row: ROWS[0]!, title: "t", target: "p", scope: "user", preview: [], asks: [], pending: [], running: true };
    const hits: HitZone[] = [];
    renderWith(s, hits);
    hits[0]!.onClick();   // the full-screen backdrop is registered first
    expect(s.market).not.toBeNull();

    s.market!.plan!.running = false;
    const after: HitZone[] = [];
    renderWith(s, after);
    after[0]!.onClick();
    expect(s.market).toBeNull(); // once nothing is in flight it closes as it always did
  });

  test("the wheel does not scroll the transcript hidden behind an open overlay", () => {
    const s = open();
    s.msgScroll = 0;
    handleInput(s, mouse(65, L.messages.x + 1, L.messages.y + 1), spyCtx(L).ctx, 0);
    expect(s.msgScroll).toBe(0);
  });

  test("the docs pane wraps to the column it is drawn in, losing no words", () => {
    // docLines wraps at a fixed 96 and the detail column never exceeds ~65, so every longer line was
    // hard-clipped by scr.clip and the clipped part was simply gone — on every terminal, not a corner
    const sentence = "the quick brown fox jumps over the lazy dog and keeps running well past any sensible column";
    const wrapped = rewrap([{ kind: "text", text: sentence }], 40);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const l of wrapped) expect(l.text.length).toBeLessThanOrEqual(40);
    expect(wrapped.map((l) => l.text).join(" ")).toBe(sentence); // every word survived, in order
  });

  test("a code line is chunked, not word-wrapped", () => {
    // breaking a command on a space would show a reader something copyable the document never said
    const cmd = "npx -y @modelcontextprotocol/server-filesystem /a/very/long/path/that/keeps/going";
    const out = rewrap([{ kind: "code", text: cmd }], 30);
    expect(out.every((l) => l.kind === "code")).toBe(true);
    expect(out.map((l) => l.text).join("")).toBe(cmd); // reassembles exactly
  });
});
