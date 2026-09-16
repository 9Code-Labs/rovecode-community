/** LSP server table (ported from the Nimbus harness, PORT #73): the `lsp` knob — `ext[,ext…]=argv[;…]` — merged over
 *  the built-in typescript-language-server entry. Pure: no probe, no spawn, no I/O — coding/lsp-gate.ts consumes the
 *  resolved table after a successful edit, coding/lsp.ts takes the languageId for didOpen.
 *
 *  Where the value comes from (rovecode has one env prefix and one settings file, not Nimbus's layered reader):
 *  ROVECODE_LSP when defined — even "" (a defined-empty value means the defaults) — else the project
 *  `.rovecode/settings.json` key `lsp`, handed in by the caller (resolveServerTable never reads a file), else blank.
 *
 *  Grammar (ONE string, flat like every other knob): entries separated by `;`; each entry is one or more extensions
 *  (`py`, `.PY`, `.py,.pyi` normalise to `.py`, `.pyi`) then `=` then the server argv — whitespace-split, double
 *  quotes group a path with spaces, NO implicit `--stdio`; `ext=off` disables that extension; the bare value `off`
 *  disables every server; blank = the defaults. Entries MERGE over DEFAULT_SERVERS (unset = the #13 behaviour byte
 *  for byte; `.py=pyright-langserver --stdio` adds Python without restating TS). A malformed value is a problem
 *  string (lspTableProblem), never silence: the settings layer should refuse it; an env value is read at gate time,
 *  where its malformed entries are skipped and the valid ones apply — the gate has no error channel.
 *
 *  Pattern source: opencode packages/opencode/src/lsp/lsp.ts:151-181 (the config table overlays the built-in server
 *  set by name; a disabled entry deletes it), :213 / :254-255 (a file's extension selects the server), :221-227 /
 *  :259 (a broken server is remembered and never retried), server.ts:125 (which-probe before spawn) — MIT, pattern
 *  level, no code copied. Deliberate deviations: entries map extension → argv 1:1 instead of named servers carrying
 *  extension lists; no root-marker walk (every gate is keyed on the cwd root); no auto-install (network is out).
 *  LANGUAGE_IDS is hand-typed from the LSP specification's language-identifier list. */

/** a plain environment map (process.env, or an injected one in tests) */
export type Env = Readonly<Record<string, string | undefined>>;

/** the env spelling of the knob */
export const LSP_ENV = "ROVECODE_LSP";

/** the built-in entry: #13's TS/JS extensions → typescript-language-server over stdio */
export const DEFAULT_SERVER_ARGV: readonly string[] = ["typescript-language-server", "--stdio"];
const DEFAULT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
export const DEFAULT_SERVERS: ReadonlyMap<string, readonly string[]> = new Map(DEFAULT_EXTENSIONS.map((e) => [e, DEFAULT_SERVER_ARGV]));
/** the knob's documented default: the built-in table written in the knob's own grammar (parses back to DEFAULT_SERVERS) */
export const DEFAULT_LSP_TABLE = `${DEFAULT_EXTENSIONS.join(",")}=${DEFAULT_SERVER_ARGV.join(" ")}`;

/** didOpen `languageId` per extension — the LSP specification's language identifiers, hand-typed (the TS/JS eight are
 *  #13's); anything else → the bare extension (most identifiers equal it), no extension → plaintext */
export const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".kt": "kotlin",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".cs": "csharp",
  ".php": "php", ".swift": "swift", ".scala": "scala", ".lua": "lua", ".pl": "perl", ".r": "r", ".dart": "dart",
  ".ex": "elixir", ".exs": "elixir", ".erl": "erlang", ".fs": "fsharp", ".clj": "clojure", ".hs": "haskell",
  ".sh": "shellscript", ".bash": "shellscript", ".ps1": "powershell", ".sql": "sql", ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml",
  ".md": "markdown", ".tex": "latex", ".vue": "vue", ".toml": "toml",
};

export function languageIdFor(ext: string): string {
  const e = ext.toLowerCase();
  const bare = e.startsWith(".") ? e.slice(1) : e;
  return LANGUAGE_IDS[e] ?? (bare === "" ? "plaintext" : bare);
}

export interface ParsedServerTable {
  /** normalised extension → argv, or null for `ext=off` */
  table: Map<string, string[] | null>;
  /** the bare value `off`: every server disabled */
  off: boolean;
  /** every problem, one line each — empty for a valid value */
  problems: string[];
}

/** `py`, `.PY`, ` .Py ` → ".py"; null when the text is not an extension (letters, digits, `_`, `+`, `-`) */
export function normalizeExt(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9_+-]+$/.test(s) ? `.${s}` : null;
}

/** whitespace split with double-quote grouping (`"C:\Program Files\x\srv.exe" --stdio` → two tokens); null = unbalanced quote */
export function tokenizeArgv(text: string): string[] | null {
  const out: string[] = [];
  let cur = "", quoted = false, open = false;
  for (const ch of text) {
    if (ch === '"') { quoted = !quoted; open = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (open) out.push(cur); cur = ""; open = false; continue; }
    cur += ch; open = true;
  }
  if (quoted) return null;
  if (open) out.push(cur);
  return out;
}

/** Parse one knob value (header grammar). Never throws; every problem is collected. */
export function parseServerTable(text: string): ParsedServerTable {
  const out: ParsedServerTable = { table: new Map(), off: false, problems: [] };
  const value = text.trim();
  if (value === "") return out;
  if (value.toLowerCase() === "off") { out.off = true; return out; }
  for (const rawEntry of value.split(";")) {
    const entry = rawEntry.trim();
    if (entry === "") continue; // a trailing `;`
    const eq = entry.indexOf("=");
    if (eq < 0) { out.problems.push(`entry "${entry}" has no "=" (ext[,ext]=argv, ext=off, or the bare value off)`); continue; }
    const exts: string[] = [];
    for (const raw of entry.slice(0, eq).split(",")) {
      const ext = normalizeExt(raw);
      if (ext === null) { out.problems.push(`entry "${entry}": "${raw.trim()}" is not a file extension (letters, digits, _ + -)`); continue; }
      if (out.table.has(ext) || exts.includes(ext)) { out.problems.push(`entry "${entry}": ${ext} is listed twice`); continue; }
      exts.push(ext);
    }
    const rhs = entry.slice(eq + 1).trim();
    let argv: string[] | null = null;
    if (rhs.toLowerCase() !== "off") {
      const tokens = tokenizeArgv(rhs);
      if (tokens === null) { out.problems.push(`entry "${entry}": unbalanced double quote in the argv`); continue; }
      if (tokens.length === 0) { out.problems.push(`entry "${entry}": empty argv (ext=argv, or ext=off to disable)`); continue; }
      argv = tokens;
    }
    for (const ext of exts) out.table.set(ext, argv);
  }
  return out;
}

/** The settings-layer validator: every problem joined, or null when the value parses. */
export function lspTableProblem(text: string): string | null {
  const { problems } = parseServerTable(text);
  return problems.length === 0 ? null : problems.join("; ");
}

/** where a table value comes from: the env map (ROVECODE_LSP wins when defined, even "") and the project
 *  settings value the caller read (`lsp` key), if any */
export interface LspSource {
  env?: Env;
  settings?: string | undefined;
}

/** the raw knob value the gate will parse, and where it came from — for the surfaces ("lsp (settings): …") */
export function lspTableValue(src: LspSource = {}): { value: string; source: "env" | "settings" | "default" } {
  const env = (src.env ?? process.env)[LSP_ENV];
  if (env !== undefined) return { value: env, source: "env" };
  if (src.settings !== undefined) return { value: src.settings, source: "settings" };
  return { value: "", source: "default" };
}

/** The effective table for a gate: DEFAULT_SERVERS with the knob's entries merged over it (`ext=off` deletes);
 *  the bare `off` → an empty map (zero probes). */
export function resolveServerTable(src: LspSource = {}): Map<string, string[]> {
  const parsed = parseServerTable(lspTableValue(src).value);
  if (parsed.off) return new Map();
  const out = new Map<string, string[]>();
  for (const [ext, argv] of DEFAULT_SERVERS) out.set(ext, [...argv]);
  for (const [ext, argv] of parsed.table) { if (argv === null) out.delete(ext); else out.set(ext, argv); }
  return out;
}
