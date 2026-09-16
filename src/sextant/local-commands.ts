/** Sextant renderer-local commands (port #43): the slash lines and palette actions the renderer
 *  answers itself — /help /theme /open /diff /focus /agents — the /undo /permissions /mode notes
 *  (ALIAS_NOTE) and the state-then-hook effect helpers keys.ts shares with them. Ported from the
 *  user's own sextant v0.4.0 prototype app.js:1024-1029 (runSlash) and :944 (openFile); split out
 *  of keys.ts for the line budget — also the home for #44's further renderer-local commands.
 *  Pure over (state, ctx): no clock, no timers, no process access. A state field is written BEFORE
 *  the matching KeyCtx.local hook fires, so the renderer only loads content / rebuilds the palette.
 *  Everything that is not renderer-local (built-ins, custom commands, `!cmd`, free text, unknown
 *  `/x`) reaches ctx.hooks.onSubmit unchanged — app.ts handleSlash owns the rest. */

import type { KeyCtx } from "./keys.ts";
import { parseInput, resolveFile } from "./overlays.ts";
import { expandMentions } from "./mentions.ts";
import { THEME_ORDER, type CodeMode, type Focus, type SextantState, type ThemeName } from "./types.ts";
import { openHelp, openNotices } from "./overlays.ts";

/** prototype commands with an rovecode equivalent: a toast instead of a submission — unless
 *  setCommands lists a custom command of that name, which then runs like any other.
 *  `undo` is GONE from here since port #65: /undo is a real built-in that reaches onSubmit
 *  (tui/git-cmds.ts restores the previous checkpoint), no longer an alias note. */
export const ALIAS_NOTE: Record<string, string> = {
  permissions: "/permissions → use /yolo",
  mode: "/mode → use /plan or /act",
};

const isTheme = (v: string): v is ThemeName => (THEME_ORDER as readonly string[]).includes(v);

// ------------------------------------------------------------------ effects (state first, then the hook)

export function setTheme(s: SextantState, ctx: KeyCtx, name: ThemeName): void {
  s.theme = name;
  ctx.local.setTheme(name);
}

export function setMode(s: SextantState, ctx: KeyCtx, mode: CodeMode): void {
  s.code.mode = mode;
  s.code.scroll = 0;
  ctx.local.setMode(mode);
}

/** the crew board in the code panel (⌃a, /agents): lane closed, focus follows */
export function showAgents(s: SextantState, ctx: KeyCtx): void {
  setMode(s, ctx, "agents");
  s.code.laneOpen = false;
  s.focus = "code";
}

/** app.js:944 — parent dirs expand, the code panel shows the file; focus is the caller's call */
export function openFile(s: SextantState, ctx: KeyCtx, path: string): void {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) s.files.expanded.add(parts.slice(0, i).join("/"));
  s.code.file = path;
  s.code.mode = "code";
  s.code.scroll = 0;
  ctx.local.openFile(path);
}

/** the files panel only takes focus while the layout shows it (≥ 140 columns) */
export function setFocus(s: SextantState, ctx: KeyCtx, f: Focus): void {
  // a narrow terminal has no files column: page files into the main slot (draw-tabs.ts) instead of
  // refusing — "the files panel needs ≥ 140 columns" was the old answer, and it left files unreachable
  if (f === "files" && !ctx.layout.files) s.page = "files";
  s.focus = f;
}

// ------------------------------------------------------------------ dispatch

/** renderer-local slash commands run here; everything else (built-ins, custom, `!cmd`, free
 *  text, unknown `/x`) reaches onSubmit unchanged — app.ts handleSlash owns the rest */
export function dispatch(s: SextantState, text: string, ctx: KeyCtx): void {
  // the connect wizard IS this surface's /connect — THE connect command (Berkay, 2026-09-10: setup
  // is gone from the table; /setup still opens the wizard as a soft alias for muscle memory). With
  // an argument, /connect keeps its one-line contract: the answers are on the line
  if (text === "/setup" || text === "/connect") { ctx.local.openWizard(); return; }
  const p = parseInput(text);
  // `@file` in free text: the file goes with the message as a `read` result (mentions.ts) — this is the one
  // consumer of parseInput's `mentions`, and what the footer's "@ mentions attach files" has meant since
  if (p.kind === "text" && p.mentions.length > 0) {
    // port #54: an IMAGE mention takes the /attach seam (local.attachImage → the store's stage) instead of
    // dying as "a binary file" — it reaches the model as an image part and spends none of the text budget
    const r = expandMentions(text, { cwd: s.cwd, mentions: p.mentions, resolve: (m) => resolveFile(m, s.files.paths), attachImage: ctx.local.attachImage?.bind(ctx.local) });
    for (const n of r.notes) ctx.local.toast(n);
    ctx.hooks.onSubmit(r.text);
    return;
  }
  if (p.kind !== "slash" || !runLocal(s, p.cmd ?? "", p.arg ?? "", ctx)) ctx.hooks.onSubmit(text);
}

/** true when the line was answered here and must not reach onSubmit */
export function runLocal(s: SextantState, cmd: string, arg: string, ctx: KeyCtx): boolean {
  switch (cmd) {
    case "help":
      openHelp(s);
      return false; // the card opens AND /help reaches the transcript
    case "notices":
      openNotices(s);
      return true;
    case "market":
      // the overlay opens empty with a "loading" status; the renderer fills it when the catalog answers
      ctx.local.openMarket();
      return true;
    case "context":
      // counting is synchronous but not free on a long transcript, so the renderer does it off the frame
      ctx.local.openContext();
    case "wizard":
      // /connect and /setup on the sextant surface: the columned connect wizard (draw-wizard.ts),
      // reached here so the classic surface keeps its own pickOne chain untouched
      ctx.local.openWizard();
      return true;
      return true;
    case "theme":
      if (isTheme(arg)) setTheme(s, ctx, arg);
      else ctx.local.toast(`unknown theme "${arg}" · night, ember or contrast`);
      return true;
    case "open": {
      const p = resolveFile(arg, s.files.paths, ctx.fuzzy);
      if (!p) { ctx.local.toast(arg ? `no file matches "${arg}"` : "usage: /open <file>"); return true; }
      openFile(s, ctx, p);
      s.focus = "code";
      return true;
    }
    case "diff": {
      if (arg) {
        const p = resolveFile(arg, s.files.paths, ctx.fuzzy);
        if (!p) { ctx.local.toast(`no file matches "${arg}"`); return true; }
        s.code.file = p;
      }
      setMode(s, ctx, "diff");
      return true;
    }
    case "focus":
      if (arg === "messages" || arg === "code" || arg === "files") setFocus(s, ctx, arg);
      else ctx.local.toast("focus is messages, code or files");
      return true;
    case "agents":
      if (arg) return false; // port #62: `/agents list` (any argument) reaches app.ts handleSlash — the definitions list; the BARE /agents is this board
      showAgents(s, ctx);
      return true;
    default: {
      const note = ALIAS_NOTE[cmd];
      // a custom command of that name (listed by setCommands) wins over the note
      if (note && !s.commands.some((c) => c.name === cmd)) { ctx.local.toast(note); return true; }
      return false;
    }
  }
}

/** palette actions (overlays.ts paletteItems): a slash line, or theme: / mode: / focus: / open: */
export function runAction(s: SextantState, action: string, ctx: KeyCtx): void {
  if (action.startsWith("/")) {
    const p = parseInput(action), needsArg = ["theme", "open", "focus"].includes(p.cmd ?? "");
    if (needsArg && !p.arg) { // the argument is still missing: park the line in the prompt, options open
      s.input.text = action + " ";
      s.input.cur = s.input.text.length;
      s.input.sgSel = 0;
      s.focus = "messages";
      return;
    }
    dispatch(s, action, ctx);
    return;
  }
  const i = action.indexOf(":"), kind = action.slice(0, i), rest = action.slice(i + 1);
  if (kind === "theme" && isTheme(rest)) setTheme(s, ctx, rest);
  else if (kind === "mode") {
    setMode(s, ctx, rest as CodeMode);
    if (rest === "agents") s.code.laneOpen = false;
  } else if (kind === "focus") setFocus(s, ctx, rest as Focus);
  else if (kind === "open") { openFile(s, ctx, rest); s.focus = "code"; }
}
