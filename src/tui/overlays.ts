/** Overlay bodies for PiTuiRenderer: the port #24 approval diff card and the port #33 question
 *  card. Each is a pi-tui Component that routes keys to the SelectList (or Input) it wraps, so
 *  the renderer's overlay lifecycle (show → settle → hide → refocus editor) is shared and the
 *  wrapped list's bindings are untouched. Only pi-renderer.ts, this module and theme.ts may
 *  import from vendor/pi-tui. */

import {
	type Component,
	Input,
	type SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../vendor/pi-tui/src/index.ts";
import { pal, st } from "./theme.ts";

/** One overlay row: leading space, clipped to width-2, padded so the right gutter stays clean. */
export function fitLine(s: string, width: number): string {
	const t = truncateToWidth(s, width - 2, "…");
	return ` ${t}${" ".repeat(Math.max(0, width - 1 - visibleWidth(t)))}`;
}

/** Port #24: body of an edit/write approval overlay — title, the bounded unified diff
 *  (+ green, - red, headers/@@ dim), a spacer, then the verdict list. Keys go straight
 *  to the list, so verdicts and bindings are identical to the plain approval overlay. */
const MORE_RE = /^… \+(\d+) more line/;
export class ApprovalCard implements Component {
	constructor(
		private readonly title: string,
		private readonly diff: string[],
		private readonly list: SelectList,
		private readonly rows: () => number,
	) {}
	handleInput(data: string): void { this.list.handleInput(data); }
	invalidate(): void { this.list.invalidate(); }
	render(width: number): string[] {
		// physical bound: title, list and some transcript must stay visible. previewDiff already
		// clipped logically — fold its marker's count into ours rather than stacking two markers.
		const max = Math.max(4, this.rows() - 12);
		let lines = this.diff;
		if (lines.length > max) {
			const tail = MORE_RE.exec(lines[lines.length - 1]!);
			const hidden = lines.length - max + (tail ? Number(tail[1]) - 1 : 0);
			lines = [...lines.slice(0, max), `… +${hidden} more line${hidden === 1 ? "" : "s"}`];
		}
		return [fitLine(pal.warn(this.title), width), ...lines.map((l, i) => fitLine(paintDiff(l, i), width)), " ".repeat(width), ...this.list.render(width)];
	}
}

function paintDiff(line: string, idx: number): string {
	if ((idx === 0 && line.startsWith("--- ")) || (idx === 1 && line.startsWith("+++ "))) return st.dim(line);
	const c = line[0];
	return c === "+" ? pal.ok(line) : c === "-" ? pal.err(line) : c === " " ? line : st.dim(line);
}

/** SelectList value of the "type an answer…" entry — can never collide with an option index. */
export const FREE_TEXT = "\u0000free-text";

/** SelectList value of the "skip this question" entry: the NON-destructive decline (resolves null →
 *  the tool reports "user declined to answer"), so a busy run — where Escape means "stop the run" —
 *  can still be left unanswered without killing it (port #33 critic LOW). Same escape idiom as
 *  FREE_TEXT: an option index can never look like this. */
export const SKIP_QUESTION = "\u0000skip-question";

/** Port #33: body of a question overlay — title, the wrapped question (bounded by the terminal),
 *  a spacer, then either the option list (options + the free-text entry + skip) or a one-line
 *  Input for a typed answer, each with a key hint. Keys route to whichever is active; the renderer
 *  wires the list/input callbacks (select, submit, escape) and flips `typing`. */
export class QuestionCard implements Component {
	private typing: boolean;
	readonly input = new Input();
	constructor(
		private readonly question: string,
		private readonly list: SelectList,
		private readonly optionCount: number,
		private readonly freeText: boolean,
		private readonly rows: () => number,
		/** true while a run is in flight — decides what Escape means in the hint */
		private readonly busy: () => boolean,
	) { this.typing = optionCount === 0; } // no options: straight to the input
	get isTyping(): boolean { return this.typing; }
	setTyping(on: boolean): void { this.typing = on; }
	handleInput(data: string): void { if (this.typing) this.input.handleInput(data); else this.list.handleInput(data); }
	invalidate(): void { this.list.invalidate(); this.input.invalidate(); }
	render(width: number): string[] {
		const bodyRows = this.typing ? 1 : this.optionCount + (this.freeText ? 1 : 0) + 1; // + the skip entry
		// physical bound: title, body, hint and some transcript must stay visible
		const max = Math.max(2, this.rows() - 9 - bodyRows);
		let lines = wrapTextWithAnsi(this.question, width - 2);
		if (lines.length > max) lines = [...lines.slice(0, max - 1), st.dim(`… +${lines.length - max + 1} more lines`)];
		const esc = this.busy() ? "Esc stop the run" : "Esc skip";
		const body = this.typing
			? [fitLine(this.input.render(width - 2)[0] ?? "", width), fitLine(st.dim(this.optionCount > 0 ? "Enter sends · Esc back to the options" : `Enter sends · ${esc}`), width)]
			: [...this.list.render(width), fitLine(st.dim(`↑↓ choose · Enter answer · ${esc}`), width)];
		return [fitLine(pal.warn("question"), width), ...lines.map((l) => fitLine(l, width)), " ".repeat(width), ...body];
	}
}
