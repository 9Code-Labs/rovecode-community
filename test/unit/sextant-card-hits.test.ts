/** card-hits.ts — clicking the modal card.
 *
 *  Until this landed, the most-used interaction in the surface answered only to the arrow keys:
 *  keys.ts's onMouse walks the hit zones the drawers registered that frame, and nobody registered any
 *  for the card, so a click on `allow` fell through to "focus the panel under the pointer" and did
 *  nothing. These pin the geometry, and then drive a real click through handleInput to prove the
 *  verdict actually resolves — geometry that nothing consumes would pass a test and fix nothing. */

import { test, expect } from "bun:test";
import { cardHits } from "../../src/sextant/card-hits.ts";
import { VERDICT_LABEL, SKIP_LABEL, MAX_FREE_TEXT_ROWS, cardRows, promptCursor } from "../../src/sextant/draw-messages.ts";
import type { CardState, SextantState } from "../../src/sextant/types.ts";

/** the question prompt's shape as the card reads it — a structural stand-in so the fixture stays terse */
type QuestionPromptLike = { question: string; options?: string[]; allowFreeText?: boolean };
import { makeState, makeLayout, spyCtx, mouse, press, THEME } from "../helpers/sextant-fixtures-keys.ts";

const L = makeLayout(160, 44);

const approval = (over: Partial<Extract<CardState, { kind: "approval" }>> = {}): CardState => ({
  kind: "approval", tool: "write", argsPreview: "src/x.ts", detail: null,
  verdicts: ["once", "always", "deny"], selected: 0, resolve: () => {}, ...over,
} as CardState);

const question = (over: Record<string, unknown> = {}): CardState => ({
  kind: "question",
  prompt: { question: "which store?", options: ["sqlite", "postgres"], allowFreeText: true } as QuestionPromptLike,
  selected: 0, freeText: "", resolve: () => {}, ...over,
} as CardState);

/** state with a card open, and the click zones the frame loop would register for it */
const withCard = (card: CardState): { s: SextantState; hits: ReturnType<typeof cardHits> } => {
  const s = makeState({ card });
  return { s, hits: cardHits(L.messages, s, THEME) };
};

// ---------- approval geometry ----------

test("the three verdicts each get their own zone, side by side on one row, in order", () => {
  const { hits } = withCard(approval());
  expect(hits.map((h) => h.index)).toEqual([0, 1, 2]);
  expect(hits.every((h) => h.confirm)).toBe(true);
  expect(new Set(hits.map((h) => h.rect.y)).size).toBe(1); // one row: the verdicts are laid out horizontally
  expect(hits.every((h) => h.rect.h === 1)).toBe(true);
  // widths follow the ` label ` the painter draws, and the zones do not overlap
  expect(hits[0]!.rect.w).toBe(VERDICT_LABEL.once.length + 2);
  expect(hits[1]!.rect.w).toBe(VERDICT_LABEL.always.length + 2);
  expect(hits[0]!.rect.x + hits[0]!.rect.w).toBeLessThan(hits[1]!.rect.x);
  expect(hits[1]!.rect.x + hits[1]!.rect.w).toBeLessThan(hits[2]!.rect.x);
});

test("a fourth verdict (all edits) gets a zone too — the row is not hardcoded to three", () => {
  const { hits } = withCard(approval({ verdicts: ["once", "always", "all-edits", "deny"] } as never));
  expect(hits.map((h) => h.index)).toEqual([0, 1, 2, 3]);
  expect(hits[2]!.rect.w).toBe(VERDICT_LABEL["all-edits"].length + 2);
});

test("no card, or a panel too small to paint one, yields no zones at all", () => {
  expect(cardHits(L.messages, makeState(), THEME)).toEqual([]);
  const s = makeState({ card: approval() });
  expect(cardHits({ x: 0, y: 0, w: 3, h: 2 }, s, THEME)).toEqual([]);
});

test("the verdict row survives clipping: a card taller than its slot keeps the buttons reachable", () => {
  // a long diff forces the card to clip from the top; the painter keeps the tail, so the buttons stay
  const detail = Array.from({ length: 200 }, (_, i) => `+ line ${i}`).join("\n");
  const { hits } = withCard(approval({ detail }));
  expect(hits.map((h) => h.index)).toEqual([0, 1, 2]);
  const m = L.messages;
  expect(hits[0]!.rect.y).toBeGreaterThanOrEqual(m.y);
  expect(hits[0]!.rect.y).toBeLessThan(m.y + m.h);
});

// ---------- question geometry ----------

test("a question card gives every option its own row, then free text, then skip", () => {
  const { hits } = withCard(question());
  expect(hits.map((h) => h.index)).toEqual([0, 1, 2, 3]); // sqlite, postgres, free text, skip
  const ys = hits.map((h) => h.rect.y);
  expect(ys).toEqual([...ys].sort((a, b) => a - b)); // top to bottom, one row each
  expect(new Set(ys).size).toBe(4);
  expect(hits[3]!.rect.w).toBe(SKIP_LABEL.length + 2);
});

test("the free-text row selects without answering; every button confirms", () => {
  const { hits } = withCard(question());
  expect(hits.map((h) => h.confirm)).toEqual([true, true, false, true]);
});

test("with free text disabled the skip row moves up and keeps the right index", () => {
  const { hits } = withCard(question({ prompt: { question: "q?", options: ["a"], allowFreeText: false } }));
  expect(hits.map((h) => h.index)).toEqual([0, 1]); // one option + skip
  expect(hits.map((h) => h.confirm)).toEqual([true, true]);
});

// ---------- the free-text answer wraps (Berkay: "yazi alt satira gecmesi gerekirken ... oluyor") ----------

test("a long typed answer wraps onto more rows: the card grows, skip moves down, the zone covers every row", () => {
  const short = withCard(question({ freeText: "sqlite" }));
  const long = withCard(question({ freeText: "I would rather we used postgres because the deployment target already runs it and the team knows it well " + "x".repeat(120) }));
  const shortSkip = short.hits.find((h) => h.index === 3)!, longSkip = long.hits.find((h) => h.index === 3)!;
  const shortFree = short.hits.find((h) => h.index === 2)!, longFree = long.hits.find((h) => h.index === 2)!;
  const shortOpt = short.hits.find((h) => h.index === 0)!, longOpt = long.hits.find((h) => h.index === 0)!;
  expect(shortFree.rect.h).toBe(1);
  expect(longFree.rect.h).toBeGreaterThan(1);
  // the card is pinned to the bottom of the messages area and grows UPWARD: skip stays put, the
  // rows above it climb by exactly the extra free-text rows
  expect(longSkip.rect.y).toBe(shortSkip.rect.y);
  expect(shortOpt.rect.y - longOpt.rect.y).toBe(longFree.rect.h - shortFree.rect.h);
  expect(longFree.rect.y + longFree.rect.h).toBe(longSkip.rect.y); // the zone reaches right up to skip
  expect(longFree.confirm).toBe(false);
});

test("the caret sits at the end of the LAST wrapped row, not clipped off the first", () => {
  const { s } = withCard(question({ freeText: "a long answer that certainly needs more than one row of the card " + "y".repeat(150), selected: 2 }));
  const c = promptCursor(L.messages, s)!;
  expect(c).not.toBeNull();
  const { hits } = withCard(s.card!);
  const free = hits.find((h) => h.index === 2)!;
  expect(c.y).toBe(free.rect.y + free.rect.h - 1);
  expect(c.x).toBeLessThan(L.messages.x + L.messages.w);
});

test("an answer longer than the row budget keeps its TAIL on screen, the way a chat box does", () => {
  const { s, hits } = withCard(question({ freeText: Array.from({ length: 40 }, (_, i) => `row ${i} of the answer`).join(" ") }));
  const free = hits.find((h) => h.index === 2)!;
  expect(free.rect.h).toBe(MAX_FREE_TEXT_ROWS);
  const rows = cardRows(s.card!, L.messages.w - 4, 5, THEME).map((r) => r.segs.map(([t]) => t).join(""));
  expect(rows.some((r) => r.includes("row 39 of the answer"))).toBe(true); // the end is visible
  expect(rows.some((r) => r.includes("row 0 of the answer"))).toBe(false);  // the head scrolled off
});

// ---------- the click actually resolves ----------

test("clicking `always` resolves the approval with always — not merely selecting it", () => {
  const answers: string[] = [];
  const s = makeState({ card: approval({ resolve: (v: string) => answers.push(v) } as never) });
  const spy = spyCtx(L);
  spy.ctx.hits = cardHits(L.messages, s, THEME).map((h) => ({
    rect: h.rect,
    onClick: () => { if (s.card) s.card.selected = h.index; },
    ...(h.confirm ? { key: { type: "key" as const, name: "enter" } } : {}),
  }));
  const target = spy.ctx.hits[1]!.rect; // `always`
  press(s, spy, mouse(0, target.x, target.y));
  expect(answers).toEqual(["always"]);
  expect(s.card).toBeNull(); // the card leaves the state when it resolves
});

test("clicking `deny` denies — the zone under the pointer decides, not the current selection", () => {
  const answers: string[] = [];
  const s = makeState({ card: approval({ selected: 0, resolve: (v: string) => answers.push(v) } as never) });
  const spy = spyCtx(L);
  spy.ctx.hits = cardHits(L.messages, s, THEME).map((h) => ({
    rect: h.rect,
    onClick: () => { if (s.card) s.card.selected = h.index; },
    ...(h.confirm ? { key: { type: "key" as const, name: "enter" } } : {}),
  }));
  const deny = spy.ctx.hits[2]!.rect;
  press(s, spy, mouse(0, deny.x + deny.w - 1, deny.y)); // the last cell of the button still counts
  expect(answers).toEqual(["deny"]);
});

test("clicking the free-text row moves the selection there and answers nothing", () => {
  const answers: unknown[] = [];
  const s = makeState({ card: question({ resolve: (v: unknown) => answers.push(v) }) });
  const spy = spyCtx(L);
  spy.ctx.hits = cardHits(L.messages, s, THEME).map((h) => ({
    rect: h.rect,
    onClick: () => { if (s.card) s.card.selected = h.index; },
    ...(h.confirm ? { key: { type: "key" as const, name: "enter" } } : {}),
  }));
  const free = spy.ctx.hits[2]!.rect;
  press(s, spy, mouse(0, free.x, free.y));
  expect(answers).toEqual([]);       // nothing submitted
  expect(s.card).not.toBeNull();     // the card is still open, waiting for typing
  expect((s.card as { selected: number }).selected).toBe(2);
});
