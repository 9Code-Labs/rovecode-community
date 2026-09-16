/** Reasoning blocks on the interactive surfaces (port #60): the app's per-message bookkeeping between
 *  `reasoning_update` events and a Renderer — ONE collapsed block per assistant message, opened on the
 *  turn's first reasoning event, settled when the message's text starts, the turn ends or the run ends.
 *  A renderer with `beginReasoning` (the classic card) gets the settle; one without gets a single system
 *  note carrying the collapsed label once the block settles.
 *
 *  THE DELIBERATE DIFFERENCE FROM AION: rovecode's reasoning_update carries `tokens`, never text —
 *  the loop drops the thinking text on purpose ("only its estimated size leaves the loop", loop.ts:272),
 *  so there is nothing to append and this module counts tokens instead of characters. The property that
 *  matters survives the translation: the thinking text is never rendered and never kept here.
 *  `reasoningLabel` is the ONE wording every surface prints (the classic card, the fallback note).
 *  Pure: no clock, no timers, no process. */

import type { RunEvent } from "../core/types.ts";
import type { AssistantView, Renderer } from "./renderer.ts";

/** `reasoning · 1234 tokens …` while streaming, `reasoning · 1234 tokens · collapsed` once settled */
export function reasoningLabel(tokens: number, streaming: boolean): string {
  return `reasoning · ${tokens} tokens${streaming ? " …" : " · collapsed"}`;
}

/** the `--plain` REPL's one line per block (printed when the message's text starts or the turn ends) */
export function collapsedReasoningLine(tokens: number): string {
  return `  ∴ ${reasoningLabel(tokens, false)}`;
}

interface OpenBlock { id: string; view: AssistantView | null; tokens: number }

export class ReasoningViews {
  private open: OpenBlock | null = null;
  constructor(private readonly renderer: Pick<Renderer, "addSystemNote" | "beginReasoning">) {}

  /** feed every RunEvent of the live run (app.ts: right after renderer.onEvent, before the per-event calls).
   *  `reasoning_update.tokens` is CUMULATIVE for the message (a dropped event costs nothing), so the block
   *  takes the event's value rather than summing. */
  onEvent(ev: RunEvent): void {
    if (ev.type === "reasoning_update") {
      if (this.open && this.open.id !== ev.messageId) this.settle();
      if (!this.open) this.open = { id: ev.messageId, view: this.renderer.beginReasoning?.() ?? null, tokens: 0 };
      this.open.tokens = Math.max(this.open.tokens, ev.tokens);
      this.open.view?.set?.(`∴ ${reasoningLabel(this.open.tokens, true)}`);
    } else if (ev.type === "message_update" || ev.type === "turn_end" || ev.type === "run_end") this.settle();
  }

  /** the open block (if any) is done: the card settles, or the fallback note lands */
  settle(): void {
    const o = this.open;
    if (!o) return;
    this.open = null;
    if (o.view) o.view.done();
    else this.renderer.addSystemNote(`∴ ${reasoningLabel(o.tokens, false)}`);
  }

  /** tokens of the block still open (tests) */
  get openTokens(): number { return this.open?.tokens ?? 0; }
}
