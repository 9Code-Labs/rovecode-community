/** One overlay at a time.
 *
 *  Help, the palette and the market each own a field on SextantState, and for a while each opener wrote its
 *  own: ⌃m with the help card up left both set, help painted over the market, and the market was unreachable
 *  until esc dismissed the card. The fix is a single transition (overlays.ts openOverlay) that every opener
 *  goes through. These tests exist so a fourth overlay cannot quietly reintroduce the bug: the invariant at
 *  the bottom fails for ANY pair that can be open together, including one this file has never heard of. */

import { describe, expect, test } from "bun:test";
import { closeMarket, openMarket, type MarketViewRow } from "../../src/sextant/draw-market.ts";
import { closePalette, openHelp, openOverlay, openOverlays, openPalette, type OverlayKind } from "../../src/sextant/overlays.ts";
import { openContext } from "../../src/sextant/draw-context.ts";
import { handleInput } from "../../src/sextant/keys.ts";
import { key, spyCtx } from "../helpers/sextant-fixtures-keys.ts";
import { baseState } from "../helpers/sextant-grid.ts";
import type { SextantState } from "../../src/sextant/types.ts";

const ROWS: MarketViewRow[] = [
  { id: "filesystem", kind: "mcp", title: "Filesystem", publisher: "modelcontextprotocol (Anthropic)",
    description: "Read, write, search and move files under the directories you name.",
    runs: "npx -y @modelcontextprotocol/server-filesystem", env: [] },
];

/** a minimal report for the context overlay: the numbers do not matter here, only that it opens */
const CONTEXT = {
  model: "anthropic/claude-opus-5", window: 1_000_000, estimated: 1_000, remaining: 999_000, fraction: 0.001,
  raw: 826, scale: { factor: 1.21, measured: true, note: "measured on Claude 4.5" },
  slices: [{ label: "your messages", tokens: 1_000, share: 1 }], images: 0,
  billed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unpricedTurns: 0, live: true, tolerance: 0.05,
};

/** every way an overlay can be opened, by name — a new overlay adds one row here */
const OPENERS: [OverlayKind, (s: SextantState) => void][] = [
  ["palette", (s) => { openPalette(s, [{ label: "x", group: "commands", action: "/help" }]); }],
  ["market", (s) => { openMarket(s, ROWS); }],
  ["help", (s) => { openHelp(s); }],
  ["context", (s) => { openContext(s, CONTEXT); }],
];

describe("one overlay at a time", () => {
  test("every opener leaves exactly its own overlay open, whatever was open before", () => {
    for (const [, before] of OPENERS) {
      for (const [name, open] of OPENERS) {
        const s = baseState();
        before(s);
        open(s);
        expect(openOverlays(s)).toEqual([name]);
      }
    }
  });

  test("opening the market closes the help card, and the keys go to the market", () => {
    const s = baseState();
    openHelp(s);
    openMarket(s, ROWS);
    expect(s.help).toBe(false);
    expect(s.market).not.toBeNull();
    const spy = spyCtx();
    handleInput(s, key("enter"), spy.ctx, 0);
    expect(spy.market).toEqual(["plan:mcp:filesystem"]); // the market answered, not the help card
  });

  test("opening the help card closes the market, and the keys go to the card", () => {
    const s = baseState();
    openMarket(s, ROWS);
    openHelp(s);
    expect(s.market).toBeNull();
    expect(s.help).toBe(true);
    const spy = spyCtx();
    handleInput(s, key("escape"), spy.ctx, 0); // the card swallows it and dismisses
    expect(s.help).toBe(false);
    expect(spy.market).toEqual([]);
  });

  test("the palette and the market displace each other too", () => {
    const s = baseState();
    openPalette(s, [{ label: "x", group: "commands", action: "/help" }]);
    openMarket(s, ROWS);
    expect(s.palette).toBeNull();
    openPalette(s, [{ label: "x", group: "commands", action: "/help" }]);
    expect(s.market).toBeNull();
  });

  test("openOverlay(null) closes everything; the closers stay honest on their own", () => {
    const s = baseState();
    openMarket(s, ROWS);
    openOverlay(s, null);
    expect(openOverlays(s)).toEqual([]);
    openPalette(s);
    closePalette(s);
    openMarket(s, ROWS);
    closeMarket(s);
    expect(openOverlays(s)).toEqual([]);
  });

  test("INVARIANT: no sequence of openers can leave two overlays set", () => {
    // every ordered pair and triple — the check that survives an overlay this file does not know about,
    // because a new one is added to OPENERS and to overlays.ts openOverlay in the same breath
    for (const [, a] of OPENERS) {
      for (const [, b] of OPENERS) {
        for (const [, c] of OPENERS) {
          const s = baseState();
          a(s); b(s); c(s);
          expect(openOverlays(s).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("the state starts with no overlay open", () => {
    expect(openOverlays(baseState())).toEqual([]);
  });
});
