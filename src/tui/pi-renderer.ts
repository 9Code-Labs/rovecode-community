/** PiTuiRenderer — the Renderer seam implemented over the vendored pi-tui library.
 *
 *  Wiring ported from upstream pi (earendil-works/pi, pinned 853a80d2):
 *    - chat layout / transcript splice-before-editor / loader-while-responding:
 *      packages/tui/test/chat-simple.ts (splice at children.length-1, editor last & focused)
 *    - CancellableLoader Escape-to-abort: packages/tui/src/components/cancellable-loader.ts
 *  Vendor quirk: TruncatedText has no setText (its text is private), so setStatus
 *  swaps the status-line instance in tui.children instead of mutating it.
 *
 *  Only this module, overlays.ts (card bodies) and theme.ts may import from vendor/pi-tui.
 */

import {
	CancellableLoader,
	CombinedAutocompleteProvider,
	type Component,
	Editor,
	Key,
	Markdown,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type Terminal,
	Text,
	TruncatedText,
	type TUI,
	TuiMainScreen,
} from "../../vendor/pi-tui/src/index.ts";
import type {
	ApprovalAnswer,
	AssistantView,
	PickItem,
	QuestionAnswer,
	QuestionPrompt,
	Renderer,
	RendererHooks,
	RendererStartOptions,
	SlashCommand,
	StatusInfo,
} from "./renderer.ts";
import { ApprovalCard, FREE_TEXT, QuestionCard, SKIP_QUESTION } from "./overlays.ts";
import { modeLabelShort } from "../core/voice.ts";
import { expandMentions, mentionsIn, splitAttached } from "../sextant/mentions.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rovecodeEditorTheme, rovecodeMarkdownTheme, rovecodeSelectListTheme, pal, st } from "./theme.ts";

/** Tool cards stay single-line: collapse whitespace and clip to ~120 columns. */
import { StagedTerminal } from "./staged-terminal.ts";

const CARD_MAX = 120;
function oneLine(text: string, max = CARD_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface ToolCard {
	line: Text;
	tool: string;
	base: string;
}

// requestRender() from seeding must not leak a frame while the loading intro still owns stdout.
class PreparingTui extends TuiMainScreen {
	private holding = true;
	override requestRender(force = false): void { if (!this.holding) super.requestRender(force); }
	reveal(): void { this.holding = false; this.start(); }
}

export interface PiTuiRendererOptions {
	/** Defaults to ProcessTerminal; tests inject a VirtualTerminal. */
	terminal?: Terminal;
	/** Working directory for file autocomplete; defaults to process.cwd(). */
	cwd?: string;
}

export class PiTuiRenderer implements Renderer {
	private readonly terminal: Terminal;
	private readonly cwd: string;
	private commands: SlashCommand[] = [];
	private tui: TUI | null = null;
	private editor: Editor | null = null;
	private statusLine: TruncatedText | null = null;
	private statusText = "";
	private loader: CancellableLoader | null = null;
	private hooks: RendererHooks | null = null;
	private unsubscribeInput: (() => void) | null = null;
	private readonly toolCards = new Map<string, ToolCard>();
	/** cancel thunks for overlays awaiting an answer; drained on stop() */
	private readonly pendingPickers = new Set<() => void>();

	constructor(opts?: PiTuiRendererOptions) {
		this.terminal = opts?.terminal ?? new ProcessTerminal();
		this.cwd = opts?.cwd ?? process.cwd();
	}
	private ui(): TUI {
		if (!this.tui) throw new Error("PiTuiRenderer: start() must be called first");
		return this.tui;
	}

	private requireEditor(): Editor {
		if (!this.editor) throw new Error("PiTuiRenderer: start() must be called first");
		return this.editor;
	}

	/** Children order: header … transcript … [loader] … editor … status line.
	 *  New transcript items land after existing ones: before the loader when busy,
	 *  otherwise directly before the editor (chat-simple.ts pattern). */
	private insertTranscript(component: Component): void {
		// after stop() (e.g. a run's finally block racing user exit) mutations are no-ops
		const tui = this.tui;
		const anchor = this.loader ?? this.editor;
		if (!tui || !anchor) return;
		const idx = tui.children.indexOf(anchor);
		tui.children.splice(idx < 0 ? tui.children.length : idx, 0, component);
		tui.requestRender();
	}

	start(hooks: RendererHooks, options?: RendererStartOptions): void | Promise<void> {
		if (this.tui) return;
		this.hooks = hooks;
		const staged = options?.beforeReveal ? new StagedTerminal(this.terminal) : undefined;
		const tui = staged ? new PreparingTui(staged) : new TuiMainScreen(this.terminal);
		this.tui = tui;

		// header banner
		tui.addChild(new Text(st.dim("rovecode"), 1, 0));

		// editor (kept just above the status line; transcript is spliced in before it)
		const editor = new Editor(tui, rovecodeEditorTheme);
		this.editor = editor;
		editor.onSubmit = (value: string) => {
			const text = value.trim();
			if (!text) return;
			// `@file` (sextant/mentions.ts): this editor's autocomplete offers files after `@`, so the mention must do
			// something here too. No file list on this surface, so a mention is the exact cwd-relative path — what
			// the autocomplete inserts. Every refusal and cap is said as a note, never swallowed.
			const mentions = mentionsIn(text);
			if (mentions.length === 0) { hooks.onSubmit(text); return; }
			const r = expandMentions(text, { cwd: this.cwd, mentions, resolve: (m) => (existsSync(join(this.cwd, m)) ? m.replace(/\\/g, "/") : null) });
			for (const n of r.notes) this.addSystemNote(n, "warn");
			hooks.onSubmit(r.text);
		};
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(this.commands, this.cwd));
		tui.addChild(editor);

		// status line (always last)
		const status = new TruncatedText(this.statusText, 1, 0);
		this.statusLine = status;
		tui.addChild(status);

		tui.setFocus(editor);

		// Input listeners run before the focused component (tui.ts handleTerminalInput),
		// so Ctrl+C always exits and Escape reaches the loader while the editor keeps focus.
		this.unsubscribeInput = tui.addInputListener((data) => {
			if (matchesKey(data, Key.ctrl("c"))) {
				hooks.onExit();
				return { consume: true };
			}
			if (this.loader && !tui.hasOverlay() && matchesKey(data, Key.escape)) {
				this.loader.handleInput(data); // abort → onAbort → hooks.onInterrupt()
				return { consume: true };
			}
			return undefined;
		});

		options?.beforeFirstRender?.();
		if (staged && tui instanceof PreparingTui && options?.beforeReveal) {
			staged.prepare(() => tui.renderNow(true));
			return options.beforeReveal().then(() => {
				if (this.tui !== tui) return; // cancelled while the intro was visible
				staged.prepare(() => tui.renderNow(true)); // latest terminal size, transcript and status
				staged.reveal(() => tui.reveal(), options.onReveal);
			});
		}
		options?.onReveal?.();
		tui.start();
	}

	stop(): void {
		const tui = this.tui;
		if (!tui) return;
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		if (this.unsubscribeInput) {
			this.unsubscribeInput();
			this.unsubscribeInput = null;
		}
		// an overlay that never gets an answer must not pin the process (or a caller
		// awaiting it) forever — a stopped UI cannot answer, so cancel them all
		for (const cancel of this.pendingPickers) cancel();
		this.pendingPickers.clear();
		tui.stop();
		this.tui = null;
		this.editor = null;
		this.statusLine = null;
		this.hooks = null;
		this.toolCards.clear();
	}

	setCommands(cmds: SlashCommand[]): void {
		this.commands = cmds.slice();
		if (this.editor) {
			this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(this.commands, this.cwd));
		}
	}

	addUser(text: string): void {
		// the typed line and one row per @file attached — the read blocks stay in the session, not on screen
		const { text: typed, files } = splitAttached(text);
		this.insertTranscript(new Text(st.dim("> ") + typed, 1, 0));
		for (const f of files) this.insertTranscript(new Text(st.dim(`  ▤ attached ${f}`), 1, 0));
	}

	addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void {
		const paint = tone === "warn" ? pal.warn : tone === "error" ? pal.err : pal.muted;
		this.insertTranscript(new Text(paint(text), 1, 0));
	}

	beginAssistant(): AssistantView {
		const tui = this.tui;
		if (!tui) return { append: () => {}, done: () => {} };
		const md = new Markdown("", 1, 1, rovecodeMarkdownTheme);
		this.insertTranscript(md);
		let buffer = "";
		return {
			append: (delta: string) => {
				buffer += delta;
				md.setText(buffer);
				tui.requestRender();
			},
			done: () => {
				/* buffer already flushed on each append */
			},
		};
	}

	toolStart(callId: string, tool: string, argsPreview: string): void {
		const base = oneLine(`→ ${tool} ${argsPreview}`);
		const line = new Text(st.dim(base), 1, 0);
		this.toolCards.set(callId, { line, tool, base });
		this.insertTranscript(line);
	}

	toolUpdate(callId: string, note: string): void {
		const card = this.toolCards.get(callId);
		if (!card) return;
		card.line.setText(st.dim(oneLine(`${card.base} · ${note}`)));
		this.tui?.requestRender();
	}

	toolEnd(callId: string, ok: boolean, outputPreview: string, durationMs: number): void {
		const card = this.toolCards.get(callId);
		if (!card) return;
		this.toolCards.delete(callId);
		const paint = ok ? pal.ok : pal.err;
		const verdict = ok ? "ok" : "FAIL";
		card.line.setText(paint(oneLine(`← ${verdict} ${card.tool} (${durationMs}ms) ${outputPreview}`)));
		this.tui?.requestRender();
	}

	/** Show `component` as a centered overlay whose keys route to `list`; settles on select,
	 *  cancel, or stop() (a stopped UI cannot answer — pendingPickers drains it to null). */
	private pickWith(component: Component, list: SelectList, width: number): Promise<string | null> {
		const tui = this.tui;
		const editor = this.editor;
		if (!tui || !editor) return Promise.resolve(null);
		return new Promise<string | null>((resolve) => {
			const handle = tui.showOverlay(component, { width, anchor: "center" });
			let settled = false;
			const finish = (answer: string | null): void => {
				if (settled) return;
				settled = true;
				this.pendingPickers.delete(cancel);
				handle.hide();
				if (this.tui) { tui.setFocus(editor); tui.requestRender(); }
				resolve(answer);
			};
			const cancel = () => finish(null);
			this.pendingPickers.add(cancel);
			list.onSelect = (item: SelectItem) => finish(item.value);
			list.onCancel = () => finish(null);
		});
	}

	pickOne(items: PickItem[], title?: string): Promise<string | null> {
		if (!this.tui || items.length === 0) return Promise.resolve(null);
		if (title) this.addSystemNote(title);
		const list = new SelectList(
			items.map((i) => ({ value: i.value, label: i.label, description: i.description })),
			Math.min(items.length, 8),
			rovecodeSelectListTheme,
		);
		return this.pickWith(list, list, 64);
	}

	async askApproval(tool: string, argsPreview: string, detail?: string): Promise<ApprovalAnswer> {
		this.addSystemNote(`approval needed: ${tool} ${argsPreview}`, "warn");
		const items: PickItem[] = [
			{ value: "once", label: "allow once", description: "run this call only" },
			{ value: "always", label: "always", description: "allow this tool for the session" },
			{ value: "deny", label: "deny", description: "reject this call" },
		];
		let picked: string | null;
		if (detail) {
			// port #24: the diff rides inside the overlay; same list, same keys as the plain path
			const list = new SelectList(items, items.length, rovecodeSelectListTheme);
			const card = new ApprovalCard(`approval needed: ${tool}`, detail.split("\n"), list, () => this.terminal.rows);
			picked = await this.pickWith(card, list, Math.max(40, Math.min(this.terminal.columns - 4, 100)));
		} else picked = await this.pickOne(items);
		return picked === "once" || picked === "always" ? picked : "deny"; // null/cancel/stop → deny
	}

	/** Port #33 question overlay, modal like approval (keys go to the card). Escape while a run is
	 *  in flight (loader showing) INTERRUPTS the run — stopping beats letting the model proceed
	 *  unanswered — and the run's abort signal then dismisses the card; Escape with no run (idle
	 *  caller) declines → null; inside the free-text input Escape steps back to the options. */
	askQuestion(q: QuestionPrompt, signal?: AbortSignal): Promise<QuestionAnswer | null> {
		const tui = this.tui;
		const editor = this.editor;
		if (!tui || !editor || signal?.aborted) return Promise.resolve(null); // nobody to ask / run already gone
		// concurrent-ask decision: ONE modal at a time — a second ask is a caller bug surfaced loudly, not queued
		if (tui.hasOverlay()) return Promise.reject(new Error("a question or approval overlay is already open"));
		const options = q.options ?? [];
		const freeText = q.allowFreeText !== false;
		const items: SelectItem[] = options.map((label, i) => ({ value: String(i), label }));
		if (freeText) items.push({ value: FREE_TEXT, label: "type an answer…" });
		items.push({ value: SKIP_QUESTION, label: "skip this question" }); // non-destructive decline → null; Escape on a busy run still stops the run
		const list = new SelectList(items, Math.max(1, items.length), rovecodeSelectListTheme);
		const card = new QuestionCard(q.question, list, options.length, freeText, () => this.terminal.rows, () => this.loader !== null);
		this.addSystemNote(`question: ${oneLine(q.question)}`, "warn"); // transcript record, like approvals
		return new Promise<QuestionAnswer | null>((resolve) => {
			const handle = tui.showOverlay(card, { width: Math.max(40, Math.min(this.terminal.columns - 4, 100)), anchor: "center" });
			let settled = false;
			const finish = (answer: QuestionAnswer | null): void => {
				if (settled) return;
				settled = true;
				this.pendingPickers.delete(cancel);
				signal?.removeEventListener("abort", cancel);
				handle.hide();
				if (this.tui) { tui.setFocus(editor); tui.requestRender(); }
				resolve(answer);
			};
			const cancel = () => finish(null);
			this.pendingPickers.add(cancel);
			signal?.addEventListener("abort", cancel, { once: true }); // the run's abort (port #21) dismisses the card
			const escape = () => { if (this.loader) this.hooks?.onInterrupt(); else finish(null); };
			list.onCancel = escape;
			list.onSelect = (item: SelectItem) => {
				if (item.value === SKIP_QUESTION) { finish(null); return; } // declined: the tool reports "user declined to answer"
				if (item.value === FREE_TEXT) { card.setTyping(true); tui.requestRender(); return; }
				const choice = Number(item.value);
				finish({ choice, label: options[choice] });
			};
			card.input.onEscape = () => { if (options.length > 0) { card.setTyping(false); tui.requestRender(); } else escape(); };
			card.input.onSubmit = (value: string) => { const text = value.trim(); if (text) finish({ text }); };
		});
	}

	/** Remove every transcript item (keep header, loader, editor, status) — history replay. */
	clearTranscript(): void {
		const tui = this.tui;
		const anchor = this.loader ?? this.editor;
		if (!tui || !anchor) return;
		const end = tui.children.indexOf(anchor);
		if (end > 1) tui.children.splice(1, end - 1); // index 0 = header banner
		this.toolCards.clear();
		tui.requestRender();
	}

	prefillEditor(text: string): void {
		const tui = this.tui;
		const editor = this.editor;
		if (!tui || !editor) return;
		editor.setText(text);
		tui.setFocus(editor);
		tui.requestRender();
	}

	setBusy(busy: boolean, label?: string): void {
		const tui = this.tui;
		if (!tui) { this.loader = null; return; }
		if (busy) {
			const message = label ?? "thinking…";
			if (this.loader) {
				this.loader.setMessage(message);
				return;
			}
			const loader = new CancellableLoader(tui, (s) => pal.accent(s), (s) => st.dim(s), message);
			loader.onAbort = () => { this.hooks?.onInterrupt(); };
			this.loader = loader;
			const anchor = this.editor;
			const idx = anchor ? tui.children.indexOf(anchor) : -1;
			tui.children.splice(idx < 0 ? tui.children.length : idx, 0, loader);
			loader.start();
			tui.requestRender();
		} else {
			const loader = this.loader;
			if (!loader) return;
			this.loader = null;
			loader.stop();
			const idx = tui.children.indexOf(loader);
			if (idx >= 0) tui.children.splice(idx, 1);
			tui.requestRender();
		}
	}

	setStatus(info: StatusInfo): void {
		const gate = modeLabelShort(info.yolo); // "ask first" | "auto" — the flags keep their names
		const mode = info.mode ? `${info.mode} · ` : ""; // port #20 mode indicator
		this.statusText = st.dim(
			`${mode}${info.provider}/${info.model} · ${gate} · turns ${info.turns} · tokens ${info.tokensIn}/${info.tokensOut}${info.todos ? ` · ${info.todos}` : ""}`, // port #32 todo progress
		);
		const tui = this.tui;
		if (!tui || !this.statusLine) return; // applied at start()
		// vendor quirk: TruncatedText has no setText — swap the instance in place.
		const next = new TruncatedText(this.statusText, 1, 0);
		const idx = tui.children.indexOf(this.statusLine);
		if (idx >= 0) tui.children.splice(idx, 1, next);
		else tui.children.push(next);
		this.statusLine = next;
		tui.requestRender();
	}
}
