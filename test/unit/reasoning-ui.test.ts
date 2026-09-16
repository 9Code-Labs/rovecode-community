/** port #60 surface pins, rovecode's shape: reasoning renders as a COLLAPSED size, never the text. The
 *  deliberate difference from aion is in the event: rovecode's `reasoning_update` carries the CUMULATIVE
 *  `tokens`, not deltas (loop.ts drops the thinking text on purpose), so ReasoningViews takes the event's
 *  value rather than summing, and a view repaints through the optional `set` instead of appending. Pinned:
 *  one block per message, settled by the first text delta / turn_end / run_end; a renderer WITH
 *  beginReasoning gets cards and no notes, one WITHOUT gets exactly one collapsed note per block; other
 *  events are ignored. */

import { expect, test } from "bun:test";
import type { AssistantView } from "../../src/tui/renderer.ts";
import { collapsedReasoningLine, reasoningLabel, ReasoningViews } from "../../src/tui/reasoning-view.ts";

class NoteOnly { notes: string[] = []; addSystemNote(t: string): void { this.notes.push(t); } }
class WithCard extends NoteOnly {
  sets: string[] = []; dones = 0; begun = 0;
  beginReasoning(): AssistantView {
    this.begun++;
    return { append: () => {}, set: (c) => { this.sets.push(c); }, done: () => { this.dones++; } };
  }
}

test("ReasoningViews: a renderer WITH beginReasoning gets one card per message (repainted with the cumulative tokens, done() on the first text delta), no note", () => {
  const card = new WithCard();
  const v = new ReasoningViews(card);
  v.onEvent({ type: "run_start", runId: "r", sessionId: "s", goal: "g" });
  v.onEvent({ type: "reasoning_update", messageId: "m1", tokens: 4 });
  v.onEvent({ type: "reasoning_update", messageId: "m1", tokens: 11 });
  expect(card.begun).toBe(1);
  expect(card.sets).toEqual(["∴ reasoning · 4 tokens …", "∴ reasoning · 11 tokens …"]); // cumulative, not summed
  expect(card.dones).toBe(0);
  expect(v.openTokens).toBe(11);
  v.onEvent({ type: "message_update", messageId: "m1", delta: "text" });
  expect(card.dones).toBe(1);
  expect(v.openTokens).toBe(0);
  v.onEvent({ type: "message_update", messageId: "m1", delta: "more" }); // no open block: nothing happens
  expect(card.dones).toBe(1);
  expect(card.notes).toEqual([]);
});

test("a renderer WITHOUT beginReasoning gets exactly ONE collapsed note per block; turn_end and run_end settle a dangling one; a second message opens a NEW block", () => {
  const plain = new NoteOnly();
  const v = new ReasoningViews(plain);
  v.onEvent({ type: "reasoning_update", messageId: "m1", tokens: 7 });
  v.onEvent({ type: "reasoning_update", messageId: "m1", tokens: 9 });
  v.onEvent({ type: "message_update", messageId: "m1", delta: "answer" });
  expect(plain.notes).toEqual(["∴ reasoning · 9 tokens · collapsed"]);
  v.onEvent({ type: "reasoning_update", messageId: "m2", tokens: 3 });
  v.onEvent({ type: "reasoning_update", messageId: "m3", tokens: 5 }); // a new message settles m2's block first
  expect(plain.notes).toEqual(["∴ reasoning · 9 tokens · collapsed", "∴ reasoning · 3 tokens · collapsed"]);
  v.onEvent({ type: "run_end", status: "done", summary: "" });
  expect(plain.notes).toHaveLength(3); // m3's block settled, not dropped
});

test("reasoning never renders text — there is no text to render: the label is a count, the module keeps no string", () => {
  expect(reasoningLabel(0, true)).toBe("reasoning · 0 tokens …");
  expect(reasoningLabel(1234, false)).toBe("reasoning · 1234 tokens · collapsed");
  expect(collapsedReasoningLine(5)).toBe("  ∴ reasoning · 5 tokens · collapsed");
  // the same messageId after its block settled opens a fresh block (a second thinking pass), not a resurrection
  const card = new WithCard();
  const v = new ReasoningViews(card);
  v.onEvent({ type: "reasoning_update", messageId: "m1", tokens: 2 });
  v.onEvent({ type: "turn_end", turn: 1, stopReason: "end_turn" }); // settles (no text came)
  expect(card.begun).toBe(1);
  expect(card.dones).toBe(1);
  // the SAME messageId thinking again in the next turn opens a NEW block, not a resurrection of the old one
  v.onEvent({ type: "reasoning_update", messageId: "m1", tokens: 6 });
  expect(card.begun).toBe(2);
  v.onEvent({ type: "run_end", status: "done", summary: "" }); // the dangling block settles, never leaks
  expect(card.dones).toBe(2);
});
