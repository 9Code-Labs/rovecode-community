/**
 * PORT #18 — persistent eval cell, feature-flagged (ROVECODE_EVAL_CELL=1).
 *
 * Concept sources (research/source_snapshots):
 *   - OMP (can1357-oh-my-pi), MIT — persistent eval cells:
 *       docs/tools/eval.md:3 ("one tool call is one cell; state survives later calls"),
 *       :108 ("Persistent worker VM keyed by js:${sessionId}"; reset recreates the VM),
 *       :179 ("Cancellation is destructive when needed: JS terminates its worker"),
 *       :185 (output window byte budget), :65 ("(no output)" placeholder).
 *     packages/coding-agent/src/eval/js/shared/indirect-eval.ts:13-23 — user code runs
 *       through *indirect* `globalThis.eval` (global scope), deliberately NOT node:vm:
 *       Bun SIGTRAPs when Worker.terminate() fires mid-vm.runInContext — and terminate
 *       is exactly our timeout path.
 *     packages/coding-agent/src/eval/js/worker-core.ts:279-308 — run/result message
 *       protocol; execution errors become result payloads, never worker throws.
 *     packages/coding-agent/src/eval/js/shared/rewrite-imports.ts:531-550 — TS strip +
 *       async wrapping (docs/tools/eval.md:110). Simplified here: Bun.Transpiler with
 *       deadCodeElimination:false (keeps the trailing expression), thenable completion
 *       values awaited, and one async-IIFE retry at whichever stage rejects bare
 *       top-level forms (enables top-level await / bare return; declarations in the
 *       wrapped path are cell-local):
 *         - transpile stage: the transpiler parses cells as ES modules, so bare
 *           `return` is a BuildMessage error there — retry transpiling the ORIGINAL
 *           source wrapped (types still strip); if that also fails, rethrow the first
 *           error so diagnostics point at the unwrapped code;
 *         - eval stage: top-level `await` is module-legal but eval-illegal
 *           (SyntaxError) — retry evaluating the transpiled js wrapped.
 *   - prime-agent RLM single-REPL concept: prime-agent-runtime/src/rlm/repl.md:3-5
 *       (cells execute "in one persistent __main__ namespace" per session), :53-55
 *       (result = repr of the trailing expression), repl.py. BLUEPRINT rejects the
 *       Python kernel, so this is the TS-only analog: one Bun Worker per session.
 *
 * Ouroboros rule — what cell code CAN see:
 *   - Standard Bun Worker realm globals: Bun, fetch, process (including the inherited
 *     process.env — same trust level as the bash tool's child shell), timers, require.
 *     This is NOT a security sandbox; the "execute" policy gate (deny-default → prompt)
 *     is the control, exactly like bash.
 *   - Bootstrap additions to the global scope: the six console methods are replaced
 *     with capture stubs, and `self.onmessage` holds the (secret-free) runner.
 *     Everything else lives in the bootstrap IIFE's closure, unreachable from cell
 *     code, which evaluates via indirect eval in the worker's global scope.
 *   What is NOT pre-exposed (a non-exposure claim, NOT unreachability): nothing from
 *   the rovecode module graph is imported into or handed to the worker — it loads only
 *   this inline bootstrap blob, so the tool registry (v1 deliberately has NO tool
 *   re-entry bridge — scope note), session stores, permission/approval machinery,
 *   and the graders under src/eval/* stay live only in the host process, and the
 *   only traffic across the seam is {id, code} in and {id, ok, stdout, value, error}
 *   out via postMessage. Cell code CAN still `await import()` or Bun.file-read any
 *   file on disk (src/** included) exactly like the bash tool can run `bun -e` —
 *   the execute-kind policy gate is the control there, not the worker boundary.
 *
 * Lifecycle: worker per ctx.sessionId, created lazily, unref'd so it never holds the
 * host process open. Cell errors keep the worker (state survives); timeout/abort/reset
 * terminate it and the session's cell state is lost (reported in the output). An
 * uncaught BACKGROUND error (timer throw / unhandled rejection firing the worker
 * "error" event, possibly with no call in flight) also kills the worker; the reason is
 * parked in `crashed` and the next call's output is prefixed with a crash note, so a
 * fresh cell never silently contradicts "state survives". A cell that kills its own
 * worker cleanly (e.g. process.exit()) fires no error event and surfaces as a timeout
 * on a later call.
 */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";

export const EVAL_CELL_FLAG = "ROVECODE_EVAL_CELL";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 16_384;
const MIN_OUTPUT_BYTES = 256;
const MAX_OUTPUT_BYTES = 65_536;

/** Self-contained worker bootstrap (plain JS, no imports — see ouroboros note above).
 *  Hard caps inside the worker bound postMessage payloads; the model-facing byte
 *  budget is enforced host-side by truncateToBudget. */
const BOOTSTRAP = `
(() => {
  "use strict";
  const MAX_CAPTURE = 1048576;
  const MAX_VALUE = 262144;
  const transpiler = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false });
  let buf = [];
  let bufLen = 0;
  let capped = false;
  const fmt = (v) => (typeof v === "string" ? v : Bun.inspect(v));
  const capture = (...parts) => {
    if (capped) return;
    const line = parts.map(fmt).join(" ") + "\\n";
    bufLen += line.length;
    if (bufLen > MAX_CAPTURE) { capped = true; buf.push("[console capture cap reached]\\n"); return; }
    buf.push(line);
  };
  for (const k of ["log", "info", "warn", "error", "debug", "trace"]) console[k] = capture;
  self.onmessage = async (ev) => {
    const { id, code } = ev.data;
    buf = []; bufLen = 0; capped = false;
    let ok = true; let value = ""; let error = "";
    try {
      // Bare top-level return is illegal in a module, so it fails at TRANSPILE time
      // (BuildMessage), before eval — retry with the original source async-wrapped.
      // If the wrapped transpile fails too, the code is genuinely broken: rethrow the
      // FIRST error so diagnostics describe the unwrapped source.
      let js; let preWrapped = false;
      try {
        js = transpiler.transformSync(code);
      } catch (e1) {
        try { js = transpiler.transformSync("(async () => {\\n" + code + "\\n})()"); preWrapped = true; }
        catch { throw e1; }
      }
      let v;
      try {
        v = (0, eval)(js);
      } catch (e) {
        // Top-level await is module-legal but a SyntaxError in plain eval; retry
        // wrapped (OMP docs/tools/eval.md:110). Declarations in wrapped paths
        // (either stage) are cell-local.
        if (!preWrapped && e instanceof SyntaxError) v = (0, eval)("(async () => {\\n" + js + "\\n})()");
        else throw e;
      }
      if (v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function") v = await v;
      if (v !== undefined) {
        value = Bun.inspect(v);
        if (value.length > MAX_VALUE) value = value.slice(0, MAX_VALUE) + "...[value capped]";
      }
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.name + ": " + e.message : String(e);
    }
    postMessage({ id, ok, stdout: buf.join(""), value, error });
  };
  postMessage({ type: "ready" });
})();
`;

interface WorkerResult { id: number; ok: boolean; stdout: string; value: string; error: string }

interface CellRuntime {
  worker: Worker;
  pending: Map<number, (r: WorkerResult) => void>;
  ready: Promise<void>;
}

const cells = new Map<string, CellRuntime>();
/** Reasons from worker "error" events (background timer throws / unhandled
 *  rejections), parked per session: with no call in flight destroyCell has nobody
 *  to tell, so the NEXT call consumes the reason and explains its fresh cell. */
const crashed = new Map<string, string>();
let callSeq = 0;
let bootstrapUrl: string | null = null;

/** Bun's ErrorEvent.message is a multi-line source excerpt + stack; condense to the
 *  `error: …` line (or a flattened whole) so crash notes stay one line. */
function crashReason(raw: string): string {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const flat = (lines.find((l) => /^\w*[Ee]rror:/.test(l)) ?? lines.join(" ")).replace(/\s+/g, " ");
  return flat === "" ? "unknown worker error" : flat.length > 200 ? flat.slice(0, 200) + "…" : flat;
}

function urlForBootstrap(): string {
  if (bootstrapUrl === null) {
    bootstrapUrl = URL.createObjectURL(new Blob([BOOTSTRAP], { type: "application/javascript" }));
  }
  return bootstrapUrl;
}

function spawnCell(sessionId: string): CellRuntime {
  const worker = new Worker(urlForBootstrap());
  const pending = new Map<number, (r: WorkerResult) => void>();
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((res) => { readyResolve = res; });
  const runtime: CellRuntime = { worker, pending, ready };
  worker.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { type?: string } & Partial<WorkerResult>;
    if (d.type === "ready") { readyResolve(); return; }
    if (typeof d.id !== "number") return;
    const cb = pending.get(d.id);
    if (cb) {
      pending.delete(d.id);
      cb({ id: d.id, ok: d.ok === true, stdout: d.stdout ?? "", value: d.value ?? "", error: d.error ?? "" });
    }
  });
  worker.addEventListener("error", (ev) => {
    const msg = crashReason((ev as ErrorEvent).message || "unknown worker error");
    // Park the reason BEFORE destroying: a background crash (no call in flight)
    // otherwise leaves the next call a silently-fresh cell, contradicting the
    // "state survives later calls" contract. (preventDefault() does NOT stop Bun
    // from tearing the worker down — verified — so report-on-next-call it is.)
    crashed.set(sessionId, msg);
    destroyCell(sessionId, runtime, `worker crashed: ${msg}`);
  });
  // Never hold the host process open on account of an idle cell.
  (worker as unknown as { unref?: () => void }).unref?.();
  return runtime;
}

/** Terminate a runtime and fail its in-flight runs. Guarded against stale handles:
 *  only unmaps when this runtime is still the session's current one. */
function destroyCell(sessionId: string, runtime: CellRuntime, reason: string): void {
  if (cells.get(sessionId) === runtime) cells.delete(sessionId);
  for (const [id, cb] of [...runtime.pending]) {
    runtime.pending.delete(id);
    cb({ id, ok: false, stdout: "", value: "", error: reason });
  }
  try { runtime.worker.terminate(); } catch { /* already dead */ }
}

/** Kill every session's cell worker (test teardown / host shutdown). */
export async function disposeEvalCells(): Promise<void> {
  for (const [sid, rt] of [...cells]) destroyCell(sid, rt, "eval cells disposed");
  crashed.clear();
  if (bootstrapUrl !== null) { URL.revokeObjectURL(bootstrapUrl); bootstrapUrl = null; }
}

/** Byte-budget truncation (OMP output window, docs/tools/eval.md:185). UTF-8 safe:
 *  a torn trailing multibyte sequence is dropped, and a marker reports kept/total. */
export function truncateToBudget(text: string, budgetBytes: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= budgetBytes) return text;
  const kept = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, budgetBytes))
    .replace(/�+$/, "");
  return `${kept}\n[output truncated: sent ${enc.encode(kept).length} of ${bytes.length} bytes]`;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

async function runCell(
  sessionId: string, code: string, timeoutMs: number, budgetBytes: number,
  signal: AbortSignal, reset: boolean,
): Promise<ToolOutput> {
  let existing = cells.get(sessionId);
  if (reset && existing) { destroyCell(sessionId, existing, "cell reset"); existing = undefined; }
  // A spawn that replaces a crashed worker must SAY so: consume the parked reason
  // exactly once and prefix this call's output (outside the byte budget, like the
  // truncation marker — host metadata is never silently truncated away).
  let note = "";
  if (!existing) {
    const reason = crashed.get(sessionId);
    if (reason !== undefined) {
      crashed.delete(sessionId);
      note = `note: previous cell worker crashed (${reason}); state was reset\n`;
    }
  }
  const cell = existing ?? spawnCell(sessionId);
  if (!existing) cells.set(sessionId, cell);

  const id = ++callSeq;
  const result = new Promise<WorkerResult>((res) => { cell.pending.set(id, res); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((res) => {
    if (signal.aborted) { res("aborted"); return; }
    onAbort = () => res("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const up = await Promise.race([cell.ready.then(() => "ready" as const), timedOut, aborted]);
    if (up === "ready") cell.worker.postMessage({ id, code });
    const winner = up === "ready" ? await Promise.race([result, timedOut, aborted]) : up;
    if (winner === "timeout" || winner === "aborted") {
      // Destructive cancellation (OMP docs/tools/eval.md:179): a busy synchronous cell
      // can only be stopped by killing its worker; retained state dies with it.
      destroyCell(sessionId, cell, winner);
      return {
        ok: false,
        output: note + (winner === "timeout"
          ? `Error: eval cell timed out after ${timeoutMs}ms — worker killed; this session's cell state was reset`
          : "Error: eval cell aborted — worker killed; this session's cell state was reset"),
      };
    }
    const parts: string[] = [];
    if (winner.stdout !== "") parts.push(winner.stdout.replace(/\n$/, ""));
    if (winner.ok && winner.value !== "") parts.push(`=> ${winner.value}`);
    if (!winner.ok) parts.push(`Error: ${winner.error}`);
    const text = parts.length > 0 ? parts.join("\n") : "(no output)";
    return { ok: winner.ok, output: note + truncateToBudget(text, budgetBytes) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    cell.pending.delete(id);
  }
}

const evalCellTool: Tool = {
  schema: {
    name: "eval_cell",
    description:
      "Execute JavaScript/TypeScript in this session's persistent eval cell (a Bun worker). " +
      "State survives across calls: `var`, function declarations, and `globalThis.*` assignments " +
      "persist; top-level `let`/`const` are cell-local. Console output is captured and the final " +
      "expression's value is returned as `=> value`. Cells using top-level `await` or bare `return` " +
      "run wrapped in an async function — persist state via `globalThis` there. No rovecode tool access " +
      "from inside the cell (v1 scope). Output is truncated to a byte budget. On timeout — or if a " +
      "background error crashes the worker between calls — cell state resets, and the next call " +
      "says so in a `note:` prefix. NOT a sandbox: gated by the same execute policy as bash.",
    args: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS/TS source of one cell" },
        timeout_ms: { type: "integer", description: `kill budget in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
        max_output_bytes: { type: "integer", description: `output byte budget (default ${DEFAULT_OUTPUT_BYTES}, max ${MAX_OUTPUT_BYTES})` },
        reset: { type: "boolean", description: "discard this session's cell state before running (OMP reset semantics)" },
      },
      required: ["code"],
    },
  },
  kind: "execute", // → action "shell.exec": deny-default rules prompt for it like bash
  sequential: true,
  async execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const a = (args ?? {}) as { code?: unknown; timeout_ms?: unknown; max_output_bytes?: unknown; reset?: unknown };
    if (typeof a.code !== "string" || a.code.trim() === "") {
      return { ok: false, output: "Error: eval_cell requires a non-empty string `code` argument" };
    }
    const timeoutMs = clampInt(a.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const budget = clampInt(a.max_output_bytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES, DEFAULT_OUTPUT_BYTES);
    try {
      return await runCell(ctx.sessionId, a.code, timeoutMs, budget, ctx.signal, a.reset === true);
    } catch (e) {
      // Never throw across the tool seam (ADR-005): host failures become typed output.
      return { ok: false, output: `Error: eval cell host failure: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

/** Flag-gated factory: the ONLY door to the tool. Returns null unless ROVECODE_EVAL_CELL=1,
 *  so flag-off runs register nothing (bar: OFF by default and unregistered when off). */
export function createEvalCellTool(
  env: Record<string, string | undefined> = process.env,
): Tool | null {
  return env[EVAL_CELL_FLAG] === "1" ? evalCellTool : null;
}
