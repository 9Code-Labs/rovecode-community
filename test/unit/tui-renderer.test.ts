/** PiTuiRenderer unit tests, driven through pi-tui's VirtualTerminal (xterm/headless).
 *  Assertion patterns ported from upstream pi: stripAnsi + substring checks from
 *  packages/tui/test/markdown.test.ts, virtual-terminal harness from test/editor.test.ts,
 *  render settling via VirtualTerminal.waitForRender (test/virtual-terminal.ts). */

import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import type { RendererHooks } from "../../src/tui/renderer.ts";
import type { Terminal } from "../../vendor/pi-tui/src/index.ts";
// isNativeModifierPressed is NOT re-exported through vendor index.ts — import the file directly.
import { isNativeModifierPressed } from "../../vendor/pi-tui/src/native-modifiers.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

const sleepP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** House hazard: an await with no pending timer hangs the runner — probes that could hang ride a deadline. */
function deadline<T>(p: Promise<T>, ms = 3000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bomb = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms); });
	return Promise.race([p, bomb]).finally(() => { if (timer) clearTimeout(timer); });
}
/** "settled" | "pending" snapshot of a promise after a short beat (asserting something did NOT resolve). */
const stateOf = (p: Promise<unknown>): Promise<string> => Promise.race([p.then(() => "settled", () => "settled"), sleepP(60).then(() => "pending")]);

/** Terminal delegate that records every write() payload (for redraw assertions). */
class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	constructor(private readonly inner: VirtualTerminal) {}
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}
	stop(): void {
		this.inner.stop();
	}
	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.inner.drainInput(maxMs, idleMs);
	}
	write(data: string): void {
		this.writes.push(data);
		this.inner.write(data);
	}
	get columns(): number {
		return this.inner.columns;
	}
	get rows(): number {
		return this.inner.rows;
	}
	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}
	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}
	hideCursor(): void {
		this.inner.hideCursor();
	}
	showCursor(): void {
		this.inner.showCursor();
	}
	clearLine(): void {
		this.inner.clearLine();
	}
	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}
	clearScreen(): void {
		this.inner.clearScreen();
	}
	setTitle(title: string): void {
		this.inner.setTitle(title);
	}
	setProgress(active: boolean): void {
		this.inner.setProgress(active);
	}
}

function stubHooks(overrides: Partial<RendererHooks> = {}): RendererHooks {
	return {
		onSubmit: () => {},
		onInterrupt: () => {},
		onExit: () => {},
		...overrides,
	};
}

let active: PiTuiRenderer[] = [];

function boot(hooks: RendererHooks = stubHooks(), terminal?: Terminal): {
	renderer: PiTuiRenderer;
	term: VirtualTerminal;
} {
	const term = new VirtualTerminal(80, 24);
	const renderer = new PiTuiRenderer({ terminal: terminal ?? term, cwd: process.cwd() });
	renderer.setCommands([
		{ name: "help", description: "show help" },
		{ name: "model", description: "switch model" },
	]);
	renderer.start(hooks);
	active.push(renderer);
	return { renderer, term };
}

async function view(term: VirtualTerminal): Promise<string> {
	await term.waitForRender();
	return (await term.flushAndGetViewport()).map(stripAnsi).join("\n");
}

afterEach(() => {
	for (const r of active) r.stop();
	active = [];
});

describe("PiTuiRenderer", () => {
	it("streams markdown and redraws differentially (no clear-screen on small appends)", async () => {
		const inner = new VirtualTerminal(80, 24);
		const rec = new RecordingTerminal(inner);
		const term = inner;
		const renderer = new PiTuiRenderer({ terminal: rec, cwd: process.cwd() });
		renderer.start(stubHooks());
		active.push(renderer);

		const assistant = renderer.beginAssistant();
		assistant.append("# Hi\n");
		let screen = await view(term);
		expect(screen).toContain("Hi");

		// synchronized-output marker must be in use by the render pipeline
		expect(rec.writes.join("")).toContain("\x1b[?2026h");

		const mark = rec.writes.length;
		assistant.append("**bold** world");
		screen = await view(term);
		expect(screen).toContain("bold world");
		assistant.done();

		const tail = rec.writes.slice(mark).join("");
		expect(tail.length).toBeGreaterThan(0);
		expect(tail).toContain("\x1b[?2026h"); // still synchronized
		expect(tail).not.toContain("\x1b[2J"); // differential redraw, not a full clear
	});

	it("renders user lines and system notes with their prefixes", async () => {
		const { renderer, term } = boot();
		renderer.addUser("hello there");
		renderer.addSystemNote("plain info note", "info");
		renderer.addSystemNote("careful now", "warn");
		renderer.addSystemNote("it broke", "error");
		const screen = await view(term);
		expect(screen).toContain("> hello there");
		expect(screen).toContain("plain info note");
		expect(screen).toContain("careful now");
		expect(screen).toContain("it broke");
	});

	it("updates the same tool card through start → update → end", async () => {
		const { renderer, term } = boot();
		renderer.toolStart("call-1", "read_file", "{path:'a.ts'}");
		let screen = await view(term);
		expect(screen).toContain("→ read_file");

		renderer.toolUpdate("call-1", "still reading");
		screen = await view(term);
		expect(screen).toContain("still reading");

		renderer.toolEnd("call-1", true, "42 lines", 12);
		screen = await view(term);
		expect(screen).toContain("← ok read_file (12ms) 42 lines");
		// the arrow line was replaced in place — no second line for the same call
		expect(screen).not.toContain("→ read_file");
	});

	it("styles failed tool cards with FAIL", async () => {
		const { renderer, term } = boot();
		renderer.toolStart("call-2", "bash", "rm -rf ./dist");
		renderer.toolEnd("call-2", false, "permission denied", 7);
		const screen = await view(term);
		expect(screen).toContain("← FAIL bash (7ms) permission denied");
	});

	it("askApproval resolves 'once' when Enter selects the first item", async () => {
		const { renderer, term } = boot();
		const pending = renderer.askApproval("bash", "git status");
		const screen = await view(term);
		expect(screen).toContain("approval needed: bash git status");
		expect(screen).toContain("allow once");

		term.sendInput("\r");
		await expect(pending).resolves.toBe("once");

		// overlay is gone after resolution
		const after = await view(term);
		expect(after).not.toContain("allow once");
	});

	it("askApproval resolves 'deny' on Escape", async () => {
		const { renderer, term } = boot();
		const pending = renderer.askApproval("bash", "curl example.com");
		await term.waitForRender();
		term.sendInput("\x1b");
		await expect(pending).resolves.toBe("deny");
	});

	it("askApproval renders a diff detail inside the overlay, clipped to the terminal with a folded marker (port #24)", async () => {
		const { renderer, term } = boot();
		// what app.ts passes for a long change: previewDiff's 40-line cap plus its own marker
		const diff = ["--- a/big.txt", "+++ b/big.txt", "@@ -1,200 +1,200 @@", ...Array.from({ length: 37 }, (_, i) => `-line-${i + 1}`), "… +363 more lines"];
		const pending = renderer.askApproval("write", "{…}", diff.join("\n"));
		const screen = await view(term);
		expect(screen).toContain("approval needed: write");
		expect(screen).toContain("--- a/big.txt");
		expect(screen).toContain("@@ -1,200 +1,200 @@");
		expect(screen).toContain("-line-9");            // 24 rows → 12 diff rows: 3 headers + line-1..9
		expect(screen).not.toContain("-line-10");       // clipped by the renderer's physical bound
		// 29 rows hidden, one of them previewDiff's marker standing for 363 more → one folded marker
		expect(screen).toContain("… +391 more lines");
		expect(screen).not.toContain("+363");
		expect(screen).toContain("allow once");         // verdicts stay on screen below the diff
		term.sendInput("\x1b[B");                       // keys reach the list through the card
		term.sendInput("\x1b[B");
		term.sendInput("\r");                           // third item: deny
		await expect(pending).resolves.toBe("deny");
		expect(await view(term)).not.toContain("-line-1"); // overlay gone
	});

	it("askApproval resolves 'always' via arrow-down then Enter", async () => {
		const { renderer, term } = boot();
		const pending = renderer.askApproval("write_file", "out.txt");
		await term.waitForRender();
		term.sendInput("\x1b[B"); // down to the second item
		term.sendInput("\r");
		await expect(pending).resolves.toBe("always");
	});

	it("renders the status line and swaps it on update", async () => {
		const { renderer, term } = boot();
		renderer.setStatus({
			provider: "anthropic",
			model: "claude-sonnet",
			yolo: false,
			turns: 1,
			tokensIn: 100,
			tokensOut: 50,
		});
		let screen = await view(term);
		expect(screen).toContain("anthropic/claude-sonnet");
		expect(screen).toContain("ask first"); // the permission mode by its screen name
		expect(screen).toContain("turns 1");
		expect(screen).toContain("tokens 100/50");

		renderer.setStatus({
			provider: "anthropic",
			model: "claude-sonnet",
			yolo: true,
			turns: 2,
			tokensIn: 220,
			tokensOut: 90,
		});
		screen = await view(term);
		expect(screen).toContain("auto"); // yolo=true shows as "auto"
		expect(screen).toContain("turns 2");
		expect(screen).toContain("tokens 220/90");
		expect(screen).not.toContain("turns 1");
	});

	it("isNativeModifierPressed degrades gracefully when the native addon is ABSENT", () => {
		// Force the missing-addon catch path (native-modifiers.ts:37-56): copy src/ WITHOUT
		// the native/ sibling to a temp dir and probe in a subprocess. `--no-install` is
		// load-bearing — without it Bun resolves "@earendil-works/pi-tui" from its global
		// install cache (or auto-installs from the network) and the native branch runs.
		// The probe asserts the BRANCH (LOADED=NONE), not just the boolean, by mirroring
		// the loader's exact candidate walk (native-module-path.ts defaults).
		const dir = mkdtempSync(join(tmpdir(), "rovecode-native-fallback-"));
		try {
			cpSync(join(import.meta.dir, "../../vendor/pi-tui/src"), join(dir, "src"), { recursive: true });
			const probe = join(dir, "src", "native-modifiers.ts").replace(/\\/g, "/");
			const candidatesMod = join(dir, "src", "native-module-path.ts").replace(/\\/g, "/");
			const script = [
				`import { isNativeModifierPressed } from "${probe}";`,
				`import { getNativeModuleCandidates } from "${candidatesMod}";`,
				`import { createRequire } from "node:module";`,
				`import { join } from "node:path";`,
				`import { pathToFileURL } from "node:url";`,
				`const req = createRequire(pathToFileURL("${probe}").href);`,
				`const nativePath = process.platform === "darwin"`,
				`  ? join("native", "darwin", "prebuilds", \`darwin-\${process.arch}\`, "darwin-modifiers.node")`,
				`  : join("native", "win32", "prebuilds", \`win32-\${process.arch}\`, "win32-console-mode.node");`,
				`let loaded = "NONE";`,
				`for (const c of getNativeModuleCandidates(nativePath)) { try { req(c); loaded = c; break; } catch {} }`,
				`console.log("LOADED=" + loaded);`,
				`console.log("RESULT=" + isNativeModifierPressed("shift"));`,
			].join("\n");
			const res = Bun.spawnSync({
				cmd: ["bun", "--no-install", "-e", script],
				stdout: "pipe", stderr: "pipe",
			});
			const out = res.stdout.toString();
			expect(res.exitCode).toBe(0);
			expect(out).toContain("LOADED=NONE");   // no addon reachable → catch path is what ran
			expect(out).toContain("RESULT=false");  // and it degraded to false, no throw
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("isNativeModifierPressed returns a boolean in-process (addon present or not)", () => {
		let result: boolean | undefined;
		expect(() => {
			result = isNativeModifierPressed("shift");
		}).not.toThrow();
		expect(typeof result).toBe("boolean");
	});

	it("Ctrl+C triggers the onExit hook", async () => {
		let exits = 0;
		const { term } = boot(stubHooks({ onExit: () => exits++ }));
		await term.waitForRender();
		term.sendInput("\x03");
		expect(exits).toBe(1);
	});

	it("editor submit trims input, skips empties, and calls onSubmit", async () => {
		const submitted: string[] = [];
		const { term } = boot(stubHooks({ onSubmit: (text) => submitted.push(text) }));
		await term.waitForRender();
		term.sendInput("\r"); // empty — ignored
		term.sendInput("  hi there  ");
		term.sendInput("\r");
		expect(submitted).toEqual(["hi there"]);
	});

	it("setBusy shows a cancellable loader and Escape triggers onInterrupt", async () => {
		let interrupts = 0;
		const { renderer, term } = boot(stubHooks({ onInterrupt: () => interrupts++ }));
		renderer.setBusy(true, "working on it");
		let screen = await view(term);
		expect(screen).toContain("working on it");

		term.sendInput("\x1b");
		expect(interrupts).toBe(1);

		renderer.setBusy(false);
		screen = await view(term);
		expect(screen).not.toContain("working on it");
	});

	it("typing / in the editor surfaces registered slash commands (autocomplete)", async () => {
		const { term } = boot();
		await term.waitForRender();
		term.sendInput("/mo");
		const screen = await view(term);
		expect(screen).toContain("model");
		expect(screen).toContain("switch model"); // description from setCommands
		expect(screen).not.toContain("show help"); // filtered out by "/mo"
	});

	it("pickOne resolves the chosen value, null on escape, null after stop", async () => {
		const { renderer, term } = boot();
		await term.waitForRender();
		const p1 = renderer.pickOne([
			{ value: "alpha", label: "first" },
			{ value: "beta", label: "second" },
		]);
		await term.waitForRender();
		term.sendInput("\x1b[B"); // down → second
		term.sendInput("\r");
		expect(await p1).toBe("beta");

		const p2 = renderer.pickOne([{ value: "x", label: "only" }]);
		await term.waitForRender();
		term.sendInput("\x1b"); // escape → cancel
		expect(await p2).toBeNull();

		const p3 = renderer.pickOne([{ value: "y", label: "pending at stop" }]);
		renderer.stop();
		expect(await p3).toBeNull();
		expect(await renderer.pickOne([{ value: "z", label: "after stop" }])).toBeNull();
	});

	it("clearTranscript removes history but keeps editor and status alive", async () => {
		const { renderer, term } = boot();
		renderer.addUser("old question");
		renderer.addSystemNote("old note");
		renderer.setStatus({ provider: "p", model: "m", yolo: false, turns: 3, tokensIn: 1, tokensOut: 2 });
		let screen = await view(term);
		expect(screen).toContain("old question");
		renderer.clearTranscript();
		screen = await view(term);
		expect(screen).not.toContain("old question");
		expect(screen).not.toContain("old note");
		expect(screen).toContain("turns 3"); // status line survives
		renderer.addUser("fresh question"); // transcript still functional after clear
		screen = await view(term);
		expect(screen).toContain("fresh question");
	});

	it("prefillEditor places text that submits on Enter (pi edit-and-resubmit)", async () => {
		const submitted: string[] = [];
		const { renderer, term } = boot(stubHooks({ onSubmit: (t) => submitted.push(t) }));
		await term.waitForRender();
		renderer.prefillEditor("question two");
		let screen = await view(term);
		expect(screen).toContain("question two");
		term.sendInput("\r");
		expect(submitted).toEqual(["question two"]);
	});

	it("renderer mutations after stop() are safe no-ops (run finally racing exit)", async () => {
		const { renderer, term } = boot();
		await term.waitForRender();
		const pending = renderer.askApproval("write", "{}"); // overlay open at stop time
		renderer.stop();
		expect(() => {
			renderer.setBusy(false);
			renderer.setBusy(true, "late");
			renderer.addSystemNote("late note");
			renderer.toolStart("t9", "bash", "{}");
			renderer.toolEnd("t9", true, "out", 1);
			const v = renderer.beginAssistant();
			v.append("late delta");
			v.done();
		}).not.toThrow();
		await expect(renderer.askApproval("write", "{}")).resolves.toBe("deny");
		// an approval already on screen at stop() time settles to deny — nothing may
		// stay pending (a stuck resolver pins embedded hosts that await it)
		await expect(pending).resolves.toBe("deny");
	});

	// ---------- port #33: askQuestion overlay ----------

	const DB_Q = { question: "Which database?", options: ["postgres", "sqlite"] };

	it("askQuestion renders the question, its options and the free-text entry; Down+Enter picks the second option", async () => {
		const { renderer, term } = boot();
		const pending = renderer.askQuestion(DB_Q);
		const screen = await view(term);
		expect(screen).toContain("question: Which database?"); // transcript record (like "approval needed")
		expect(screen).toContain("→ postgres");                 // options rendered, first one selected
		expect(screen).toContain("sqlite");
		expect(screen).toContain("type an answer…");            // free text allowed by default
		expect(screen).toContain("Esc skip");                    // idle (no run): Escape declines
		term.sendInput("\x1b[B");                               // down → sqlite
		expect(await view(term)).toContain("→ sqlite");
		term.sendInput("\r");
		await expect(deadline(pending)).resolves.toEqual({ choice: 1, label: "sqlite" });
		const after = await view(term);
		expect(after).not.toContain("type an answer…");         // overlay gone
		expect(after).not.toContain("→ sqlite");
	});

	it("askQuestion free text: 'type an answer…' opens a one-line input (empty Enter is ignored), Escape steps back to the options, Enter sends {text}", async () => {
		const { renderer, term } = boot();
		const pending = renderer.askQuestion(DB_Q);
		await term.waitForRender();
		term.sendInput("\x1b[B"); term.sendInput("\x1b[B");    // down twice → "type an answer…"
		term.sendInput("\r");
		let screen = await view(term);
		expect(screen).toContain("Enter sends · Esc back to the options");
		expect(screen).not.toContain("→ postgres");             // the list gave way to the input
		term.sendInput("\r");                                    // empty answer: ignored, still open
		expect(await stateOf(pending)).toBe("pending");
		term.sendInput("\x1b");                                  // back to the options (selection kept)
		screen = await view(term);
		expect(screen).toContain("→ type an answer…");
		expect(screen).toContain("postgres");
		term.sendInput("\r");                                    // into the input again
		term.sendInput("mysql please");
		expect(await view(term)).toContain("mysql please");
		term.sendInput("\r");
		await expect(deadline(pending)).resolves.toEqual({ text: "mysql please" });
		expect(await view(term)).not.toContain("Enter sends");
	});

	it("askQuestion honors allowFreeText:false (no free-text entry) and opens the input directly when there are no options", async () => {
		const { renderer, term } = boot();
		const p1 = renderer.askQuestion({ ...DB_Q, allowFreeText: false });
		let screen = await view(term);
		expect(screen).toContain("→ postgres");
		expect(screen).not.toContain("type an answer…");        // mutation: renderer ignores allowFreeText → fails
		term.sendInput("\r");
		await expect(deadline(p1)).resolves.toEqual({ choice: 0, label: "postgres" });
		const p2 = renderer.askQuestion({ question: "Name the branch?" });
		screen = await view(term);
		expect(screen).toContain("Name the branch?");
		expect(screen).toContain("Enter sends · Esc skip");      // input-only card, idle
		term.sendInput("feat/x"); term.sendInput("\r");
		await expect(deadline(p2)).resolves.toEqual({ text: "feat/x" });
	});

	it("askQuestion Escape on the options declines (null) when no run is in flight", async () => {
		const { renderer, term } = boot();
		const pending = renderer.askQuestion(DB_Q);
		await term.waitForRender();
		term.sendInput("\x1b");
		await expect(deadline(pending)).resolves.toBeNull();
		expect(await view(term)).not.toContain("type an answer…");
	});

	it("askQuestion: the run's abort signal dismisses the card and resolves null (no leak); a pre-aborted signal never renders", async () => {
		const { renderer, term } = boot();
		const ac = new AbortController();
		const pending = renderer.askQuestion(DB_Q, ac.signal);
		expect(await view(term)).toContain("type an answer…");
		ac.abort();
		await expect(deadline(pending)).resolves.toBeNull();     // mutation: renderer ignores the signal → deadline fails
		expect(await view(term)).not.toContain("type an answer…");
		const dead = new AbortController();
		dead.abort();
		await expect(deadline(renderer.askQuestion(DB_Q, dead.signal))).resolves.toBeNull();
		expect(await view(term)).not.toContain("→ postgres");
	});

	it("askQuestion while a run is in flight: Escape interrupts the run (onInterrupt), the card stays until the run's signal aborts", async () => {
		let interrupts = 0;
		const ac = new AbortController();
		const { renderer, term } = boot(stubHooks({ onInterrupt: () => { interrupts++; } }));
		renderer.setBusy(true, "thinking…");
		const pending = renderer.askQuestion(DB_Q, ac.signal);
		let screen = await view(term);
		expect(screen).toContain("Esc stop the run");            // busy hint: Escape means "stop the run"
		term.sendInput("\x1b");
		expect(interrupts).toBe(1);                              // routed to the run, not to a decline
		screen = await view(term);
		expect(screen).toContain("type an answer…");            // still open: the app's abort closes it, not the key
		expect(await stateOf(pending)).toBe("pending");
		ac.abort();                                              // what app.ts onInterrupt does: runAbort.abort()
		await expect(deadline(pending)).resolves.toBeNull();
		expect(await view(term)).not.toContain("type an answer…");
		renderer.setBusy(false);
	});

	it("askQuestion rejects a second concurrent ask with a clear error while the first stays answerable; stop() settles a pending one to null", async () => {
		const { renderer, term } = boot();
		const first = renderer.askQuestion(DB_Q);
		await term.waitForRender();
		await expect(deadline(renderer.askQuestion({ question: "another?" }))).rejects.toThrow("a question or approval overlay is already open");
		term.sendInput("\r");
		await expect(deadline(first)).resolves.toEqual({ choice: 0, label: "postgres" });
		const late = renderer.askQuestion(DB_Q);
		await term.waitForRender();
		renderer.stop();
		await expect(deadline(late)).resolves.toBeNull();
		await expect(deadline(renderer.askQuestion(DB_Q))).resolves.toBeNull(); // stopped UI: nobody to ask
	});

	it("askQuestion clips a long question to the terminal with a folded marker and keeps the options on screen", async () => {
		const { renderer, term } = boot();
		const long = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
		const pending = renderer.askQuestion({ question: long, options: ["alpha", "beta"] });
		const screen = await view(term);
		// card rows are standalone lines (the one-line transcript note above the card also echoes the text)
		const rows = screen.split("\n").map((l) => l.trim());
		expect(rows).toContain("line-1");
		expect(rows).toContain("line-10");
		expect(rows).toContain("… +30 more lines");             // 24 rows → 11 question rows: 10 lines + marker (the skip entry costs one)
		expect(rows).not.toContain("line-11");                   // clipped by the physical bound
		expect(screen).toContain("→ alpha");                    // options still reachable below the question
		term.sendInput("\r");
		await expect(deadline(pending)).resolves.toEqual({ choice: 0, label: "alpha" });
	});

	// ---------- wiring pass: port #32 status label, port #33 critic LOW (non-destructive decline) ----------

	it("setStatus appends the todo label after the tokens segment when present and omits it when absent (port #32)", async () => {
		const { renderer, term } = boot();
		renderer.setStatus({ provider: "p", model: "m", yolo: true, turns: 1, tokensIn: 10, tokensOut: 5, todos: "todos 1/3" });
		let screen = await view(term);
		expect(screen).toContain("tokens 10/5 · todos 1/3"); // mutation: drop the todos segment → fails
		renderer.setStatus({ provider: "p", model: "m", yolo: true, turns: 2, tokensIn: 10, tokensOut: 5 });
		screen = await view(term);
		expect(screen).toContain("turns 2 · tokens 10/5");
		expect(screen).not.toContain("todos");
	});

	it("askQuestion lists a 'skip this question' entry after the options (and after the free-text entry): picking it resolves null without touching the run", async () => {
		let interrupts = 0;
		const ac = new AbortController();
		const { renderer, term } = boot(stubHooks({ onInterrupt: () => { interrupts++; } }));
		renderer.setBusy(true, "thinking…");
		const pending = renderer.askQuestion({ ...DB_Q, allowFreeText: false }, ac.signal);
		let screen = await view(term);
		expect(screen).toContain("skip this question");
		expect(screen).not.toContain("type an answer…");
		term.sendInput("\x1b[B"); term.sendInput("\x1b[B");      // postgres → sqlite → skip
		expect(await view(term)).toContain("→ skip this question");
		term.sendInput("\r");
		await expect(deadline(pending)).resolves.toBeNull();     // declined: the tool reports "user declined to answer"
		expect(interrupts).toBe(0);                              // the run was NOT interrupted (mutation: skip routed to escape() → 1)
		expect(ac.signal.aborted).toBe(false);
		expect(await view(term)).not.toContain("skip this question"); // overlay gone
		renderer.setBusy(false);
		// with free text allowed the skip entry sits LAST, after "type an answer…"
		const p2 = renderer.askQuestion(DB_Q);
		screen = await view(term);
		const rows = screen.split("\n").map((l) => l.trim());
		expect(rows.indexOf("type an answer…")).toBeGreaterThan(-1);
		expect(rows.indexOf("type an answer…")).toBeLessThan(rows.indexOf("skip this question"));
		term.sendInput("\r");
		await expect(deadline(p2)).resolves.toEqual({ choice: 0, label: "postgres" });
	});
});
