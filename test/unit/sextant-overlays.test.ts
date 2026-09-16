/** Port #43 overlays.ts: parseInput / mentionAt / resolveFile / fuzzy, the suggestion list and
 *  its box, the palette (items, filter, draw, keys) and the help card — drawn on the local
 *  GridScreen and asserted as text. */

import { test, expect } from "bun:test";
import {
  parseInput, mentionAt, resolveFile, fuzzy, suggestions, drawSuggest, paletteItems, openPalette, closePalette,
  paletteVisible, paletteHint, drawPalette, onPaletteKey, helpRows, drawHelp, allCommands, HELP_KEYS, LOCAL_COMMANDS,
  MAX_SUGGESTIONS,
} from "../../src/sextant/overlays.ts";
import type { HitZone } from "../../src/sextant/keys.ts";
import { GridScreen } from "../helpers/sextant-grid-keys.ts";
import { makeState, makeLayout, FILES, THEME, key } from "../helpers/sextant-fixtures-keys.ts";

// ---------- parsing ----------

test("parseInput: slash (arg undefined until a space is typed), shell, text with mentions, empty", () => {
  expect(parseInput("/help")).toEqual({ kind: "slash", cmd: "help", arg: undefined, mentions: [] });
  expect(parseInput("/theme ")).toEqual({ kind: "slash", cmd: "theme", arg: "", mentions: [] });
  expect(parseInput("  /theme  ember ")).toEqual({ kind: "slash", cmd: "theme", arg: "ember", mentions: [] });
  expect(parseInput("/")).toEqual({ kind: "slash", cmd: "", arg: undefined, mentions: [] });
  expect(parseInput("/x line one\nline two")).toEqual({ kind: "slash", cmd: "x", arg: "line one\nline two", mentions: [] });
  expect(parseInput("!npm test")).toEqual({ kind: "shell", cmd: "npm test", mentions: [] });
  // since 2026-09-07 the bang must be followed by something that is neither whitespace nor another bang, because
  // tui/shell-cmd.ts now RUNS what this classifies: a lone `!`, `! x` and `!!x` are text for the model, not commands
  expect(parseInput("!")).toEqual({ kind: "text", mentions: [] });
  expect(parseInput("! rm -rf /")).toEqual({ kind: "text", mentions: [] });
  expect(parseInput("!!x")).toEqual({ kind: "text", mentions: [] });
  expect(parseInput("fix @src/a.ts and @b.md now")).toEqual({ kind: "text", mentions: ["src/a.ts", "b.md"] });
  expect(parseInput("mail me@example.com")).toEqual({ kind: "text", mentions: [] }); // not after whitespace
  expect(parseInput("")).toEqual({ kind: "text", mentions: [] });
});

test("mentionAt: the @token under the cursor, only at a word start", () => {
  expect(mentionAt("look at @sess", 13)).toEqual({ start: 8, query: "sess" });
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("look at @sess", 10)).toEqual({ start: 8, query: "s" });
  expect(mentionAt("a@b", 3)).toBeNull();
  expect(mentionAt("plain", 5)).toBeNull();
});

test("resolveFile: exact path, then a unique basename, then the best fuzzy hit, else null", () => {
  expect(resolveFile("src/core/loop.ts", FILES)).toBe("src/core/loop.ts");
  expect(resolveFile("@callback.ts", FILES)).toBe("src/auth/callback.ts");
  expect(resolveFile("sess", FILES)).toBe("src/core/session.ts");
  expect(resolveFile("session.ts", FILES)).toBe("src/core/session.ts"); // basename ambiguous with the test → fuzzy decides
  expect(resolveFile("qqqq", FILES)).toBeNull();
  expect(resolveFile("", FILES)).toBeNull();
});

test("fuzzy: subsequence only, consecutive hits and word/path starts score higher, case-insensitive", () => {
  expect(fuzzy("hlp", "help")).toEqual({ score: 1 + 2 + 1 + 3, idx: [0, 2, 3] });
  expect(fuzzy("HELP", "help")!.score).toBe(fuzzy("help", "help")!.score);
  expect(fuzzy("x", "help")).toBeNull();
  expect(fuzzy("ses", "src/core/session.ts")!.score).toBeGreaterThan(fuzzy("ses", "test/unit/session.test.ts")!.score);
  expect(fuzzy("", "anything")).toEqual({ score: 0, idx: [] });
});

// ---------- suggestions ----------

test("suggestions: '/hel' lists /help then the custom /hello, nothing else; '/' lists the first 8 commands, local rows first", () => {
  const s = makeState();
  s.input = { ...s.input, text: "/hel", cur: 4 };
  const sugs = suggestions(s, s.files.paths);
  expect(sugs.map((x) => x.label)).toEqual(["/help", "/hello"]);
  expect(sugs[0]).toMatchObject({ kind: "slash", hint: "commands + keys card", apply: { text: "/help", cur: 5 }, enter: "submit" });
  s.input = { ...s.input, text: "/", cur: 1 };
  const all = suggestions(s, s.files.paths).map((x) => x.label);
  expect(all.slice(0, LOCAL_COMMANDS.length)).toEqual(LOCAL_COMMANDS.map((c) => "/" + c.name));
  expect(all).toContain("/exit");
  expect(all.length).toBe(MAX_SUGGESTIONS); // 9 commands are known; the box shows the 8 best (the cap lives in suggestions)
  expect(new Set(all).size).toBe(all.length); // /help appears once although setCommands lists it too
  s.input = { ...s.input, text: "/hell", cur: 5 }; // the 9th command is reached by typing its stem
  expect(suggestions(s, s.files.paths).map((x) => x.label)).toEqual(["/hello"]);
});

test("suggestions: argument rows for /theme, /open, /diff (changed files first), /focus; none for built-ins or a bare arg", () => {
  const s = makeState();
  const at = (t: string) => { s.input = { ...s.input, text: t, cur: t.length }; return suggestions(s, s.files.paths); };
  expect(at("/theme ").map((x) => x.label)).toEqual(["night", "ember", "contrast"]);
  expect(at("/theme ni")).toMatchObject([{ kind: "arg", label: "night", apply: { text: "/theme night", cur: 12 }, enter: "submit" }]);
  expect(at("/open sess").map((x) => x.label)).toEqual(["src/core/session.ts", "test/unit/session.test.ts"]);
  expect(at("/open ").length).toBe(6); // capped
  expect(at("/diff ").map((x) => x.label)).toEqual(["src/core/session.ts"]); // only the changed file
  expect(at("/diff ")[0]!.hint).toBe("M");
  expect(at("/focus c").map((x) => x.label)).toEqual(["code"]);
  expect(at("/exit ")).toEqual([]);
  expect(at("/hello arg")).toEqual([]);
  expect(at("/the")[0]).toMatchObject({ label: "/theme", arg: "night·ember·contrast", apply: { text: "/theme ", cur: 7 }, enter: "complete" });
  expect(at("/dif")[0]).toMatchObject({ label: "/diff", enter: "submit" }); // optional arg → runs on Enter
});

test("suggestions: '@sess' is a mention picker whose apply inserts the path plus a trailing space; free text and !cmd give none", () => {
  const s = makeState();
  s.input = { ...s.input, text: "look at @sess please", cur: 13 };
  const sugs = suggestions(s, s.files.paths);
  expect(sugs.map((x) => x.label)).toEqual(["src/core/session.ts", "test/unit/session.test.ts"]);
  expect(sugs[0]).toMatchObject({ kind: "mention", hint: "M", enter: "complete", apply: { text: "look at @src/core/session.ts  please", cur: 29 } });
  for (const t of ["fix login", "!npm test", "   "]) { s.input = { ...s.input, text: t, cur: t.length }; expect(suggestions(s, s.files.paths)).toEqual([]); }
});

test("suggestions are closed while the palette, the help card or a card is open", () => {
  const s = makeState();
  s.input = { ...s.input, text: "/hel", cur: 4 };
  expect(suggestions(s, s.files.paths).length).toBe(2);
  openPalette(s); expect(suggestions(s, s.files.paths)).toEqual([]); closePalette(s);
  s.help = true; expect(suggestions(s, s.files.paths)).toEqual([]); s.help = false;
  s.card = { kind: "approval", verdicts: ["once", "always", "deny"], tool: "edit", argsPreview: "", selected: 0, resolve: () => {} };
  expect(suggestions(s, s.files.paths)).toEqual([]);
});

test("drawSuggest: a box above the prompt with the title, the selected row marked, the hint, and the tab/⏎ help; rows register Enter-replaying hits", () => {
  const s = makeState(), L = makeLayout(160, 44), scr = new GridScreen(160, 44), hits: HitZone[] = [];
  s.input = { ...s.input, text: "/hel", cur: 4, sgSel: 1 };
  const sugs = suggestions(s, s.files.paths);
  drawSuggest(scr, L.messages, s, sugs, THEME, hits);
  const txt = scr.toText();
  expect(txt).toContain("commands");
  expect(txt).toContain("tab complete  ⏎ run");
  expect(txt).toMatch(/ {2}\/help +commands \+ keys card/);
  expect(txt).toMatch(/▸ \/hello +custom greeting/);
  const box = scr.cells.findIndex((r) => r.includes("╭"));
  expect(box).toBe(L.messages.y + L.messages.h - 3 - (sugs.length + 3)); // sits just above the prompt line
  expect(hits.length).toBe(2);
  expect(hits[1]!.key).toEqual({ type: "key", name: "enter" });
  hits[0]!.onClick();
  expect(s.input.sgSel).toBe(0);
  // mention rows say "tab insert"
  const m = new GridScreen(160, 44);
  s.input = { ...s.input, text: "@sess", cur: 5, sgSel: 0 };
  drawSuggest(m, L.messages, s, suggestions(s, s.files.paths), THEME);
  expect(m.toText()).toContain("mention a file");
  expect(m.toText()).toContain("tab insert");
  // a dismissed box (sgSel = -1) or no rows draws nothing
  const e = new GridScreen(160, 44);
  s.input.sgSel = -1;
  drawSuggest(e, L.messages, s, suggestions(s, s.files.paths), THEME);
  expect(e.toText().trim()).toBe("");
});

test("suggestions caps at MAX_SUGGESTIONS rows in one place (17 slash candidates → the best MAX_SUGGESTIONS; '/' → the same cap)", () => {
  const s = makeState();
  // `zz`, not `c`: this test is about the CAP, and a prefix that a real command also matches makes it
  // about ranking instead — it broke the day /context was added, for a reason that had nothing to do
  // with what it checks. A synthetic fixture should not compete with the real command list.
  s.commands.push(...Array.from({ length: 16 }, (_, i) => ({ name: `zz${i}`, description: `command ${i}` })));
  s.input = { ...s.input, text: "/zz", cur: 3 };
  expect(MAX_SUGGESTIONS).toBe(10); // raised from 8 when /market made the local list eight long
  const sugs = suggestions(s, s.files.paths);
  expect(sugs.map((x) => x.label)).toEqual(Array.from({ length: MAX_SUGGESTIONS }, (_, i) => `/zz${i}`));
  s.input = { ...s.input, text: "/", cur: 1 };
  expect(suggestions(s, s.files.paths).length).toBe(MAX_SUGGESTIONS);
});

test("drawSuggest never writes the state: a frozen input paints, sgSel past the rows is clamped for the highlight only, the box holds the capped rows", () => {
  const s = makeState(), L = makeLayout(160, 44), scr = new GridScreen(160, 44);
  s.commands.push(...Array.from({ length: 16 }, (_, i) => ({ name: `zz${i}`, description: `command ${i}` })));
  s.input = { ...s.input, text: "/zz", cur: 3, sgSel: 20 };
  const sugs = suggestions(s, s.files.paths);
  Object.freeze(s.input);
  const before = structuredClone(s.input);
  expect(() => drawSuggest(scr, L.messages, s, sugs, THEME)).not.toThrow();
  expect(s.input).toEqual(before);
  expect(s.input.sgSel).toBe(20);
  expect(scr.toText()).toMatch(new RegExp(`▸ /zz${MAX_SUGGESTIONS - 1}`)); // the last drawn row carries the highlight
  const top = scr.cells.findIndex((r) => r.includes("╭")), bottom = scr.cells.findIndex((r) => r.includes("╰"));
  expect(bottom - top + 1).toBe(MAX_SUGGESTIONS + 3); // rows + title + borders: the box height follows the cap
  expect(top).toBe(L.messages.y + 1); // 11 rows do not fit above the prompt of a 14-row panel: clamped to the first inner row
});

test("onPaletteKey backspace removes a whole code point (😀 is one)", () => {
  const s = makeState();
  openPalette(s);
  s.palette!.query = "a😀";
  onPaletteKey(s, key("backspace"), () => {});
  expect(s.palette!.query).toBe("a");
});

// ---------- palette ----------

test("paletteItems: commands (local + setCommands), theme, view (modes + focus), open (every file) with string actions", () => {
  const s = makeState(), items = paletteItems(s);
  const groups = [...new Set(items.map((i) => i.group))];
  expect(groups).toEqual(["commands", "theme", "view", "open"]);
  expect(items.filter((i) => i.group === "commands").map((i) => i.action)).toEqual(allCommands(s).map((c) => "/" + c.name));
  expect(items.filter((i) => i.group === "theme").map((i) => i.action)).toEqual(["theme:night", "theme:ember", "theme:contrast"]);
  expect(items.filter((i) => i.group === "view").map((i) => i.action)).toEqual(["mode:code", "mode:diff", "mode:run", "mode:agents", "focus:messages", "focus:code", "focus:files"]);
  expect(items.filter((i) => i.group === "open").map((i) => i.action)).toEqual(FILES.map((f) => "open:" + f));
  expect(paletteHint(s, { label: "/help", group: "commands", action: "/help" })).toBe("commands + keys card");
  expect(paletteHint(s, { label: "diff view", group: "view", action: "mode:diff" })).toBe("⌃d");
  expect(paletteHint(s, { label: "x", group: "open", action: "open:src/core/session.ts" })).toBe("M");
  expect(paletteHint(s, { label: "theme ember", group: "theme", action: "theme:ember" })).toBe("ink + ember");
});

test("paletteVisible: no query shows everything with `open` capped at 6; a query fuzzy-filters and keeps the group order", () => {
  const s = makeState();
  openPalette(s);
  const all = paletteVisible(s.palette!);
  expect(all.filter((i) => i.group === "open").length).toBe(6);
  expect(all.filter((i) => i.group !== "open").length).toBe(paletteItems(s).filter((i) => i.group !== "open").length);
  s.palette!.query = "diff";
  const vis = paletteVisible(s.palette!);
  expect(vis.map((i) => i.label)).toEqual(["/diff", "diff view"]);
  s.palette!.query = "session";
  expect(new Set(paletteVisible(s.palette!).map((i) => i.label))).toEqual(new Set(["src/core/session.ts", "test/unit/session.test.ts"]));
  s.palette!.query = "zzzz";
  expect(paletteVisible(s.palette!)).toEqual([]);
});

test("onPaletteKey: ↑↓ wrap over the visible rows, backspace/typing edit the query and reset sel, Enter closes then runs, Esc/⌃k close", () => {
  const s = makeState(), ran: string[] = [], run = (a: string) => { ran.push(a); };
  openPalette(s);
  onPaletteKey(s, key("up"), run);
  expect(s.palette!.sel).toBe(paletteVisible(s.palette!).length - 1);
  onPaletteKey(s, key("down"), run);
  expect(s.palette!.sel).toBe(0);
  for (const c of "embe") onPaletteKey(s, key(c), run);
  onPaletteKey(s, key("down"), run);
  onPaletteKey(s, key("r"), run);
  expect(s.palette).toMatchObject({ query: "ember", sel: 0 });
  onPaletteKey(s, key("backspace"), run);
  expect(s.palette!.query).toBe("embe");
  onPaletteKey(s, key("enter"), run);
  expect(ran).toEqual(["theme:ember"]);
  expect(s.palette).toBeNull();
  openPalette(s);
  onPaletteKey(s, key("escape"), run);
  expect(s.palette).toBeNull();
  openPalette(s);
  onPaletteKey(s, { type: "key", name: "k", ctrl: true }, run);
  expect(s.palette).toBeNull();
  openPalette(s);
  s.palette!.query = "zzzz";
  onPaletteKey(s, key("enter"), run); // no rows: closes, runs nothing
  expect(ran).toEqual(["theme:ember"]);
  expect(s.palette).toBeNull();
});

test("drawPalette: title, query line with the cursor cell, group headers, the selected row, hints, 'no matches'; hits = closer, box, rows", () => {
  const s = makeState(), L = makeLayout(160, 44), scr = new GridScreen(160, 44), hits: HitZone[] = [];
  openPalette(s);
  const cur = drawPalette(scr, L, THEME, s, fuzzy, hits);
  const txt = scr.toText();
  expect(txt).toContain(" commands ");
  expect(txt).toContain("commands, themes, views, files…");
  expect(txt).toContain("esc");
  expect(txt).toMatch(/▸ \/help +commands \+ keys card/);
  expect(cur).toEqual({ x: Math.floor((160 - 72) / 2) + 4, y: Math.max(2, Math.floor(44 * 0.14)) + 1 });
  expect(hits[0]!.rect).toEqual({ x: 0, y: 0, w: 160, h: 44 });
  expect(hits[1]!.rect.w).toBe(72);
  expect(hits.length).toBeGreaterThan(3);
  hits[3]!.onClick(); // a row click selects it (and replays Enter via key)
  expect(hits[3]!.key).toEqual({ type: "key", name: "enter" });
  hits[0]!.onClick();
  expect(s.palette).toBeNull();
  openPalette(s);
  s.palette!.query = "zzzz";
  const n = new GridScreen(160, 44);
  const c2 = drawPalette(n, L, THEME, s);
  expect(n.toText()).toContain("no matches");
  expect(c2!.x).toBe(Math.floor((160 - 72) / 2) + 4 + 4);
  s.palette!.query = "the";
  const t = new GridScreen(160, 44);
  drawPalette(t, L, THEME, s);
  expect(t.toText()).toMatch(/ {3}commands +│\n.*▸ \/theme +switch palette/); // group header then the selected row
  expect(t.toText()).toMatch(/ {3}theme +│\n.*theme night +night \+ mint/); // the next group, unselected rows
  expect(t.toText()).toMatch(/theme ember +ink \+ ember/);
  closePalette(s);
  expect(drawPalette(new GridScreen(160, 44), L, THEME, s)).toBeNull();
});

// ---------- help ----------

test("drawHelp: commands column (local rows first, setCommands after), the keys table, 'esc closes'; a full-screen hit closes it", () => {
  const s = makeState({ help: true }), L = makeLayout(160, 44), scr = new GridScreen(160, 44), hits: HitZone[] = [];
  drawHelp(scr, L, THEME, s, hits);
  const txt = scr.toText();
  expect(txt).toContain(" help ");
  expect(txt).toContain(" esc closes ");
  expect(txt).toMatch(/\/help +commands \+ keys card/);
  expect(txt).toMatch(/\/theme +switch palette +night·ember·contrast/);
  expect(txt).toMatch(/\/hello +custom greeting/);
  for (const [k, d] of HELP_KEYS) { expect(txt).toContain(k); expect(txt).toContain(d.slice(0, 20)); }
  expect(txt).toContain("⌃c");
  expect(helpRows(s).map((r) => r[0]).slice(0, 2)).toEqual(["/help", "/theme"]);
  expect(hits).toEqual([expect.objectContaining({ rect: { x: 0, y: 0, w: 160, h: 44 } })]);
  hits[0]!.onClick();
  expect(s.help).toBe(false);
});

test("drawHelp fits a short terminal: the command list is cut with an '… N more' row and the box stays inside the frame", () => {
  const s = makeState({ help: true });
  s.commands = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, description: `command ${i}` }));
  const L = makeLayout(120, 30), scr = new GridScreen(120, 30);
  drawHelp(scr, L, THEME, s);
  const txt = scr.toText();
  expect(txt).toMatch(/… +\d+ more · \/help lists all/);
  const rows = scr.cells.map((r) => r.join(""));
  expect(rows[0]!.trim()).toBe(""); // top frame row untouched
  expect(rows[29]!.trim()).toBe(""); // bottom frame row untouched
  expect(txt).not.toContain("/c29");
  // a tall terminal shows every row
  const tall = new GridScreen(160, 60);
  drawHelp(tall, makeLayout(160, 60), THEME, s);
  expect(tall.toText()).toContain("/c29");
  expect(tall.toText()).not.toContain("more ·");
});

// ---------- the picker box: a caller's title is data, not a layout contract ----------

/** the shape Renderer.pickOne produces (sextant-cards.ts pick): rows in one empty group, the title
 *  on the palette itself */
const pickerRows = (n: number) => Array.from({ length: n }, (_, i) => ({
  label: `${i === 0 ? "* " : "  "}anthropic/claude-model-${i}-20251101`, group: "", action: `pick:anthropic/m${i}`,
  ...(i === 0 ? { hint: "current" } : {}),
}));

test("a long picker title is clipped to the box and paints nothing outside it", () => {
  const s = makeState();
  const long = "pick a model — 128 from 9 providers (Esc = keep anthropic/claude-opus-5) " + "x".repeat(200);
  openPalette(s, pickerRows(6), long);
  const g = new GridScreen(100, 26);
  drawPalette(g, makeLayout(100, 26), THEME, s);
  const text = g.toText();
  expect(text).toContain("pick a model");
  expect(text).not.toContain("xxxx");            // the tail never reaches the screen
  expect(text).toMatch(/….?─*╮/);                 // it ends in an ellipsis before the corner
  // every cell outside the box is still blank: nothing was painted there
  const pw = Math.min(72, 100 - 10), px = Math.floor((100 - pw) / 2);
  for (const row of g.cells) {
    for (let x = 0; x < px; x++) expect(row[x]).toBe(" ");
    for (let x = px + pw; x < 100; x++) expect(row[x]).toBe(" ");
  }
});

test("a long GROUP name is clipped too — a group is data as much as a title is", () => {
  const s = makeState();
  const rows = pickerRows(3);
  rows[0]!.group = "g".repeat(300);
  openPalette(s, rows, "pick a model");
  const g = new GridScreen(100, 26);
  drawPalette(g, makeLayout(100, 26), THEME, s);
  const pw = Math.min(72, 100 - 10), px = Math.floor((100 - pw) / 2);
  for (const row of g.cells) for (let x = px + pw; x < 100; x++) expect(row[x]).toBe(" ");
});

test("the command palette keeps its own title and placeholder; a picker says what it is", () => {
  const cmd = makeState();
  openPalette(cmd, [{ label: "/help", group: "start here", action: "/help" }]);
  const g1 = new GridScreen(100, 26);
  drawPalette(g1, makeLayout(100, 26), THEME, cmd);
  expect(g1.toText()).toContain(" commands ");
  expect(g1.toText()).toContain("commands, themes, views, files…");

  const pick = makeState();
  openPalette(pick, pickerRows(2), "pick a model · 11 from 1 provider");
  const g2 = new GridScreen(100, 26);
  drawPalette(g2, makeLayout(100, 26), THEME, pick);
  expect(g2.toText()).toContain("pick a model · 11 from 1 provider");
  expect(g2.toText()).not.toContain(" commands ");
  expect(g2.toText()).toContain("type to filter…");
});

test("an explicit hint is shown — PaletteState says it overrides the derived one, and now it does", () => {
  const s = makeState();
  openPalette(s, pickerRows(3), "pick a model");
  const g = new GridScreen(100, 26);
  drawPalette(g, makeLayout(100, 26), THEME, s);
  expect(g.toText()).toContain("current");
});
