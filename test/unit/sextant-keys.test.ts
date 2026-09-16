/** Port #43 keys.ts: every clause of the PORTS.md #43 bar plus the ctrl map, cards, files/code
 *  navigation, paging, history, line editing, paste and mouse. Pure and synchronous — no timers,
 *  `now` is passed explicitly. */

import { test, expect } from "bun:test";
import { focusOrder, ESC_WINDOW_MS, type HitZone } from "../../src/sextant/keys.ts";
import { ALIAS_NOTE } from "../../src/sextant/local-commands.ts";
import { treeRows } from "../../src/sextant/model.ts";
import { MAX_SUGGESTIONS, suggestions } from "../../src/sextant/overlays.ts";
import type { CardState, SextantState, TreeRow } from "../../src/sextant/types.ts";
import { makeState, makeLayout, spyCtx, key, ctrl, mouse, paste, press, type } from "../helpers/sextant-fixtures-keys.ts";

/** n running lanes for the agents board */
const crew = (n: number): SextantState["crew"] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `t${i}`, agent: "a", status: "running", createdAt: 0 })) as SextantState["crew"];
/** the 160×44 layout with the code panel forced to `w` columns (the agents grid is width-based) */
const codeWidth = (w: number) => { const L = makeLayout(160, 44); L.code = { ...L.code, w }; return L; };

// ---------- slash suggestions → onSubmit ----------

test("/hel: Tab completes to /help (a custom command is listed too); Enter submits through onSubmit exactly once", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "/hel");
  press(s, spy, key("tab"));
  expect(s.input.text).toBe("/help");
  expect(s.input.cur).toBe(5);
  // the custom command shares the prefix: ↓ selects it and Tab completes it instead
  const s2 = makeState(), spy2 = spyCtx();
  type(s2, spy2, "/hel");
  press(s2, spy2, key("down"));
  press(s2, spy2, key("tab"));
  expect(s2.input.text).toBe("/hello");
  // Enter on the completed line
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/help"]);
  expect(s.input.text).toBe("");
  expect(s.input.history).toEqual(["/help"]);
  expect(s.help).toBe(true); // the keys card opens as well
});

test("Enter on /hel (not yet completed) runs the selected suggestion: onSubmit('/help') once, not '/hel'", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "/hel");
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/help"]);
});

test("a command that needs an argument completes to '/theme ' on Enter instead of submitting; the option then runs locally", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "/the");
  press(s, spy, key("enter"));
  expect(s.input.text).toBe("/theme ");
  expect(spy.submits).toEqual([]);
  type(s, spy, "em");
  press(s, spy, key("enter"));
  expect(s.theme).toBe("ember");
  expect(spy.themes).toEqual(["ember"]);
  expect(spy.submits).toEqual([]); // renderer-local: never reaches the controller
  expect(s.input.history).toEqual(["/theme ember"]);
});

test("@sess picker inserts '@src/core/session.ts ' (path + trailing space) and leaves the cursor after it", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "look at @sess");
  press(s, spy, key("tab"));
  expect(s.input.text).toBe("look at @src/core/session.ts ");
  expect(s.input.cur).toBe(s.input.text.length);
  expect(spy.submits).toEqual([]);
  press(s, spy, key("enter")); // Enter on a mention row only inserts, so this Enter submits the line
  expect(spy.submits).toEqual(["look at @src/core/session.ts"]);
});

test("!cmd, free text and an unknown /x reach onSubmit unchanged (no intent rewrite, no local handling)", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "!npm run test"); press(s, spy, key("enter"));
  type(s, spy, "fix login"); press(s, spy, key("enter"));
  type(s, spy, "/x now"); press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["!npm run test", "fix login", "/x now"]);
  expect(spy.toasts).toEqual([]);
});

test("empty or whitespace Enter submits nothing; /permissions /mode become notes, not submissions; /undo SUBMITS (a real command since port #65)", () => {
  const s = makeState(), spy = spyCtx();
  expect(press(s, spy, key("enter"))).toEqual([]);
  type(s, spy, "   "); press(s, spy, key("enter"));
  expect(spy.submits).toEqual([]);
  // /undo was an alias note until port #65; it is a built-in now and must reach onSubmit
  type(s, spy, "/undo"); press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/undo"]);
  spy.submits.length = 0;
  for (const c of ["/permissions ask", "/mode plan"]) { type(s, spy, c); press(s, spy, key("enter")); }
  expect(spy.submits).toEqual([]);
  expect(spy.toasts).toEqual(["/permissions → use /yolo", "/mode → use /plan or /act"]);
});

// ---------- esc / ctrl ----------

test("Esc-Esc while running: the first Esc only arms escUntil = now + 1500, the second inside the window calls onInterrupt exactly once", () => {
  const s = makeState({ running: true }), spy = spyCtx();
  press(s, spy, key("escape"), 1000);
  expect(s.escUntil).toBe(1000 + ESC_WINDOW_MS);
  expect(spy.n.interrupts).toBe(0);
  press(s, spy, key("escape"), 2000);
  expect(spy.n.interrupts).toBe(1);
  expect(s.escUntil).toBe(0);
  // an expired window re-arms instead of interrupting
  press(s, spy, key("escape"), 5000);
  press(s, spy, key("escape"), 5000 + ESC_WINDOW_MS);
  expect(spy.n.interrupts).toBe(1);
  expect(s.escUntil).toBe(5000 + 2 * ESC_WINDOW_MS);
});

test("Esc when idle: closes a visible suggestion box first (sgSel = -1), then clears the line; ↑↓ then browse history", () => {
  const s = makeState(), spy = spyCtx();
  s.input.history.push("earlier");
  type(s, spy, "/he");
  press(s, spy, key("escape"));
  expect(s.input.text).toBe("/he");
  expect(s.input.sgSel).toBe(-1);
  press(s, spy, key("up"));
  expect(s.input.text).toBe("earlier"); // history, not the (closed) box
  press(s, spy, key("escape"));
  expect(s.input.text).toBe("");
  expect(press(s, spy, key("escape"))).toEqual([]); // nothing left to do
});

test("Esc with focus on another panel returns focus to messages (closing an open lane first)", () => {
  const s = makeState({ focus: "code" }), spy = spyCtx();
  s.code.laneOpen = true;
  press(s, spy, key("escape"));
  expect(s.code.laneOpen).toBe(false);
  expect(s.focus).toBe("code");
  press(s, spy, key("escape"));
  expect(s.focus).toBe("messages");
});

test("Ctrl+C: onExit when idle; while running it interrupts first and the next Ctrl+C after the run stopped exits", () => {
  const s = makeState(), spy = spyCtx();
  press(s, spy, ctrl("c"));
  expect(spy.n.exits).toBe(1);
  const r = makeState({ running: true }), rs = spyCtx();
  press(r, rs, ctrl("c"));
  expect(rs.n.interrupts).toBe(1);
  expect(rs.n.exits).toBe(0);
  r.running = false;
  press(r, rs, ctrl("c"));
  expect(rs.n.exits).toBe(1);
});

test("the ctrl map: ⌃k palette, ⌃t theme cycle, ⌃n → onSubmit('/new'), ⌃e files, ⌃s/⌃d/⌃r/⌃a code modes, ⌃u clears", () => {
  const s = makeState(), spy = spyCtx();
  press(s, spy, ctrl("k"));
  expect(s.palette).not.toBeNull();
  press(s, spy, key("escape"));
  press(s, spy, ctrl("t"));
  expect(s.theme).toBe("ember");
  expect(spy.themes).toEqual(["ember"]);
  press(s, spy, ctrl("n"));
  expect(spy.submits).toEqual(["/new"]);
  press(s, spy, ctrl("e"));
  expect(s.focus).toBe("files");
  press(s, spy, ctrl("d"));
  expect(s.code.mode).toBe("diff");
  press(s, spy, ctrl("d"));
  expect(s.code.mode).toBe("code");
  press(s, spy, ctrl("r"));
  expect(s.code.mode).toBe("run");
  press(s, spy, ctrl("a"));
  expect(s.code.mode).toBe("agents");
  expect(s.focus).toBe("code");
  press(s, spy, ctrl("s"));
  expect(s.code.mode).toBe("code");
  expect(spy.modes).toEqual(["diff", "code", "run", "agents", "code"]);
  type(s, spy, "abc");
  press(s, spy, ctrl("u"));
  expect(s.input.text).toBe("");
  // ⌃e with the files column hidden PAGES files into the main slot (draw-tabs.ts) — it used to toast
  // "the files panel needs ≥ 140 columns" and leave files unreachable on a narrow terminal
  const n = makeState(), ns = spyCtx(makeLayout(139, 44));
  press(n, ns, ctrl("e"));
  expect(n.page).toBe("files");
  expect(n.focus).toBe("files");
  expect(ns.toasts.length).toBe(0);
});

// ---------- focus / panels ----------

test("Tab cycles messages→code→files at 160 cols (⇧Tab backwards); files is skipped at 139 cols", () => {
  const s = makeState(), spy = spyCtx(makeLayout(160, 44));
  press(s, spy, key("tab")); expect(s.focus).toBe("code");
  press(s, spy, key("tab")); expect(s.focus).toBe("files");
  press(s, spy, key("tab")); expect(s.focus).toBe("messages");
  press(s, spy, key("shift-tab")); expect(s.focus).toBe("files");
  const n = makeState(), ns = spyCtx(makeLayout(139, 44));
  expect(focusOrder(ns.ctx.layout)).toEqual(["messages", "code"]);
  press(n, ns, key("tab")); expect(n.focus).toBe("code");
  press(n, ns, key("tab")); expect(n.focus).toBe("messages");
});

test("←/→ in the code panel cycle code→diff→run→agents (search joins only while a result is shown); ↑↓/PgUp/PgDn scroll", () => {
  const s = makeState({ focus: "code" }), spy = spyCtx();
  press(s, spy, key("right")); expect(s.code.mode).toBe("diff");
  press(s, spy, key("right")); expect(s.code.mode).toBe("run");
  press(s, spy, key("right")); expect(s.code.mode).toBe("agents");
  press(s, spy, key("right")); expect(s.code.mode).toBe("code");
  press(s, spy, key("left")); expect(s.code.mode).toBe("agents");
  expect(spy.modes).toEqual(["diff", "run", "agents", "code", "agents"]);
  s.code.search = { query: "q", lines: [] }; s.code.mode = "agents";
  press(s, spy, key("right")); expect(String(s.code.mode)).toBe("search");
  press(s, spy, key("down")); press(s, spy, key("down")); expect(s.code.scroll).toBe(2);
  press(s, spy, key("pagedown")); expect(s.code.scroll).toBe(12);
  press(s, spy, key("pageup")); press(s, spy, key("pageup")); expect(s.code.scroll).toBe(0);
  press(s, spy, key("up")); expect(s.code.scroll).toBe(0);
  expect(spy.submits).toEqual([]); // nothing typed reached the prompt
});

test("agents mode with a crew: ←/→/↑/↓ move the lane, Enter opens/closes the lane (Esc closes it too)", () => {
  const s = makeState({ focus: "code" }), spy = spyCtx(codeWidth(140)); // a 140-wide code panel → the board draws 3 columns
  s.code.mode = "agents";
  s.crew = crew(5);
  press(s, spy, key("right")); expect(s.code.lane).toBe(1);
  press(s, spy, key("down")); expect(s.code.lane).toBe(4); // 5 lanes in 3 columns: ↓ is one row = 3 lanes
  press(s, spy, key("left")); expect(s.code.lane).toBe(3);
  press(s, spy, key("up")); expect(s.code.lane).toBe(0);
  press(s, spy, key("enter")); expect(s.code.laneOpen).toBe(true);
  press(s, spy, key("enter")); expect(s.code.laneOpen).toBe(false);
  expect(s.code.mode).toBe("agents"); // ←/→ moved lanes, never cycled modes
});

test("files: ↑↓ move the cursor (opening files, keeping it visible), ←/→ fold, Enter toggles a dir / opens a file", () => {
  const rows: TreeRow[] = [
    { path: "src", name: "src", depth: 0, dir: true, expanded: true },
    { path: "src/core", name: "core", depth: 1, dir: true },
    { path: "src/tui/app.ts", name: "app.ts", depth: 1, dir: false },
    { path: "README.md", name: "README.md", depth: 0, dir: false },
  ];
  const s = makeState({ focus: "files" }), spy = spyCtx(makeLayout(160, 44));
  spy.ctx.rows = rows;
  press(s, spy, key("down")); expect(s.files.cursor).toBe(1);
  press(s, spy, key("right")); expect(s.files.expanded.has("src/core")).toBe(true);
  press(s, spy, key("left")); expect(s.files.expanded.has("src/core")).toBe(false);
  press(s, spy, key("enter")); expect(s.files.expanded.has("src/core")).toBe(true);
  press(s, spy, key("down"));
  expect(s.code.file).toBe("src/tui/app.ts");
  expect(spy.opened).toEqual(["src/tui/app.ts"]);
  expect(s.focus).toBe("files"); // browsing keeps focus on the tree
  press(s, spy, key("down")); press(s, spy, key("down")); expect(s.files.cursor).toBe(3); // clamped
  press(s, spy, key("enter")); expect(spy.opened.at(-1)).toBe("README.md");
  expect(spy.submits).toEqual([]);
  // the cursor stays inside a short panel: scroll follows it
  const t = makeState({ focus: "files" }), ts = spyCtx({ ...makeLayout(160, 44), files: { x: 1, y: 1, w: 30, h: 4 } });
  ts.ctx.rows = rows;
  press(t, ts, key("down")); press(t, ts, key("down")); press(t, ts, key("down"));
  expect(t.files.scroll).toBe(2);
});

test("messages PgUp/PgDn scroll (PgUp turns stick off), End re-sticks", () => {
  const s = makeState({ msgScroll: 20 }), spy = spyCtx();
  press(s, spy, key("pageup"));
  expect(s.msgScroll).toBe(15);
  expect(s.stick).toBe(false);
  press(s, spy, key("pagedown"));
  expect(s.msgScroll).toBe(20);
  press(s, spy, key("end"));
  expect(s.stick).toBe(true);
});

// ---------- cards ----------

function approval(): { card: CardState; answers: string[] } {
  const answers: string[] = [];
  const card: CardState = { kind: "approval", verdicts: ["once", "always", "deny"], tool: "edit", argsPreview: "x.ts", selected: 0, resolve: (a) => { answers.push(a); } };
  return { card, answers };
}

test("approval card: ←/→ move the selection, Enter resolves once / always / deny, Esc = deny; the card leaves the state", () => {
  for (const [keys, want] of [[[], "once"], [["right"], "always"], [["right", "right"], "deny"], [["left"], "deny"], [["right", "left"], "once"]] as [string[], string][]) {
    const { card, answers } = approval();
    const s = makeState({ card, running: true }), spy = spyCtx();
    for (const k of keys) press(s, spy, key(k));
    press(s, spy, key("enter"));
    expect(answers).toEqual([want]);
    expect(s.card).toBeNull();
  }
  const { card, answers } = approval();
  const s = makeState({ card, running: true }), spy = spyCtx();
  press(s, spy, key("escape"));
  expect(answers).toEqual(["deny"]);
  expect(s.card).toBeNull();
  expect(spy.n.interrupts).toBe(0); // Esc on a card is the card's answer, not an esc-esc arm
  expect(s.escUntil).toBe(0);
});

test("question card: Enter picks the option, the free-text row takes typing, skip → null, Esc → null", () => {
  const got: unknown[] = [];
  const q = (): CardState => ({ kind: "question", prompt: { question: "which?", options: ["alpha", "beta"], allowFreeText: true }, selected: 0, freeText: "", resolve: (a) => { got.push(a); } });
  let s = makeState({ card: q() }), spy = spyCtx();
  press(s, spy, key("down")); press(s, spy, key("enter"));
  expect(got).toEqual([{ kind: "option", index: 1 }]);
  s = makeState({ card: q() });
  press(s, spy, key("down")); press(s, spy, key("down")); // row 2 = free text
  type(s, spy, "hi there");
  expect((s.card as { freeText: string }).freeText).toBe("hi there");
  expect(s.input.text).toBe(""); // typing went to the card, not the prompt
  press(s, spy, key("backspace"));
  press(s, spy, key("enter"));
  expect(got.at(-1)).toEqual({ kind: "text", text: "hi ther" });
  s = makeState({ card: q() });
  press(s, spy, key("up")); press(s, spy, key("enter")); // wraps to the last row = skip
  expect(got.at(-1)).toBeNull();
  s = makeState({ card: q() });
  press(s, spy, key("escape"));
  expect(got.at(-1)).toBeNull();
  expect(s.card).toBeNull();
  // typing while an option row is selected falls through to the prompt (a follow-up can be pre-typed)
  s = makeState({ card: q() });
  type(s, spy, "later");
  expect(s.input.text).toBe("later");
  expect(spy.submits).toEqual([]);
});

// ---------- paste / history / line editing ----------

test("a paste event inserts multi-line text at the cursor without submitting", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "ab");
  press(s, spy, key("left"));
  press(s, spy, paste("line one\nline two"));
  expect(s.input.text).toBe("aline one\nline twob");
  expect(s.input.cur).toBe("aline one\nline two".length);
  expect(spy.submits).toEqual([]);
});

test("a paste while the connect wizard is up goes to the wizard, never the composer — the pasted key is the secret, masked", async () => {
  const s = makeState(), spy = spyCtx();
  const { openWizard } = await import("../../src/sextant/draw-wizard.ts");
  openWizard(s, [{ key: "1", label: "anthropic" }]);
  s.wizard!.step = 2; // the KEY step: a pasted key is the whole input method
  press(s, spy, paste("sk-ant-secret-123\n"));
  expect(s.wizard!.secret).toContain("sk-ant-secret-123");
  expect(s.input.text).toBe("");                 // the composer never saw it
  expect(spy.submits).toEqual([]);               // and nothing was sent
});

test("history: ↑ recalls newest-first (clamped at the oldest), ↓ walks back to an empty line; typing leaves the browse", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "one"); press(s, spy, key("enter"));
  type(s, spy, "two"); press(s, spy, key("enter"));
  press(s, spy, key("up")); expect(s.input.text).toBe("two");
  press(s, spy, key("up")); expect(s.input.text).toBe("one");
  press(s, spy, key("up")); expect(s.input.text).toBe("one");
  press(s, spy, key("down")); expect(s.input.text).toBe("two");
  press(s, spy, key("down")); expect(s.input.text).toBe("");
  press(s, spy, key("up")); type(s, spy, "!");
  expect(s.input.text).toBe("two!");
  expect(s.input.histIdx).toBe(-1);
  const e = makeState(), es = spyCtx();
  expect(press(e, es, key("up"))).toEqual([]); // no history → nothing
});

test("line editing: chars, backspace, delete, home/end, ←/→, alt/ctrl word jumps", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "hello brave world");
  press(s, spy, key("home")); expect(s.input.cur).toBe(0);
  press(s, spy, key("delete")); expect(s.input.text).toBe("ello brave world");
  press(s, spy, key("end")); expect(s.input.cur).toBe(16);
  press(s, spy, key("left")); press(s, spy, key("left")); press(s, spy, key("backspace"));
  expect(s.input.text).toBe("ello brave wold");
  press(s, spy, key("left", { alt: true })); expect(s.input.cur).toBe(11);
  press(s, spy, ctrl("left")); expect(s.input.cur).toBe(5);
  press(s, spy, key("right", { alt: true })); expect(s.input.cur).toBe(10);
  press(s, spy, ctrl("right")); expect(s.input.cur).toBe(15);
  press(s, spy, key("right")); expect(s.input.cur).toBe(15); // clamped
  press(s, spy, key("space")); expect(s.input.text).toBe("ello brave wold ");
  expect(spy.submits).toEqual([]);
});

test("typing while another panel has focus pulls focus back to the prompt", () => {
  const s = makeState({ focus: "files" }), spy = spyCtx();
  type(s, spy, "x");
  expect(s.focus).toBe("messages");
  expect(s.input.text).toBe("x");
});

// ---------- palette / help ----------

test("palette: ⌃k opens, typing filters, Esc closes, Enter closes then runs the action (theme → local, slash → onSubmit)", () => {
  const s = makeState(), spy = spyCtx();
  press(s, spy, ctrl("k"));
  type(s, spy, "ember");
  expect(s.palette?.query).toBe("ember");
  expect(s.input.text).toBe(""); // never reached the prompt
  press(s, spy, key("enter"));
  expect(s.palette).toBeNull();
  expect(s.theme).toBe("ember");
  expect(spy.themes).toEqual(["ember"]);
  press(s, spy, ctrl("k"));
  type(s, spy, "/exit");
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/exit"]);
  press(s, spy, ctrl("k"));
  type(s, spy, "zzz");
  press(s, spy, key("escape"));
  expect(s.palette).toBeNull();
  expect(s.input.text).toBe("");
  expect(spy.submits).toEqual(["/exit"]);
  // an argument command from the palette lands in the prompt with its options open
  press(s, spy, ctrl("k"));
  type(s, spy, "/theme");
  press(s, spy, key("enter"));
  expect(s.input.text).toBe("/theme ");
  expect(spy.submits).toEqual(["/exit"]);
});

test("keys while the palette or help card is open never reach the prompt; Ctrl+C in the palette still exits", () => {
  const s = makeState({ help: true }), spy = spyCtx();
  type(s, spy, "x");
  expect(s.help).toBe(false);
  expect(s.input.text).toBe("");
  s.help = true;
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual([]);
  expect(s.help).toBe(false);
  s.help = true;
  press(s, spy, key("up")); // not a closer: swallowed, help stays
  expect(s.help).toBe(true);
  s.help = false;
  press(s, spy, ctrl("k"));
  press(s, spy, key("enter")); // runs the first row (/help) and closes
  expect(s.palette).toBeNull();
  expect(spy.submits).toEqual(["/help"]);
  expect(s.help).toBe(true); // /help opened the keys card as well
  press(s, spy, ctrl("c")); // with the card open ⌃c only closes it (app.js:1488)
  expect(s.help).toBe(false);
  expect(spy.n.exits).toBe(0);
  press(s, spy, ctrl("k"));
  press(s, spy, ctrl("c"));
  expect(spy.n.exits).toBe(1);
});

// ---------- mouse ----------

test("wheel 64/65 scrolls the panel under the pointer: messages (stick off on up), code, files; clamped at 0", () => {
  const L = makeLayout(160, 44), s = makeState({ msgScroll: 10 }), spy = spyCtx(L);
  s.files.paths = Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`); // enough rows to scroll (the wheel clamps to the tree)
  spy.ctx.rows = treeRows(s);
  const at = (r: { x: number; y: number }) => [r.x + 2, r.y + 2] as const;
  press(s, spy, mouse(64, ...at(L.messages)));
  expect(s.msgScroll).toBe(8);
  expect(s.stick).toBe(false);
  press(s, spy, mouse(65, ...at(L.code)));
  expect(s.code.scroll).toBe(3);
  press(s, spy, mouse(64, ...at(L.code)));
  expect(s.code.scroll).toBe(0);
  press(s, spy, mouse(65, ...at(L.files!)));
  expect(s.files.scroll).toBe(2);
  expect(s.msgScroll).toBe(8); // untouched by the other panels
  expect(press(s, spy, mouse(65, 0, 0))).toEqual([]); // the frame border belongs to no panel
});

test("left click hits zones in REVERSE registration order (cards/palette drawn last win); drag, other buttons and releases never click", () => {
  const s = makeState(), spy = spyCtx();
  const log: string[] = [];
  const hits: HitZone[] = [
    { rect: { x: 0, y: 0, w: 100, h: 40 }, onClick: () => log.push("panel") },
    { rect: { x: 10, y: 10, w: 20, h: 1 }, onClick: () => log.push("row") },
  ];
  spy.ctx.hits = hits;
  press(s, spy, mouse(0, 12, 10));
  expect(log).toEqual(["row"]);
  press(s, spy, mouse(0, 50, 30));
  expect(log).toEqual(["row", "panel"]);
  press(s, spy, mouse(0, 12, 10, false)); // release
  press(s, spy, mouse(2, 12, 10)); // right button
  press(s, spy, mouse(32, 12, 10)); // left drag
  expect(log).toEqual(["row", "panel"]);
  // a zone may replay a key: the suggestion rows use it to run Enter after selecting themselves
  type(s, spy, "/hel");
  spy.ctx.hits = [{ rect: { x: 0, y: 0, w: 5, h: 5 }, onClick: () => { s.input.sgSel = 0; }, key: key("enter") }];
  press(s, spy, mouse(0, 1, 1));
  expect(spy.submits).toEqual(["/help"]);
});

test("a click on a panel body with no zone focuses that panel", () => {
  const L = makeLayout(160, 44), s = makeState(), spy = spyCtx(L);
  press(s, spy, mouse(0, L.code.x + 3, L.code.y + 3));
  expect(s.focus).toBe("code");
  press(s, spy, mouse(0, L.files!.x + 3, L.files!.y + 3));
  expect(s.focus).toBe("files");
});

test("renderer-local /open, /diff, /focus, /agents mutate the state and call the local hooks — never onSubmit", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "/open callback.ts"); press(s, spy, key("enter"));
  expect(s.code.file).toBe("src/auth/callback.ts");
  expect(s.files.expanded.has("src/auth")).toBe(true);
  expect(s.focus).toBe("code");
  expect(spy.opened).toEqual(["src/auth/callback.ts"]);
  type(s, spy, "/open nothing-like-this-zz"); press(s, spy, key("enter"));
  expect(spy.toasts.at(-1)).toBe('no file matches "nothing-like-this-zz"');
  type(s, spy, "/diff session"); press(s, spy, key("enter"));
  expect(s.code.mode).toBe("diff");
  expect(s.code.file).toBe("src/core/session.ts");
  type(s, spy, "/focus messages"); press(s, spy, key("enter"));
  expect(s.focus).toBe("messages");
  type(s, spy, "/agents"); press(s, spy, key("enter"));
  expect(s.code.mode).toBe("agents");
  expect(spy.submits).toEqual([]);
});

test("handleInput never touches the clock: same inputs at different `now` values differ only through escUntil", () => {
  const a = makeState(), b = makeState(), sa = spyCtx(), sb = spyCtx();
  type(a, sa, "/hel", 1); type(b, sb, "/hel", 999_999);
  press(a, sa, key("tab"), 1); press(b, sb, key("tab"), 999_999);
  expect(a).toEqual(b);
});

// ---------- fix pass: critic findings on the #43 port ----------

test("Enter on a fuzzy-only or one-letter slash stem submits the line verbatim (/x /e /ext /exot reach handleSlash), never the top pick", () => {
  const s = makeState(), spy = spyCtx();
  s.commands.push({ name: "export", description: "Export this session" }); // the real table has /exit AND /export
  for (const line of ["/x", "/e", "/ext", "/exot"]) {
    type(s, spy, line);
    expect(suggestions(s, s.files.paths).length).toBeGreaterThan(0); // the box IS showing a top pick (/exit or /export)…
    expect(press(s, spy, key("enter"))).toEqual(["render"]);
  }
  expect(spy.submits).toEqual(["/x", "/e", "/ext", "/exot"]); // …and Enter still sends what was typed
  expect(s.input.history).toEqual(["/x", "/e", "/ext", "/exot"]);
  expect(spy.toasts).toEqual([]);
  expect(s.help).toBe(false);
});

test("a ≥ 2-letter prefix stem still completes and runs (/ne → /new); a ↓-picked row runs without a prefix; no pick → verbatim", () => {
  const s = makeState(), spy = spyCtx();
  type(s, spy, "/ne"); press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/new"]);
  // "/l" prefixes nothing; its rows are /help then /hello — ↓ picks the second one explicitly
  type(s, spy, "/l");
  expect(suggestions(s, s.files.paths).map((x) => x.label)).toEqual(["/help", "/hello"]);
  press(s, spy, key("down"));
  press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/new", "/hello"]);
  type(s, spy, "/l"); press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/new", "/hello", "/l"]);
});

test("a custom command named like an alias (permissions) is listed, so it runs through onSubmit; without it the alias note toasts (undo left the alias table in port #65 — it is a built-in)", () => {
  const s = makeState(), spy = spyCtx();
  s.commands.push({ name: "permissions", description: "custom permissions" });
  type(s, spy, "/permissions ask"); press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/permissions ask"]);
  expect(spy.toasts).toEqual([]);
  const t = makeState(), ts = spyCtx();
  type(t, ts, "/permissions ask"); press(t, ts, key("enter"));
  expect(ts.submits).toEqual([]);
  expect(ts.toasts).toEqual([ALIAS_NOTE.permissions!]);
  expect("undo" in ALIAS_NOTE).toBe(false);   // mutation target: undo returning to ALIAS_NOTE would make /undo a toast again
});

test("agents grid: prototype key names (constructor, __proto__, …) never move the lane — it stays a finite index", () => {
  const s = makeState({ focus: "code" }), spy = spyCtx();
  s.code.mode = "agents";
  s.crew = crew(5);
  for (const name of ["constructor", "hasOwnProperty", "toString", "valueOf", "__proto__", "isPrototypeOf"]) press(s, spy, key(name));
  expect(s.code.lane).toBe(0);
  expect(Number.isInteger(s.code.lane)).toBe(true);
  expect(s.input.text).toBe(""); // nor did they type anything
});

test("agents grid columns follow the board's width-based gridFor: 3 lanes at a 140-wide code panel → ↓ wraps onto the same lane; 2 lanes at 60 → ↓ is lane 1", () => {
  const s = makeState({ focus: "code" }), spy = spyCtx(codeWidth(140));
  s.code.mode = "agents"; s.crew = crew(3);
  press(s, spy, key("down")); expect(s.code.lane).toBe(0); // 3 columns → a single row: ↓ comes back to itself
  press(s, spy, key("right")); expect(s.code.lane).toBe(1);
  press(s, spy, key("up")); expect(s.code.lane).toBe(1);
  const t = makeState({ focus: "code" }), ts = spyCtx(codeWidth(60));
  t.code.mode = "agents"; t.crew = crew(2);
  press(t, ts, key("down")); expect(t.code.lane).toBe(1); // one column → ↓ is the next lane
  press(t, ts, key("up")); expect(t.code.lane).toBe(0);
});

test("line editing steps by code point: 😀 + Backspace leaves an empty line, ←/→ never stop inside a surrogate pair, Delete removes the whole glyph", () => {
  const s = makeState(), spy = spyCtx();
  const emoji = key("😀", { ch: "😀" }); // input.ts delivers one key per code point
  press(s, spy, emoji);
  expect(s.input).toMatchObject({ text: "😀", cur: 2 });
  press(s, spy, key("backspace"));
  expect(s.input).toMatchObject({ text: "", cur: 0 });
  type(s, spy, "a"); press(s, spy, emoji); type(s, spy, "b");
  expect(s.input.text).toBe("a😀b");
  press(s, spy, key("left")); expect(s.input.cur).toBe(3);
  press(s, spy, key("left")); expect(s.input.cur).toBe(1);
  press(s, spy, key("left")); expect(s.input.cur).toBe(0);
  press(s, spy, key("left")); expect(s.input.cur).toBe(0);
  press(s, spy, key("right")); expect(s.input.cur).toBe(1);
  press(s, spy, key("delete"));
  expect(s.input).toMatchObject({ text: "ab", cur: 1 });
  press(s, spy, key("right")); press(s, spy, key("right")); expect(s.input.cur).toBe(2); // clamped at the end
  // the question card's free-text row edits by code point too
  const c = makeState({ card: { kind: "question", prompt: { question: "?", options: [], allowFreeText: true }, selected: 0, freeText: "x😀", resolve: () => {} } });
  press(c, spy, key("backspace"));
  expect((c.card as { freeText: string }).freeText).toBe("x");
});

test("the suggestion box holds at most 8 rows and ↓/↑ wrap inside them (17 candidates: ↓×9 → row 1, ↑×2 → row 7)", () => {
  const s = makeState(), spy = spyCtx();
  s.commands.push(...Array.from({ length: 16 }, (_, i) => ({ name: `c${i}`, description: `command ${i}` })));
  type(s, spy, "/c");
  expect(suggestions(s, s.files.paths).length).toBe(MAX_SUGGESTIONS);
  for (let i = 0; i < MAX_SUGGESTIONS + 1; i++) press(s, spy, key("down"));
  expect(s.input.sgSel).toBe(1); // wrapped past the last row
  press(s, spy, key("up")); press(s, spy, key("up"));
  expect(s.input.sgSel).toBe(MAX_SUGGESTIONS - 1);
});

test("⌃c with a pending card while running denies the card AND interrupts once, no exit (documented deviation)", () => {
  const { card, answers } = approval();
  const s = makeState({ card, running: true }), spy = spyCtx();
  press(s, spy, ctrl("c"));
  expect(answers).toEqual(["deny"]);
  expect(s.card).toBeNull();
  expect(spy.n).toEqual({ interrupts: 1, exits: 0 });
});

// ---------- re-verify pass: a modified wheel is a wheel (#43 HIGH) ----------

test("shift/alt/ctrl + wheel (b 68/69, 72/73, 80/81) over a hit zone SCROLLS the panel under the pointer and never clicks it — `/ex` + shift+wheel over the /exit row must not quit; a modified left button never clicks; a plain click still hits", () => {
  const L = makeLayout(160, 44), s = makeState({ msgScroll: 10 }), spy = spyCtx(L);
  const log: string[] = [];
  spy.ctx.hits = [{ rect: L.messages, onClick: () => { log.push("row"); s.input.sgSel = 0; }, key: key("enter") }]; // the suggestion row's zone: select + Enter
  type(s, spy, "/ex");
  const x = L.messages.x + 2, y = L.messages.y + 2;
  for (const b of [68, 72, 80]) press(s, spy, mouse(b, x, y));  // shift / alt / ctrl + wheel-up
  expect(s.msgScroll).toBe(4);
  expect(s.stick).toBe(false);
  for (const b of [69, 73, 81]) press(s, spy, mouse(b, x, y));  // + wheel-down
  expect(s.msgScroll).toBe(10);
  expect(log).toEqual([]);                                       // (mutation: raw b === 64/65 test → the zone fires and Enter runs /exit)
  expect(spy.submits).toEqual([]);
  expect(spy.n.exits).toBe(0);
  expect(s.input.text).toBe("/ex");
  press(s, spy, mouse(69, L.code.x + 2, L.code.y + 2));          // shift+wheel-down over code: that panel scrolls
  expect(s.code.scroll).toBe(3);
  for (const b of [4, 8, 16, 36]) press(s, spy, mouse(b, x, y)); // shift/alt/ctrl + left, modified drag: "other"
  expect(log).toEqual([]);
  press(s, spy, mouse(0, x, y));                                 // the plain left click hits the zone
  expect(log).toEqual(["row"]);
  expect(spy.submits).toEqual(["/exit"]);                        // …and its Enter ran the picked row
});
