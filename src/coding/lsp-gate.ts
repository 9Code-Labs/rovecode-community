/** LSP diagnostics gate (PORT #13; server table PORT #73, both ported from the Nimbus harness): discovery + the bounded
 *  post-edit note over the coding/lsp.ts LspClient, the per-root default gates, the write-tool wrapper, and the
 *  boot-time "this is NOT running here" line. Moved out of lsp.ts (which keeps the wire only) when the ONE built-in
 *  server became a table (coding/lsp-servers.ts, knob `lsp`): after a successful edit/write the touched file's
 *  lower-cased extension is looked up (miss → "" — no probe, no spawn); each DISTINCT argv is probed ONCE per root —
 *  argv[0] holding a path separator → existsSync (relative to the root), else Bun.which over PATH (+ PATHEXT) — and a
 *  miss turns THAT argv off for the process (never re-probed; the other servers are untouched); a hit spawns exactly
 *  the configured argv (no implicit `--stdio`); extensions sharing an argv share ONE server per root; the note label
 *  is the configured argv[0]'s basename minus extension, sanitised to [A-Za-z0-9._-] (`typescript-language-server`
 *  by default, so core/reflection.ts parses the note unchanged). The table is resolved lazily on the first note().
 *  Every #13 guarantee holds: ≤2 s hard deadline per note, wedged/dead never retried, per-root LRU-4, garbage/laggy
 *  frames survive; diagnostics ONLY — no goto/refs/hover/completion.
 *
 *  Beside the verify gate (core/verify-gate.ts), not under it: this runs per edit, costs at most 2 s, feeds the
 *  model the error it just made, and is on wherever a server already exists (a probe miss is free). The verify
 *  gate runs the project's own command once at the end and is off by default because it costs 3–170 s. Its knob is
 *  ROVECODE_VERIFY; this one's is the `lsp` table (ROVECODE_LSP / settings `lsp`; `off` disables).
 *
 *  Degradation is NAMED, never silent to the person: the tool result stays clean when no server is there (the model
 *  has nothing to act on), and lspAvailabilityNote says once, at boot and in `rovecode doctor`, which extensions are
 *  not being checked and why — the built-in TS entry when the project has a tsconfig.json, any configured entry
 *  whose binary is missing. Nothing is installed on anyone's behalf.
 *
 *  Pattern source (MIT, pattern level, no code copied): opencode packages/opencode/src/lsp/lsp.ts:213 / :254-255
 *  (a file's extension selects the server), :221-227 / :259 (a broken server key is remembered, never retried),
 *  :360 (swallow-all gate errors), server.ts:125 (which-probe, then spawn); the hand-rolled reader is oh-my-pi's
 *  shape (credited in lsp.ts). The `cmd` / `serverName` test hooks keep their #13 meaning for the BUILT-IN entry only
 *  (cmd bypasses its probe, serverName swaps its probe target). */

import { existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { Tool, ToolOutput } from "../core/types.ts";
import { loadSettings } from "../core/settings.ts";
import { LspClient, formatGateNote, type Diagnostic } from "./lsp.ts";
import { DEFAULT_SERVER_ARGV, LSP_ENV, lspTableProblem, lspTableValue, resolveServerTable, type Env } from "./lsp-servers.ts";

// ---------- gate: discovery + bounded note ----------

export interface GateOptions {
  root?: string;           // workspace root (default process.cwd())
  /** the resolved server table (tests); default resolveServerTable over env + the project settings, read on the first note() */
  servers?: ReadonlyMap<string, readonly string[]>;
  /** the env map the table is read from (tests); default process.env */
  env?: Env;
  /** the project settings `lsp` value (tests); default: `.rovecode/settings.json` at the root, key `lsp`, if the settings layer knows it */
  settingsValue?: string;
  serverName?: string;     // the built-in entry's probe target (default "typescript-language-server") — tests
  cmd?: string[];          // the built-in entry's explicit argv — bypasses its probe (tests)
  /** the PATH probe (tests count calls); default Bun.which */
  which?: (name: string) => string | null;
  settleMs?: number;       // diagnostics settle window, clamped ≤2000
  hardDeadlineMs?: number; // absolute cap per note() call, clamped ≤2000 (default 2000)
  initTimeoutMs?: number;  // background initialize cap before kill (default 8000)
  debounceMs?: number;
}

export interface LspGate {
  /** "" when feature off / no errors / timed out; otherwise "\n\nlsp-gate ..." */
  note(absPath: string): Promise<string>;
  dispose(): void;
  /** the most recently constructed client — null before the first spawn or when every probe missed */
  readonly client: LspClient | null;
  /** every client this root spawned, one per distinct argv (probe misses excluded) */
  clients(): LspClient[];
}

const DEFAULT_KEY = DEFAULT_SERVER_ARGV.join("\0");

/** the project settings `lsp` value at `root`, or undefined — core/settings.ts decides whether the key exists at all
 *  (a key it does not sanitize is invisible here, and ROVECODE_LSP still works); a missing or corrupt file is undefined */
export function settingsLspValue(root: string): string | undefined {
  try {
    const v = (loadSettings(root) as { lsp?: unknown }).lsp;
    return typeof v === "string" ? v : undefined;
  } catch { return undefined; }
}

/** the note's `lsp-gate (<label>)`: argv[0]'s basename minus its extension, sanitised to [A-Za-z0-9._-] */
export function serverLabel(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "") || base;
  const clean = stem.replace(/[^A-Za-z0-9._-]/g, "");
  return clean === "" ? "lsp" : clean;
}

/** ONE probe per distinct argv per root (opencode server.ts:125 which-then-spawn): argv[0] with a path separator must
 *  exist — resolved against the root; a bare name is looked up on PATH (+ PATHEXT). null = off for the process. */
function probe(argv: readonly string[], root: string, which: (name: string) => string | null): string[] | null {
  const head = argv[0];
  if (head === undefined || head === "") return null;
  const bin = /[\\/]/.test(head) ? (existsSync(resolve(root, head)) ? resolve(root, head) : null) : which(head);
  return bin === null ? null : [bin, ...argv.slice(1)];
}

/** the table a root sees: an injected one, else env + this root's settings value */
function tableFor(root: string, opts: GateOptions): ReadonlyMap<string, readonly string[]> {
  return opts.servers ?? resolveServerTable({ env: opts.env ?? process.env, settings: opts.settingsValue ?? settingsLspValue(root) });
}

export function createLspGate(opts: GateOptions = {}): LspGate {
  const root = opts.root ?? process.cwd();
  const hard = Math.min(opts.hardDeadlineMs ?? 2000, 2000);
  const which = opts.which ?? ((name: string): string | null => Bun.which(name));
  const clientOpts = {
    ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
    ...(opts.initTimeoutMs !== undefined ? { initTimeoutMs: opts.initTimeoutMs } : {}),
    ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
  };
  let table: ReadonlyMap<string, readonly string[]> | undefined; // resolved on the first note()
  const clients = new Map<string, LspClient | null>(); // argv key → client; absent = unprobed, null = probe miss (off, never re-probed)
  let last: LspClient | null = null;
  const clientFor = (argv: readonly string[]): { client: LspClient | null; label: string } => {
    const key = argv.join("\0");
    const builtIn = key === DEFAULT_KEY;
    const label = builtIn && opts.serverName !== undefined ? opts.serverName : serverLabel(argv[0] ?? "");
    let client = clients.get(key);
    if (client === undefined) {
      const cmd = builtIn && opts.cmd !== undefined
        ? opts.cmd
        : probe(builtIn && opts.serverName !== undefined ? [opts.serverName, ...argv.slice(1)] : argv, root, which);
      client = cmd === null ? null : new LspClient({ cmd, root, ...clientOpts });
      clients.set(key, client);
      if (client !== null) last = client;
    }
    return { client, label };
  };
  return {
    get client(): LspClient | null { return last; },
    clients(): LspClient[] { return [...clients.values()].filter((c): c is LspClient => c !== null); },
    async note(absPath: string): Promise<string> {
      table ??= tableFor(root, opts);
      const argv = table.get(extname(absPath).toLowerCase());
      if (argv === undefined) return ""; // not a gated extension (or every server off): no probe, no spawn
      const { client, label } = clientFor(argv);
      if (client === null || client.state === "dead") return ""; // absent/broken → silently off (said once at boot instead)
      // hard deadline: a cold or wedged server can never block the loop; the swallowed touch
      // continues (or gets killed by initTimeout) in the background (opencode lsp.ts:360).
      // The deadline timer is cleared when touch settles first — a stray ref'd timer would
      // hold the host's event loop open for up to 2s after every edit.
      const c = client;
      const diags = await new Promise<Diagnostic[] | null>((resolve) => {
        const t = setTimeout(() => resolve(null), hard);
        c.touch(absPath).then(
          (d) => { clearTimeout(t); resolve(d); },
          () => { clearTimeout(t); resolve(null); },
        );
      });
      return diags === null ? "" : formatGateNote(absPath, diags, label);
    },
    dispose(): void { for (const c of clients.values()) c?.kill(); },
  };
}

// ---------- the absence, said once ----------

/** Startup lines for every server the gate CANNOT run here, or null when there is nothing to say.
 *
 *  The gate is silent by design when a server is missing (the note above is "" and the edit succeeds as it
 *  should) — and that silence let everyone credit a diagnostics loop that was not running: on the machine this
 *  was written on, typescript-language-server was not on PATH and no edit had ever been type-checked. Silence is
 *  right for the TOOL RESULT (the model has nothing to act on); it is wrong for the person, who was promised the
 *  loop. So the absence is said once, at boot, next to the other "this is off" notes, and in `rovecode doctor`.
 *  The built-in TS entry is only reported for a TypeScript project (a tsconfig.json at the root): elsewhere
 *  nothing was promised. A CONFIGURED entry was promised by whoever wrote it, so a missing binary is always
 *  named, with the extensions it was meant to cover. `off` and `ext=off` are choices, not absences: nothing. */
export function lspAvailabilityNotes(root: string, which: (name: string) => string | null = (n) => Bun.which(n), serverName = "typescript-language-server", opts: Pick<GateOptions, "env" | "settingsValue" | "servers"> = {}): string[] {
  const notes: string[] = [];
  // a malformed table is a problem string, never silence: the gate applies the valid entries and skips the rest, so
  // the person is told here which entry was ignored and where it was written (the settings layer keeps it as written)
  if (opts.servers === undefined) {
    const raw = lspTableValue({ env: opts.env ?? process.env, settings: opts.settingsValue ?? settingsLspValue(root) });
    const problem = lspTableProblem(raw.value);
    if (problem !== null) notes.push(`lsp: the \`lsp\` table (${raw.source === "env" ? LSP_ENV : ".rovecode/settings.json lsp"}) has a problem — ${problem}; that entry is ignored, the rest of the table applies`);
  }
  const table = tableFor(root, opts);
  const byArgv = new Map<string, { argv: readonly string[]; exts: string[] }>();
  for (const [ext, argv] of table) {
    const key = argv.join("\0");
    const e = byArgv.get(key);
    if (e) e.exts.push(ext); else byArgv.set(key, { argv, exts: [ext] });
  }
  for (const [key, { argv, exts }] of byArgv) {
    if (key === DEFAULT_KEY) {
      if (!existsSync(join(root, "tsconfig.json"))) continue;
      if (which(serverName) !== null) continue;
      notes.push(`lsp: ${serverName} is not on PATH — edits and writes are NOT type-checked, and the model gets no diagnostics after them (npm i -g typescript-language-server typescript)`);
      continue;
    }
    if (probe(argv, root, which) !== null) continue;
    const head = argv[0] ?? "";
    const where = /[\\/]/.test(head) ? `is not at ${resolve(root, head)}` : "is not on PATH";
    notes.push(`lsp: ${head} (${exts.sort().join(", ")}) ${where} — edits to those files are NOT checked (the \`lsp\` setting names it; fix the path or install it)`);
  }
  return notes;
}

/** the notes above as ONE string or null — the shape cli/runtime.ts (a plugin warning) and cli/doctor.ts (one row
 *  detail, which strips the leading "lsp: ") consume: the first line keeps its prefix, the rest are indented under it */
export function lspAvailabilityNote(root: string, which: (name: string) => string | null = (n) => Bun.which(n), serverName = "typescript-language-server"): string | null {
  const notes = lspAvailabilityNotes(root, which, serverName);
  return notes.length === 0 ? null : notes.map((n, i) => (i === 0 ? n : `     ${n.replace(/^lsp: /, "")}`)).join("\n");
}

// ---------- default gates (one per root) + tool wiring ----------

/** acp/http build per-session runtimes with per-caller cwds, so a single module-level gate
 *  bound the FIRST caller's root for the process lifetime and later sessions diagnosed
 *  against the wrong project (wrong tsconfig/paths). Keyed by resolved root; bounded LRU,
 *  since every live entry owns a server process. */
const MAX_DEFAULT_GATES = 4;
const defaultGates = new Map<string, LspGate>(); // insertion order doubles as LRU order

/** Post-edit hook for hashline's lint-gate point: await and append to successful tool output.
 *  `opts` (test hook) applies only when the root's gate is first constructed. */
export function lspGateNote(absPath: string, root?: string, opts?: Omit<GateOptions, "root">): Promise<string> {
  const key = resolve(root ?? process.cwd());
  let gate = defaultGates.get(key);
  if (gate !== undefined) {
    defaultGates.delete(key); // refresh LRU position
  } else {
    gate = createLspGate({ ...opts, root: key });
    if (defaultGates.size >= MAX_DEFAULT_GATES) {
      for (const [k, g] of defaultGates) { defaultGates.delete(k); g.dispose(); break; } // evict oldest
    }
  }
  defaultGates.set(key, gate);
  return gate.note(absPath);
}

/** dispose every default gate and forget it (test hook); returns them so exits can be awaited */
export function disposeDefaultGates(): LspGate[] {
  const gates = [...defaultGates.values()];
  defaultGates.clear();
  for (const g of gates) g.dispose();
  return gates;
}

/** Zero-touch alternative: wrap a write-kind tool (hashline editTool/writeTool) so every
 *  successful execution gets the diagnostics gate note appended to its output. */
export function withLspGate(tool: Tool, gate: (absPath: string) => Promise<string> = lspGateNote): Tool {
  if (tool.kind !== "write") return tool;
  return {
    ...tool,
    async execute(args: unknown, ctx): Promise<ToolOutput> {
      const out = await tool.execute(args, ctx);
      const rel = (args as { path?: unknown }).path;
      if (!out.ok || typeof rel !== "string") return out;
      const abs = isAbsolute(rel) ? rel : join(ctx.cwd, rel);
      if (!existsSync(abs)) return out;
      const note = await gate(abs);
      return note === "" ? out : { ...out, output: out.output + note };
    },
  };
}
