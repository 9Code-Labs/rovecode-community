/** Rovecode TUI theme: raw ANSI styling (no chalk dep) + theme objects for vendored pi-tui
 *  components (EditorTheme / MarkdownTheme / SelectListTheme shapes from vendor). */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../../vendor/pi-tui/src/index.ts";

const esc = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export const st = {
  bold: esc("1", "22"),
  dim: esc("2", "22"),
  italic: esc("3", "23"),
  underline: esc("4", "24"),
  inverse: esc("7", "27"),
  strike: esc("9", "29"),
  fg: (n: number) => esc(`38;5;${n}`, "39"),
  bg: (n: number) => esc(`48;5;${n}`, "49"),
};

// palette (256-color): calm blues/teals for chrome, amber for warnings
export const pal = {
  accent: st.fg(75),     // sky blue — headings, borders
  accentDim: st.fg(67),
  ok: st.fg(114),        // green
  warn: st.fg(215),      // amber
  err: st.fg(203),       // red
  muted: st.dim,
  code: st.fg(180),
  link: st.fg(75),
};

export const rovecodeSelectListTheme: SelectListTheme = {
  selectedPrefix: (t) => pal.accent(t),
  selectedText: (t) => st.bold(t),
  description: (t) => st.dim(t),
  scrollInfo: (t) => st.dim(t),
  noMatch: (t) => st.dim(t),
};

export const rovecodeEditorTheme: EditorTheme = {
  borderColor: (t) => pal.accentDim(t),
  selectList: rovecodeSelectListTheme,
};

export const rovecodeMarkdownTheme: MarkdownTheme = {
  heading: (t) => st.bold(pal.accent(t)),
  link: (t) => pal.link(st.underline(t)),
  linkUrl: (t) => st.dim(t),
  code: (t) => pal.code(t),
  codeBlock: (t) => pal.code(t),
  codeBlockBorder: (t) => st.dim(t),
  quote: (t) => st.italic(st.dim(t)),
  quoteBorder: (t) => st.dim(t),
  hr: (t) => st.dim(t),
  listBullet: (t) => pal.accent(t),
  bold: (t) => st.bold(t),
  italic: (t) => st.italic(t),
  strikethrough: (t) => st.strike(t),
  underline: (t) => st.underline(t),
};
