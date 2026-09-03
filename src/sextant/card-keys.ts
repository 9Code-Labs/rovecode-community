/** Sextant card keys (port #43): the key route of the ONE modal card — ←→↑↓ (and Tab) move the
 *  selection, Enter resolves it (approval: once / always / deny; question: an option, the free-text
 *  row or skip), Esc dismisses (deny / null) and the free-text row takes typing and Backspace.
 *  Ported from the user's own sextant v0.4.0 prototype app.js:1503-1510 and :1434; split out of
 *  keys.ts for the line budget. Pure state mutation, no clock: the card leaves the state before
 *  its promise settles, so a re-entrant hook never sees a stale card. */

import type { CardState, KeyEvent, SextantState } from "./types.ts";

/** false = not a card key: it falls through to the prompt (typing a follow-up while a card waits) */
export function onCardKey(s: SextantState, c: CardState, ev: KeyEvent): boolean {
  const { name } = ev;
  const n = c.kind === "approval" ? c.verdicts.length // allow · always · [all edits] · deny
    : (c.prompt.options?.length ?? 0) + (c.prompt.allowFreeText !== false ? 1 : 0) + 1; // options · free text · skip
  if (name === "left" || name === "up") return move(c, n, -1);
  if (name === "right" || name === "down" || name === "tab") return move(c, n, 1);
  if (name === "escape") { dismissCard(s); return true; }
  if (c.kind === "approval") {
    if (name !== "enter") return false;
    s.card = null;
    c.resolve(c.verdicts[c.selected] ?? "deny");
    return true;
  }
  const opts = c.prompt.options?.length ?? 0, freeIdx = c.prompt.allowFreeText !== false ? opts : -1;
  if (name === "enter") {
    if (c.selected === n - 1) { dismissCard(s); return true; } // skip
    if (c.selected !== freeIdx) { s.card = null; c.resolve({ kind: "option", index: c.selected }); return true; }
    const t = c.freeText.trim();
    if (t) { s.card = null; c.resolve({ kind: "text", text: t }); }
    return true; // an empty free-text row is not an answer yet
  }
  if (c.selected !== freeIdx) return false;
  if (name === "backspace") { // by code point: 😀 is one glyph, two UTF-16 units
    c.freeText = [...c.freeText].slice(0, -1).join("");
    return true;
  }
  const ch = name === "space" ? " " : ev.ch;
  if (!ch || ev.alt) return false;
  c.freeText += ch;
  return true;
}

/** wrap the selection over the card's n rows */
function move(c: CardState, n: number, d: -1 | 1): true {
  const v = (c.selected + d + n) % n;
  c.selected = v;
  return true;
}

/** approval → deny, question → null; the card leaves the state before the promise settles */
export function dismissCard(s: SextantState): void {
  const c = s.card;
  s.card = null;
  if (c?.kind === "approval") c.resolve("deny"); else c?.resolve(null);
}
