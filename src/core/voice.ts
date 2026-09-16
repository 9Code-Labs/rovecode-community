/** rovecode's voice — the one place user-facing wording lives: mode labels, the no-model recipe, the
 *  welcome card, the panels' empty-state hints. First person, short plain sentences, one idea per
 *  line, no emoji; the ◆ glyph marks rovecode's own lines; a problem always ends with the next step.
 *  Pure strings and string builders: every surface (CLI, REPL, TUI, server, ACP) reads from here so a
 *  wording change lands everywhere at once. */

/** the permission modes as the screen names them; the flags/commands keep their names (--yolo, /yolo, ROVECODE_YOLO) */
export const MODE_ASK = "ask first";
export const MODE_AUTO = "auto (never asks)";
export const MODE_ACCEPT = "accept edits";

/** "ask first" | "auto (never asks)" — the status/notes label for the yolo flag */
export function modeLabel(yolo: boolean): string { return yolo ? MODE_AUTO : MODE_ASK; }
/** compact form for footers and status bars: "ask first" | "auto" */
export function modeLabelShort(yolo: boolean): string { return yolo ? "auto" : MODE_ASK; }
/** what each mode means, in one sentence */
export function modeMeaning(yolo: boolean): string {
  return yolo ? "I won't stop to ask before writes or shell commands" : "I ask before I write or run anything";
}

/** the marker every problem message ends with */
export const NEXT = "→ next:";
export const next = (text: string): string => `${NEXT} ${text}`;

/** The no-model recipe — three lines, `rovecode setup` first. `where` picks the commands that exist
 *  on that surface; the first line is stable ("no provider configured") for callers that match it. */
export function noModelHint(where: "cli" | "tui" = "cli"): string {
  const setup = where === "tui" ? "/setup" : "rovecode setup";
  const alt = where === "tui"
    ? "/provider add <id> <baseUrl> · /provider key <id> <secret>"
    : "rovecode provider add <id> <baseUrl>, then rovecode auth set <id>";
  return [
    "no provider configured — no model to think with yet.",
    `  ${next(setup)}   (pick a provider, paste the key hidden, one test call)`,
    `  or: ${alt} · or set ROVECODE_BASE_URL + ROVECODE_API_KEY`,
  ].join("\n");
}

/** `rovecode run` with nothing configured answers from a scripted mock; this is what it says. */
export const MOCK_PROVIDER_TEXT =
  `Rovecode mock provider: no model is connected, so this is a canned reply. ${next("rovecode setup")} (or rovecode provider add <id> <baseUrl> + rovecode auth set <id>, or set ROVECODE_BASE_URL and ROVECODE_API_KEY)`;

export interface WelcomeOpts {
  /** the session's provider/model when one is connected; null = nothing configured */
  connected: { provider: string; model: string } | null;
  cwd: string;
  yolo: boolean;
  /** plan/act; act is the default and is not mentioned */
  mode?: "plan" | "act";
  /** the running version, so "which rovecode is this" never needs a second command */
  version?: string;
  /** what this session actually loaded. Zeroes are omitted rather than printed: a line reading
   *  "0 skills · 0 plugins · 0 MCP servers" is three facts nobody asked for, while "19 skills · 2 MCP
   *  servers" is the answer to "did my install take". */
  loaded?: { skills?: number; plugins?: number; mcp?: number };
  /** the one-line update notice, when there is one; see core/update-check.ts */
  update?: string | null;
  /** columns available; under BANNER_COLS the wordmark is dropped rather than wrapped (default 80) */
  width?: number;
}

/** ROVECODE in half-block letters, two rows. Berkay picked this over a boxed header and a plain block
 *  (2026-09-06). It is 31 columns wide, so it fits a narrow split, and it only appears when the card
 *  knows the version — a banner with nothing to say under it is decoration. */
const WORDMARK = ["█▀█ █▀█ █ █ █▀▀ █▀▀ █▀█ █▀▄ █▀▀", "█▀▄ █▄█ ▀▄▀ █▄▄ █▄▄ █▄█ █▄▀ █▄▄"] as const;
const BANNER_COLS = 46;

/** "19 skills · 3 plugins · 2 MCP servers", counting only what is there. Null when nothing loaded,
 *  because the absence of the line says that better than the line saying zero three times. */
export function loadedLine(loaded: WelcomeOpts["loaded"]): string | null {
  if (!loaded) return null;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const bits: string[] = [];
  if (loaded.skills) bits.push(plural(loaded.skills, "skill"));
  if (loaded.plugins) bits.push(plural(loaded.plugins, "plugin"));
  if (loaded.mcp) bits.push(plural(loaded.mcp, "MCP server"));
  return bits.length > 0 ? bits.join(" · ") : null;
}

/** The card a fresh session opens with (the messages panel's first note). */
export function welcomeCard(o: WelcomeOpts): string {
  const where = `${o.cwd} · ${modeLabelShort(o.yolo)}${o.mode === "plan" ? " · plan mode (read-only)" : ""}`;
  const version = o.version ? ` ${o.version}` : "";
  // the two optional footers, in the order a reader wants them: what this session has, then what it
  // could have. Both drop out entirely when there is nothing to say — see loadedLine and updateLine.
  const tail = [loadedLine(o.loaded), where, o.update ?? null].filter((l): l is string => l !== null);
  // The banner form: the wordmark, then one line per fact. It needs a version (there is nothing to put
  // beside the mark otherwise) and room (under BANNER_COLS the mark would wrap into noise), and it falls
  // back to exactly the prose card below — which is what a resumed or narrow session still sees.
  if (o.version !== undefined && (o.width ?? 80) >= BANNER_COLS) {
    const model = o.connected === null ? null
      : o.connected.model.length > 0 ? `${o.connected.provider}/${o.connected.model}` : o.connected.provider;
    const loaded = loadedLine(o.loaded);
    return [
      `  ${WORDMARK[0]}`,
      `  ${WORDMARK[1]}  ${o.version}`,
      "",
      model === null ? "  no model connected yet — /setup fixes that in about a minute"
        : `  ${[model, loaded].filter((s) => s !== null).join(" · ")}`,
      `  ${where}`,
      ...(model === null ? [] : [`  I read first, then ${o.yolo ? "work without asking" : "ask before I write or run anything"}. /help lists commands by topic.`]),
      ...(o.update ? [`  ${o.update}`] : []),
    ].join("\n");
  }
  if (o.connected === null) {
    return [
      `◆ rovecode${version} here. No model connected yet, so I can't think.`,
      "/setup fixes that in about a minute.",
      ...tail,
    ].join("\n");
  }
  const model = o.connected.model.length > 0 ? `${o.connected.provider}/${o.connected.model}` : o.connected.provider;
  return [
    `◆ rovecode${version} here. Connected to ${model}.`,
    `Tell me what you want done; I read first, then ${o.yolo ? "work without asking" : "ask before I write or run anything"}.`,
    "/help lists commands by topic.",
    ...tail,
  ].join("\n");
}

/** one-liner for a resumed session (its transcript is the card) */
export function resumedLine(id: string, cwd: string, yolo: boolean): string {
  return `◆ back in session ${id.slice(0, 8)} · ${cwd} · ${modeLabelShort(yolo)}`;
}

/** the /effort note. Says what the level costs, because that is the part that surprises people:
 *  thinking tokens are billed as output and they arrive before any answer does. */
export function effortNote(level: string, receives?: string): string {
  const head = level === "off" ? "thinking: off — I answer straight away."
    : level === "auto" ? "thinking: auto — the model decides how much to reason; I send no dial."
    : `thinking: ${level} — I reason before answering. It costs output tokens and delays the first word.`;
  // the second line is the truth on the wire (providers/thinking.ts thinkingLine): the level is one word,
  // what this model's endpoint actually receives for it is another, and a model without a reasoning mode
  // receives nothing at all — the person should not have to guess which
  return receives ? `${head}\n  ${receives}` : head;
}

/** the /yolo toggle's note */
export function modeSwitchNote(yolo: boolean): string {
  return `mode: ${modeLabel(yolo)} — ${modeMeaning(yolo)}`;
}

/** the /accept-edits toggle's note. Says the boundary out loud: this is not auto mode, and the two
 *  things it does NOT cover are the two that can leave the repository. */
export function acceptEditsNote(on: boolean): string {
  return on
    ? `mode: ${MODE_ACCEPT} — I write inside this folder without asking. Shell commands, subagents, network and any write outside it still ask, and deny rules still hold.`
    : `mode: ${MODE_ASK} — I ask before every write again.`;
}

// ---------- panel empty states (one dim line each; a second line only when the panel has room) ----------

export const EMPTY = {
  code: "nothing open — when I read a file it shows here",
  files: ["no files yet", "they appear as I read them"] as const,
  plan: ["no plan yet", "my steps show up here"] as const,
  usage: "0 so far",
} as const;
