/** PiTuiRenderer — the Renderer seam implemented over the vendored pi-tui library.
 *
 *  Wiring ported from upstream pi (earendil-works/pi, pinned 853a80d2):
 *    - chat layout / transcript splice-before-editor / loader-while-responding:
 *      packages/tui/test/chat-simple.ts (splice at children.length-1, editor last & focused)
 *    - CancellableLoader Escape-to-abort: packages/tui/src/components/cancellable-loader.ts
 *  Vendor quirk: TruncatedText has no setText (its text is private), so setStatus
 *  swaps the status-line instance in tui.children instead of mutating it.
 *
 *  Only this module (and theme.ts) may import from vendor/pi-tui.
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
	Renderer,
	RendererHooks,
	SlashCommand,
	StatusInfo,
} from "./renderer.ts";
import { aionEditorTheme, aionMarkdownTheme, aionSelectListTheme, pal, st } from "./theme.ts";

/** Tool cards stay single-line: collapse whitespace and clip to ~120 columns. */
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
		const tui = this.ui();
		const anchor: Component = this.loader ?? this.requireEditor();
		const idx = tui.children.indexOf(anchor);
		tui.children.splice(idx < 0 ? tui.children.length : idx, 0, component);
		tui.requestRender();
	}

	start(hooks: RendererHooks): void {
		if (this.tui) return;
		this.hooks = hooks;
		const tui: TUI = new TuiMainScreen(this.terminal);
		this.tui = tui;

		// header banner
		tui.addChild(new Text(st.dim("aion"), 1, 0));

		// editor (kept just above the status line; transcript is spliced in before it)
		const editor = new Editor(tui, aionEditorTheme);
		this.editor = editor;
		editor.onSubmit = (value: string) => {
			const text = value.trim();
			if (!text) return;
			hooks.onSubmit(text);
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
		this.insertTranscript(new Text(st.dim("> ") + text, 1, 0));
	}

	addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void {
		const paint = tone === "warn" ? pal.warn : tone === "error" ? pal.err : pal.muted;
		this.insertTranscript(new Text(paint(text), 1, 0));
	}

	beginAssistant(): AssistantView {
		const tui = this.ui();
		const md = new Markdown("", 1, 1, aionMarkdownTheme);
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
		this.ui().requestRender();
	}

	toolEnd(callId: string, ok: boolean, outputPreview: string, durationMs: number): void {
		const card = this.toolCards.get(callId);
		if (!card) return;
		this.toolCards.delete(callId);
		const paint = ok ? pal.ok : pal.err;
		const verdict = ok ? "ok" : "FAIL";
		card.line.setText(paint(oneLine(`← ${verdict} ${card.tool} (${durationMs}ms) ${outputPreview}`)));
		this.ui().requestRender();
	}

	askApproval(tool: string, argsPreview: string): Promise<ApprovalAnswer> {
		const tui = this.ui();
		const editor = this.requireEditor();
		this.addSystemNote(`approval needed: ${tool} ${argsPreview}`, "warn");
		return new Promise<ApprovalAnswer>((resolve) => {
			const items: SelectItem[] = [
				{ value: "allow-once", label: "allow once", description: "run this call only" },
				{ value: "always", label: "always", description: "allow this tool for the session" },
				{ value: "deny", label: "deny", description: "reject this call" },
			];
			const list = new SelectList(items, 3, aionSelectListTheme);
			const handle = tui.showOverlay(list, { width: 40, anchor: "center" });
			let settled = false;
			const finish = (answer: ApprovalAnswer): void => {
				if (settled) return;
				settled = true;
				handle.hide();
				tui.setFocus(editor);
				tui.requestRender();
				resolve(answer);
			};
			list.onSelect = (item: SelectItem) => {
				finish(item.value === "always" ? "always" : item.value === "deny" ? "deny" : "once");
			};
			list.onCancel = () => finish("deny");
		});
	}

	setBusy(busy: boolean, label?: string): void {
		const tui = this.ui();
		if (busy) {
			const message = label ?? "thinking…";
			if (this.loader) {
				this.loader.setMessage(message);
				return;
			}
			const loader = new CancellableLoader(
				tui,
				(s) => pal.accent(s),
				(s) => st.dim(s),
				message,
			);
			loader.onAbort = () => {
				this.hooks?.onInterrupt();
			};
			this.loader = loader;
			const idx = tui.children.indexOf(this.requireEditor());
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
		const gate = info.yolo ? "yolo" : "gated";
		this.statusText = st.dim(
			`${info.provider}/${info.model} · ${gate} · turns ${info.turns} · tokens ${info.tokensIn}/${info.tokensOut}`,
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
