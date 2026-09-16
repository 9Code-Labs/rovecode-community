/** Sextant cards (port #44): the modal seams of the Renderer — the approval card (once / always /
 *  deny), the ask_user question card (options / free text / skip, dismissed by the run's abort signal)
 *  and the pickOne picker (the #43 palette with `pick:<value>` rows: Enter resolves the fuzzy-selected
 *  row, Esc / ⌃k / ⌃p / a click outside resolves null). ONE card at a time: a second approval waits
 *  for the first to settle, a second concurrent question is rejected (renderer.ts contract), a new
 *  picker cancels the previous one; settleAll() (renderer stop) resolves everything with deny / null so
 *  no awaiting caller is ever pinned. keys.ts owns the key handling (onCardKey / onPaletteKey) and
 *  nulls s.card before calling resolve — this class only owns the promises and the state hand-off. */

import type { ApprovalAnswer, PickItem, QuestionAnswer, QuestionPrompt } from "../tui/renderer.ts";
import { fuzzy } from "./engine.ts";
import { closePalette, openPalette, paletteVisible } from "./overlays.ts";
import type { CardState, InputEvent, SextantState } from "./types.ts";
import { notify } from "./model.ts";

/** palette action prefix of a picker row; the value follows verbatim (it may contain ":") */
export const PICK = "pick:";

export interface CardHostDeps {
  state: SextantState;
  /** request a repaint */
  dirty(): void;
  /** the renderer stopped: a card opened now resolves its fallback at once */
  stopped(): boolean;
  /** an approval card opened / was allowed (the pet's permission / allowed quips) */
  onApprovalOpen?(): void;
  onAllowed?(): void;
  /** the surface clock, for the "needs you" notice a card raises (model.ts notify); Date.now() when absent */
  clock?(): number;
}

/** tools whose approval card offers the accept-edits door */
const EDIT_TOOLS = new Set(["edit", "write"]);

export class CardHost {
  /** cancel thunks of every open or queued card and the picker */
  private readonly pending = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private picker: ((v: string | null) => void) | null = null;

  constructor(private readonly d: CardHostDeps) {}

  /** settle everything with its fallback (deny / null) */
  settleAll(): void { for (const cancel of [...this.pending]) cancel(); }
  get pickerOpen(): boolean { return this.picker !== null; }

  approval(tool: string, argsPreview: string, detail: string | undefined): Promise<ApprovalAnswer> {
    return this.enqueue<ApprovalAnswer>("deny", (settle) => {
      this.d.onApprovalOpen?.();
      // the `all edits` door is offered only where it means something: a write/edit card. On a bash or
      // a network card it would read as "allow everything", which is what auto mode is for.
      const verdicts: readonly ApprovalAnswer[] = EDIT_TOOLS.has(tool)
        ? ["once", "always", "all-edits", "deny"]
        : ["once", "always", "deny"];
      const card: CardState = { kind: "approval", tool, argsPreview, verdicts, selected: 0, resolve: (a) => { if (a !== "deny") this.d.onAllowed?.(); settle(a); } };
      if (detail) card.detail = detail;
      return card;
    });
  }

  /** cards open ONE at a time: the next waits for the current to settle */
  private enqueue<T>(fallback: T, make: (settle: (v: T) => void) => CardState): Promise<T> {
    return new Promise<T>((resolve) => {
      const open = (): Promise<void> => new Promise<void>((done) => {
        if (this.d.stopped()) { resolve(fallback); done(); return; }
        let card: CardState | null = null, settled = false;
        const settle = (v: T): void => {
          if (settled) return;
          settled = true; this.pending.delete(cancel);
          if (card && this.d.state.card === card) this.d.state.card = null;
          this.d.dirty(); resolve(v); done();
        };
        const cancel = (): void => settle(fallback);
        this.pending.add(cancel);
        card = make(settle);
        this.d.state.card = card; notify(this.d.state, "tool" in card ? `needs you: ${card.tool}` : "needs you: a question", this.d.clock?.() ?? Date.now(), "warn", "approval"); this.d.dirty();
      });
      this.queue = this.queue.then(open, open);
    });
  }

  /** the question card; `signal` abort dismisses it (null); a SECOND concurrent ask is rejected */
  question(q: QuestionPrompt, signal?: AbortSignal): Promise<QuestionAnswer | null> {
    if (this.d.stopped() || signal?.aborted) return Promise.resolve(null);
    if (this.d.state.card) return Promise.reject(new Error("a question or approval card is already open"));
    return new Promise((resolve) => {
      let settled = false;
      const settle = (a: QuestionAnswer | null): void => {
        if (settled) return;
        settled = true; this.pending.delete(cancel); signal?.removeEventListener("abort", cancel);
        if (this.d.state.card === card) this.d.state.card = null;
        this.d.dirty(); resolve(a);
      };
      const cancel = (): void => settle(null);
      const card: CardState = {
        kind: "question", prompt: q, selected: 0, freeText: "",
        resolve: (a) => settle(a === null ? null : a.kind === "option" ? { choice: a.index, label: q.options?.[a.index] } : { text: a.text }),
      };
      this.pending.add(cancel); signal?.addEventListener("abort", cancel, { once: true });
      this.d.state.card = card; notify(this.d.state, "tool" in card ? `needs you: ${card.tool}` : "needs you: a question", this.d.clock?.() ?? Date.now(), "warn", "approval"); this.d.dirty();
    });
  }

  /** the palette as a picker: items become `pick:<value>` rows under `title` */
  pick(items: PickItem[], title?: string): Promise<string | null> {
    if (this.d.stopped() || items.length === 0) return Promise.resolve(null);
    this.picker?.(null);
    return new Promise((resolve) => {
      const s = this.d.state;
      // the title is the BOX's, not a group row: as a group it was painted unclipped inside the list
      // and ran past the border. Rows keep one short group so the list has no repeated header.
      openPalette(s, items.map((i) => ({
        label: i.description ? `${i.label} · ${i.description}` : i.label, group: "", action: PICK + i.value,
        ...(i.description !== undefined ? { hint: i.description } : {}),
      })), title ?? "pick one");
      const settle = (v: string | null): void => {
        if (this.picker !== settle) return;
        this.picker = null; this.pending.delete(cancel);
        if (s.palette?.items.some((it) => it.action.startsWith(PICK))) closePalette(s);
        this.d.dirty(); resolve(v);
      };
      const cancel = (): void => settle(null);
      this.picker = settle; this.pending.add(cancel); this.d.dirty();
    });
  }

  /** Enter / Esc while the picker's palette is open — true = swallowed (keys.ts must not see them) */
  interceptKey(ev: InputEvent): boolean {
    const s = this.d.state;
    if (!this.picker || !s.palette || ev.type !== "key" || ev.ctrl) return false;
    if (ev.name === "enter") {
      const it = paletteVisible(s.palette, fuzzy)[s.palette.sel];
      this.picker(it && it.action.startsWith(PICK) ? it.action.slice(PICK.length) : null);
      return true;
    }
    if (ev.name === "escape") { this.picker(null); return true; }
    return false;
  }

  /** after keys.handleInput: ⌃k / ⌃p / a click outside closed the palette → the picker resolves null */
  afterKey(): void { if (this.picker && !this.d.state.palette) this.picker(null); }
}
