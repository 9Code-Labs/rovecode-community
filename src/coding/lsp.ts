/** LSP diagnostics gate (PORT #13): minimal LSP-over-stdio JSON-RPC client.
 *  initialize → didOpen/didChange → collect publishDiagnostics; after a successful
 *  edit/write, diagnostics for the touched file are gathered within a bounded settle
 *  window (≤2s) and errors are appended to the tool output as a gate note.
 *
 *  Ported from opencode packages/opencode/src/lsp/ (client.ts, server.ts, diagnostic.ts):
 *  handshake+didOpen/didChange shapes from client.ts:211-255,554-621; publish caching and
 *  150ms rearming debounce from client.ts:13-16,160-172,464-497; errors-only formatter from
 *  diagnostic.ts:5-27; PATH probe + `--stdio` spawn from server.ts:115-142; swallow-all gate
 *  errors from lsp.ts:360; never-retry broken servers from lsp.ts:224-241. Framing is
 *  hand-rolled (rovecode adds no deps here; oh-my-pi client.ts hand-rolls the same reader).
 *  The gate (discovery, the bounded note, the per-root default gates, the tool wrapper) lives in
 *  coding/lsp-gate.ts and the server table (knob `lsp`) in coding/lsp-servers.ts — this module is the wire only. */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { languageIdFor } from "./lsp-servers.ts";

// ---------- wire framing (LSP base protocol, hand-rolled Content-Length) ----------

export function encodeFrame(msg: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "latin1"), body]);
}

/** Incremental Content-Length frame parser: push raw bytes, get decoded JSON messages. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): unknown[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return out;
      const header = this.buf.subarray(0, headerEnd).toString("latin1");
      const len = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      const start = headerEnd + 4;
      if (!Number.isFinite(len) || len < 0) { this.buf = this.buf.subarray(start); continue; } // malformed header: skip
      if (this.buf.byteLength < start + len) return out; // body incomplete: wait for more bytes
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      try { out.push(JSON.parse(body)); } catch { /* malformed body: skip frame */ }
    }
  }
}

// ---------- protocol subset ----------

export interface DiagPosition { line: number; character: number }
export interface Diagnostic {
  range: { start: DiagPosition; end: DiagPosition };
  severity?: number; // 1=Error 2=Warning 3=Info 4=Hint
  code?: number | string;
  source?: string;
  message: string;
}
interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}


// ---------- client ----------

export interface LspClientOptions {
  cmd: string[];          // argv, e.g. ["typescript-language-server", "--stdio"]
  root: string;           // workspace root → rootUri
  initTimeoutMs?: number; // hard cap on initialize; exceeded → kill + dead (default 8000)
  settleMs?: number;      // per-touch publishDiagnostics wait, clamped ≤2000 (default 1500)
  debounceMs?: number;    // follow-up publish grace, opencode's 150ms (client.ts:13)
}

export type LspState = "idle" | "starting" | "ready" | "dead";

export class LspClient {
  private readonly opts: Required<LspClientOptions>;
  private proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private parser = new FrameParser();
  private nextId = 1;
  private pending = new Map<number, (r: RpcMessage) => void>();
  private versions = new Map<string, number>();    // uri → document version
  private diags = new Map<string, Diagnostic[]>(); // uri → last published diagnostics
  private gen = new Map<string, number>();         // uri → publish generation counter
  private pubVer = new Map<string, number>();      // uri → version carried by the last publish (absent: none)
  private waiters = new Map<string, Set<() => void>>();
  private stateVal: LspState = "idle";
  private initPromise: Promise<void> | null = null;

  constructor(opts: LspClientOptions) {
    this.opts = {
      cmd: opts.cmd,
      root: opts.root,
      initTimeoutMs: opts.initTimeoutMs ?? 8000,
      settleMs: Math.min(opts.settleMs ?? 1500, 2000),
      debounceMs: opts.debounceMs ?? 150,
    };
  }

  get state(): LspState { return this.stateVal; }
  /** resolves when the child process exits (test hook for the kill path) */
  get exited(): Promise<number> | null { return this.proc?.exited ?? null; }

  /** didOpen (first touch) / didChange (later touches) for absPath, then wait ≤settleMs
   *  for fresh publishDiagnostics. Throws only before ready; a dead server yields []. */
  async touch(absPath: string): Promise<Diagnostic[]> {
    if (this.stateVal === "dead") return [];
    this.initPromise ??= this.start().catch((e: unknown) => { this.becomeDead(); throw e; });
    await this.initPromise;
    if (this.stateVal !== "ready") return [];
    const uri = pathToFileURL(absPath).href;
    const text = readFileSync(absPath, "utf8");
    const genBefore = this.gen.get(uri) ?? 0;
    const prev = this.versions.get(uri);
    const sentVer = prev === undefined ? 0 : prev + 1; // the version THIS edit is published under
    this.versions.set(uri, sentVer);
    if (prev === undefined) {
      // opencode client.ts:611-619 — didOpen {uri, languageId, version: 0, text}
      const languageId = languageIdFor(extname(absPath)); // lsp-servers.ts LANGUAGE_IDS: TS/JS as at #13, .py → python …
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: sentVer, text } });
    } else {
      // opencode client.ts:577-597 — didChange version+1, full-text contentChanges
      this.notify("textDocument/didChange", { textDocument: { uri, version: sentVer }, contentChanges: [{ text }] });
    }
    const deadline = Date.now() + this.opts.settleMs;
    if (!(await this.waitPublish(uri, genBefore, deadline, sentVer))) return [];
    // rearming debounce: absorb follow-up publishes, capped by the settle deadline
    // (opencode waitForFreshPush, client.ts:464-497)
    let g = this.gen.get(uri) ?? 0;
    while (Date.now() + this.opts.debounceMs <= deadline) {
      if (!(await this.waitPublish(uri, g, Math.min(deadline, Date.now() + this.opts.debounceMs), sentVer))) break;
      g = this.gen.get(uri) ?? 0;
    }
    return this.diags.get(uri) ?? [];
  }

  kill(): void { this.becomeDead(); }

  private async start(): Promise<void> {
    this.stateVal = "starting";
    this.proc = Bun.spawn(this.opts.cmd, { cwd: this.opts.root, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    // unref: a live server must never keep the host process alive. Paired with the
    // mandatory ref-after-kill in becomeDead() — see the comment there before touching this.
    this.proc.unref();
    void this.pump();
    void this.proc.exited.then(() => this.becomeDead());
    // opencode client.ts:211-255 — rootUri/processId/capabilities; :260 initialized
    const r = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.opts.root).href,
      capabilities: {
        textDocument: { synchronization: { didOpen: true, didChange: true }, publishDiagnostics: { versionSupport: false } },
      },
      workspaceFolders: null,
    }, this.opts.initTimeoutMs);
    if (r.error) throw new Error(`lsp initialize failed: ${r.error.message}`);
    this.notify("initialized", {});
    this.stateVal = "ready";
  }

  private async pump(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    try {
      for await (const chunk of proc.stdout) {
        // per-message guard: one malformed frame must never abort the reader loop — an
        // unguarded throw here silently discarded ALL later server output while "ready"
        for (const msg of this.parser.push(chunk)) {
          try { this.dispatch(msg); } catch { /* skip poisoned frame, keep reading */ }
        }
      }
    } catch { /* stream torn down with the process */ }
  }

  private dispatch(raw: unknown): void {
    if (!raw || typeof raw !== "object") return; // `null`/scalar bodies are valid JSON but not messages
    const msg = raw as RpcMessage;
    if (typeof msg.id === "number" && msg.method === undefined) {
      const cb = this.pending.get(msg.id);
      if (cb) { this.pending.delete(msg.id); cb(msg); }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      // opencode client.ts:160-172 — cache per uri (+ published version, :165), signal listeners
      const p = msg.params as { uri?: unknown; version?: unknown; diagnostics?: unknown } | null;
      if (!p || typeof p !== "object" || typeof p.uri !== "string") return; // shape guard
      this.diags.set(p.uri, Array.isArray(p.diagnostics) ? (p.diagnostics as Diagnostic[]) : []);
      if (typeof p.version === "number") this.pubVer.set(p.uri, p.version);
      else this.pubVer.delete(p.uri);
      this.gen.set(p.uri, (this.gen.get(p.uri) ?? 0) + 1);
      for (const w of [...(this.waiters.get(p.uri) ?? [])]) w();
      return;
    }
    // server→client request (e.g. workspace/configuration): answer null so the server never stalls
    if (typeof msg.id === "number") this.send({ jsonrpc: "2.0", id: msg.id, result: null });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<RpcMessage> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise<RpcMessage>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(t); resolve(r); });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || this.stateVal === "dead") return;
    try { stdin.write(encodeFrame(msg)); void stdin.flush(); } catch { this.becomeDead(); }
  }

  /** resolves true once a publish newer than genAfter AND belonging to sentVer lands for uri;
   *  a publish carrying another version is a different edit's (laggy servers re-publish the
   *  previous version — opencode client.ts:483-485 rejects those; versionless always matches).
   *  Resolves false at deadline/death. */
  private waitPublish(uri: string, genAfter: number, deadlineTs: number, sentVer: number): Promise<boolean> {
    const fresh = (): boolean => {
      if ((this.gen.get(uri) ?? 0) <= genAfter) return false;
      const pv = this.pubVer.get(uri);
      return pv === undefined || pv === sentVer;
    };
    if (fresh()) return Promise.resolve(true);
    if (this.stateVal === "dead" || deadlineTs <= Date.now()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const set = this.waiters.get(uri) ?? new Set<() => void>();
      this.waiters.set(uri, set);
      const done = (): void => { clearTimeout(t); set.delete(cb); resolve(fresh()); };
      const cb = (): void => { if (fresh() || this.stateVal === "dead") done(); };
      const t = setTimeout(done, deadlineTs - Date.now());
      set.add(cb);
    });
  }

  /** wedged/broken server: mark dead (never retried, opencode lsp.ts:224-241), kill, release waiters */
  private becomeDead(): void {
    if (this.stateVal === "dead") return;
    this.stateVal = "dead";
    for (const [id, cb] of [...this.pending]) {
      this.pending.delete(id);
      cb({ jsonrpc: "2.0", id, error: { code: -1, message: "lsp server dead" } });
    }
    for (const set of this.waiters.values()) for (const w of [...set]) w();
    try { this.proc?.kill(); } catch { /* already gone */ }
    // ref-after-kill (Bun 1.3/Windows): an unref'd subprocess's exit is only observed while
    // other ref'd work keeps the event loop turning; on an idle loop `exited` never settles,
    // which froze the entire `bun test` run. Re-ref once dying so exit is always delivered.
    try { this.proc?.ref(); } catch { /* already gone */ }
  }
}

// ---------- gate note formatting (opencode diagnostic.ts:5-27 + tool/edit.ts:197-201) ----------

const MAX_PER_FILE = 20; // opencode diagnostic.ts MAX_PER_FILE

export function formatGateNote(absPath: string, diags: Diagnostic[], server = "typescript-language-server"): string {
  const errors = diags.filter((d) => d.severity === 1); // errors only — warnings/hints never reach the model
  if (errors.length === 0) return "";
  const shown = errors
    .slice(0, MAX_PER_FILE)
    .map((d) => `ERROR [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`); // 1-based
  const suffix = errors.length > MAX_PER_FILE ? `\n... and ${errors.length - MAX_PER_FILE} more` : "";
  return `\n\nlsp-gate (${server}): ${errors.length} error(s) in ${absPath} — fix before proceeding:\n${shown.join("\n")}${suffix}`;
}

// ---------- the gate moved to coding/lsp-gate.ts (server table: coding/lsp-servers.ts) ----------
// Re-exported so cli/runtime.ts, cli/doctor.ts and the existing tests keep importing from here; this file is the
// wire only (framing, client, note formatting). New code should import from ./lsp-gate.ts directly.
export {
  createLspGate, disposeDefaultGates, lspAvailabilityNote, lspAvailabilityNotes, lspGateNote, serverLabel, withLspGate,
  type GateOptions, type LspGate,
} from "./lsp-gate.ts";
