/** Chat text selection: drag over the messages panel, release, and the dragged text is on the
 *  clipboard. The chat must be copyable the way any terminal is — no mode, no permission, no
 *  /mouse off ritual first (Berkay, 2026-09-20). The app owns the mouse (clicks, wheel and the
 *  scrollbars need mouse reporting, and reporting is exactly what kills the terminal's native
 *  selection), so the gesture lives here instead:
 *
 *  - a left press inside the messages panel is HELD, not forwarded;
 *  - released without moving, it is replayed verbatim, so every click keeps working — it just
 *    fires on release, the way a terminal fires a link click;
 *  - dragged, it becomes a screen-space selection over the panel, painted as a tint rect;
 *  - on release the selected cells are read back from the last painted frame and written to the
 *    clipboard as OSC 52 — the escape every modern terminal (Windows Terminal included) reads as
 *    "put this base64 on the clipboard". A toast says what happened; the transcript is untouched.
 *
 *  Deliberately screen-space: what you see is what you copy (clipped to the panel's inner rect,
 *  trailing blanks trimmed, blank head/tail rows dropped). Modal cards and open overlays keep
 *  their own clicks (the gesture stands down), and a scrollbar-thumb press stays keys.ts's grab. */

import { mouseKind } from "./input.ts";
import { notify } from "./model.ts";
import type { HitZone, MouseEvent, Rect, SextantState } from "./types.ts";

export interface SelectionDeps {
  state: SextantState;
  /** the messages panel rect of the current layout */
  messagesRect(): Rect;
  /** the frame's hit zones (a press on a grabbable one — a scrollbar thumb — is not ours) */
  hits(): readonly HitZone[];
  /** the last painted frame as text, or null before the first paint */
  screenText(): string | null;
  /** raw terminal write (the OSC 52 sequence) */
  write(seq: string): void;
  markDirty(): void;
  /** replay a held press through the normal input pipeline (a click that never became a drag) */
  forward(ev: MouseEvent, now: number): void;
}

interface Sel { x0: number; y0: number; x1: number; y1: number }

const inside = (x: number, y: number, r: Rect): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** normalized (x0≤x1, y0≤y1), clamped to the panel's inner rect (inside the border) */
function clampSel(a: { x: number; y: number }, b: { x: number; y: number }, r: Rect): Sel {
  const ix0 = r.x + 1, ix1 = r.x + r.w - 2, iy0 = r.y + 1, iy1 = r.y + r.h - 2;
  const cx = (x: number): number => Math.min(ix1, Math.max(ix0, x));
  const cy = (y: number): number => Math.min(iy1, Math.max(iy0, y));
  const x0 = cx(Math.min(a.x, b.x)), x1 = cx(Math.max(a.x, b.x));
  const y0 = cy(Math.min(a.y, b.y)), y1 = cy(Math.max(a.y, b.y));
  return { x0, y0, x1, y1 };
}

export class TextSelection {
  private sel: Sel | null = null;
  private pending: MouseEvent | null = null;
  /** the press point a live drag is anchored to (screen coords); sel is re-normalized from it on every move */
  private anchor: { x: number; y: number } | null = null;

  constructor(private readonly d: SelectionDeps) {}

  /** a selection is on screen (the frame loop cancels it on any key) */
  get active(): boolean { return this.sel !== null; }

  cancel(): void { this.sel = null; this.pending = null; this.anchor = null; }

  /** true = the gesture owns this mouse event; the caller must NOT forward it to keys.ts */
  onMouseEvent(ev: MouseEvent, now: number): boolean {
    const kind = mouseKind(ev);
    if (kind === "wheel-up" || kind === "wheel-down") { this.pending = null; return false; }
    if (this.pending === null && this.sel === null) {
      const r = this.d.messagesRect();
      if (kind !== "click" || !inside(ev.x, ev.y, r)) return false;
      const s = this.d.state;
      // modals and overlays keep their own clicks; a thumb grab stays the scrollbar's
      if (s.card !== null || s.palette !== null || s.market !== null || s.context !== null || s.help) return false;
      if (this.d.hits().some((z) => z.onDrag !== undefined && inside(ev.x, ev.y, z.rect))) return false;
      this.pending = ev;
      return true;
    }
    if (kind === "drag") {
      const r = this.d.messagesRect();
      if (this.pending !== null) { this.anchor = { x: this.pending.x, y: this.pending.y }; this.pending = null; }
      if (this.anchor === null) return false; // a drag belonging to a grab keys.ts owns (a scrollbar thumb)
      this.sel = clampSel(this.anchor, ev, r);
      this.d.markDirty();
      return true;
    }
    if (kind === "release") {
      if (this.pending !== null) { const p = this.pending; this.pending = null; this.d.forward(p, now); return true; }
      if (this.sel !== null) { this.copy(now); this.sel = null; this.anchor = null; this.d.markDirty(); return true; }
    }
    // any other press (right button, modifiers) mid-gesture: abandon it, own nothing
    this.pending = null;
    return false;
  }

  /** the tint rect for this frame (clipped to the panel interior), null = nothing selected */
  highlight(): { x: number; y: number; w: number; h: number } | null {
    const sel = this.sel;
    if (sel === null) return null;
    return { x: sel.x0, y: sel.y0, w: sel.x1 - sel.x0 + 1, h: sel.y1 - sel.y0 + 1 };
  }

  /** the selected cells of the last painted frame, one line per row, blanks trimmed */
  selectedText(): string {
    const sel = this.sel, text = this.d.screenText();
    if (sel === null || text === null) return "";
    const lines = text.split("\n");
    const out: string[] = [];
    for (let y = sel.y0; y <= sel.y1; y++) {
      out.push([...(lines[y] ?? "")].slice(sel.x0, sel.x1 + 1).join("").replace(/\s+$/, ""));
    }
    while (out.length > 0 && out[0]!.trim() === "") out.shift();
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    return out.join("\n");
  }

  private copy(now: number): void {
    const text = this.selectedText();
    if (text === "") return;
    this.d.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    notify(this.d.state, `copied ${[...text].length} characters to the clipboard`, now);
  }
}
