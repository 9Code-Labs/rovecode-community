/** PORT #35 — machine-readable output for `aion run`: --output text | json | ndjson.
 *
 *  Ported shape decisions (pi @ 853a80d, packages/coding-agent/src):
 *  - modes/print-mode.ts:108-111 — `--mode json` writes ONE JSON line per session event
 *    (`JSON.stringify(toJsonEvent(event)) + "\n"` through writeRawStdout); the RPC protocol
 *    frames its output identically (modes/rpc/rpc-mode.ts:60-62, :355-356). aion's ndjson mode
 *    emits every RunEvent VERBATIM that way (no reformatting: the loop's events are already
 *    deltas — pi's toJsonEvent only strips its cumulative partials, json-event.ts:40-45) and
 *    closes with one {type:"result", …} line.
 *  - core/output-guard.ts:45-70 takeOverStdout — outside the interactive TUI process.stdout.write
 *    is redirected to stderr and only the raw writer bound BEFORE the takeover reaches fd 1
 *    (installed for every appMode !== "interactive", main.ts:633-636). guardStdout below is that
 *    guard; Bun's console.log does not route through process.stdout.write, so console.log/info/
 *    debug are redirected too. stdout purity is structural, not a discipline.
 *  - print-mode.ts:139-156 — text mode prints only the final assistant text; error/aborted →
 *    message on stderr, exit 1 (:145-147); signals exit 128+n (:57-61: 143 SIGTERM, 129 SIGHUP).
 *    aion keeps its text mode byte-identical to the pre-port cmdRun (progress lines + summary on
 *    stdout) and maps an ABORTED run to 130 by the same 128+signal convention: the sink's signal
 *    aborts on the first SIGINT and rides into LoopDeps.signal (port #21), so Ctrl-C ends the run
 *    "stopped" with a well-formed result instead of a hard kill (Windows: exit 0xC000013A, no output).
 *
 *  Result schema (json: the ONLY stdout line; ndjson: the LAST line, with type:"result"):
 *    status     "done" | "stopped" | "error" | "budget" — run_end.status ("error" when the loop
 *               ended without a run_end)
 *    summary    run_end.summary: the final assistant text, or the error text
 *    sessionId  run_start.sessionId (null if never seen) — the store under .aion/sessions
 *    model      { provider, model } requested
 *    origin     { provider, model } that SERVED the last turn (router fallback may differ), or null
 *    usage      { input, output, cacheRead, cacheWrite } summed over the run's assistant messages
 *    costUsd    number, or null when any usage-bearing turn has no catalog pricing (mock, unknown
 *               models) — an honest unknown, never a silent lower bound (core/usage.ts costUsd)
 *    toolCalls  [{ tool, ok, ms? }] in event order; ms absent for calls that never executed
 *               (permission_denied / truncated / not_found → ok:false)
 *    durationMs sink construction → finish
 *    exitCode   the process exit code below
 *  Exit codes: 0 done · 1 error / budget / no run_end · 2 usage error (bad --output value; also
 *  the startup-error class, port #27) · 130 stopped (the run was aborted: SIGINT). Text mode keeps
 *  its 0 done / 1 otherwise, plus 130 for the (newly reachable) aborted run. */

import { format } from "node:util";
import type { Message, ModelRef, RunEvent, StreamFn } from "../core/types.ts";
import type { LoopDeps } from "../core/loop.ts";
import type { Runtime } from "./runtime.ts";
import { costUsd, type PricingRow } from "../core/usage.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { VALUE_FLAGS } from "./dispatch.ts";

export type OutputMode = "text" | "json" | "ndjson";
export const OUTPUT_MODES: readonly OutputMode[] = ["text", "json", "ndjson"];
export type RunEndStatus = Extract<RunEvent, { type: "run_end" }>["status"];
type RunEnd = { status: RunEndStatus; summary: string };

export interface RunResult {
  status: RunEndStatus;
  summary: string;
  sessionId: string | null;
  model: { provider: string; model: string };
  origin: { provider: string; model: string } | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  toolCalls: { tool: string; ok: boolean; ms?: number }[];
  durationMs: number;
  exitCode: number;
}

export interface Writer { write(chunk: string): unknown }

/** ModelCatalog.lookup's shape — tests inject fixed pricing. */
export interface PricingSource { lookup(provider: string, model: string): { pricing?: PricingRow } | undefined }

export interface OutputSinkOptions {
  stdout: Writer;
  stderr: Writer;
  /** requested model → result.model, and the pricing fallback for origin-less messages */
  model: ModelRef;
  /** live view of the run's session store; read at finish (usage, origin, tool names) */
  messages: () => Message[];
  catalog?: PricingSource;
  /** SIGINT hookup seam; returns the uninstaller. Default: process.once("SIGINT"). */
  onInterrupt?: (handler: () => void) => () => void;
}

export interface OutputSink {
  readonly mode: OutputMode;
  /** aborts on the first SIGINT — thread into LoopDeps.signal so the run ends "stopped" (130) */
  readonly signal: AbortSignal;
  onEvent(ev: RunEvent): void;
  /** After the loop settles: writes the text summary / the json result / the ndjson result line
   *  and returns the exit code. No `end` = the loop ended without run_end → status "error", 1. */
  finish(end?: RunEnd): number;
  /** Uninstalls the stdout guard (installed for json/ndjson over the REAL process.stdout; a no-op
   *  otherwise) so console.log / process.stdout.write reach fd 1 again — for embedders and tests.
   *  cmdRun never calls it: hooks.close()/mcp.close() run AFTER finish and may still print, so the
   *  guard must hold until process.exit. */
  close(): void;
}

// ---------- argv ----------

const USAGE = "--output <mode>: text (default) | json | ndjson";

const usageExit = (msg: string): never => {
  process.stderr.write(`error: ${msg} — ${USAGE}\n`);
  return process.exit(2);
};

function isOutputMode(v: string): v is OutputMode {
  return (OUTPUT_MODES as readonly string[]).includes(v);
}

/** `--output <mode>` or `--output=<mode>`, anywhere in argv (dispatch.ts VALUE_FLAGS keeps the
 *  value from being taken for the command). Missing or unknown value → one-line stderr usage
 *  error, exit 2 (the usage/startup-error class; `fail` is injectable for tests). Last one wins.
 *  cmdRun calls this FIRST — before bootRuntime — so a usage error leaves no trace: no
 *  .aion/sessions/<id> (meta.json, memory dir), no sandbox probe, no MCP children to reap. */
export function parseOutputMode(argv: readonly string[], fail: (msg: string) => never = usageExit): OutputMode {
  const args = argv.slice(2);
  let mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output") {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) return fail("--output needs a value");
      mode = v;
    } else if (a.startsWith("--output=")) {
      mode = a.slice("--output=".length);
    }
  }
  if (mode === undefined) return "text";
  return isOutputMode(mode) ? mode : fail(`unknown --output mode "${mode}"`);
}

/** The one-shot prompt words for cmdRun. parseCli's `rest` keeps a POST-command value flag's
 *  value (its contract — owners drop their own, like cmdAuth's --key and export.ts's --out), so
 *  `aion run "hi" --output json` arrives as rest ["hi", "json"]. The token that followed --output
 *  is removed by POSITION, never by value (a prompt may legitimately contain the word "json"). A
 *  pre-command --output value never enters rest; a dangling --output is parseOutputMode's error. */
export function runPromptWords(cli: { cmd: string; rest: string[] }, argv: readonly string[]): string[] {
  const words = cli.cmd === "run" ? [...cli.rest] : [cli.cmd, ...cli.rest]; // bare prompt keeps cmd as word 0
  const args = argv.slice(2);
  const isFlag = (a: string) => a.startsWith("-");
  const cmdIdx = args.findIndex((a, i) => !isFlag(a) && !(i > 0 && VALUE_FLAGS.has(args[i - 1]!)));
  if (cmdIdx === -1) return words;
  // words = the non-flag tokens from `from` on; a value's word index = the non-flag tokens before it
  const from = cli.cmd === "run" ? cmdIdx + 1 : cmdIdx;
  const drop: number[] = [];
  args.forEach((a, oi) => {
    const value = args[oi + 1];
    if (a !== "--output" || oi < cmdIdx || value === undefined || isFlag(value)) return;
    drop.push(args.slice(from, oi + 1).filter((t) => !isFlag(t)).length);
  });
  for (const k of drop.reverse()) words.splice(k, 1); // descending: earlier indexes stay valid
  return words;
}

// ---------- stdout guard (pi core/output-guard.ts:45-70) ----------

/** Redirect every stray stdout writer — console.log/info/debug (Bun writes them natively, not via
 *  process.stdout.write) and process.stdout.write itself — to `stderr`, so only a writer bound
 *  BEFORE the guard can reach fd 1. Returns the restorer. */
export function guardStdout(stderr: Writer): { restore(): void } {
  const saved = { log: console.log, info: console.info, debug: console.debug, write: process.stdout.write };
  const toErr = (...args: unknown[]): void => { stderr.write(`${format(...args)}\n`); };
  console.log = toErr; console.info = toErr; console.debug = toErr;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stderr.write(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      console.log = saved.log; console.info = saved.info; console.debug = saved.debug;
      process.stdout.write = saved.write;
    },
  };
}

// ---------- exit codes ----------

/** 0 done · 130 stopped (loop.ts yields "stopped" ONLY on abort — :133/:219/:302) · 1 otherwise. */
export function exitCodeFor(status: RunEndStatus | undefined): number {
  if (status === "done") return 0;
  if (status === "stopped") return 130;
  return 1;
}

// ---------- sink ----------

const installSigint = (handler: () => void): (() => void) => {
  // once: the first Ctrl-C aborts the run (a well-formed result follows); the second is the
  // platform default again (hard exit), so a signal-deaf tool cannot hold the terminal hostage
  try { process.once("SIGINT", handler); } catch { return () => {}; }
  return () => { try { process.off("SIGINT", handler); } catch { /* already gone */ } };
};

type CallRecord = { tool?: string; ok: boolean; ms?: number };

export function createOutputSink(mode: OutputMode, opts: OutputSinkOptions): OutputSink {
  const t0 = Date.now();
  // bind the raw writer BEFORE guarding: the guard turns process.stdout.write into a stderr relay
  const real = opts.stdout === process.stdout;
  const out: Writer = real ? { write: process.stdout.write.bind(process.stdout) } : opts.stdout;
  const guard = mode !== "text" && real ? guardStdout(opts.stderr) : null;
  const ac = new AbortController();
  const uninstall = (opts.onInterrupt ?? installSigint)(() => ac.abort());
  let sessionId: string | null = null;
  let baseline = 0; // store length at run_start — only THIS run's messages are accounted
  const calls = new Map<string, CallRecord>();
  // human progress: stdout in text mode (byte-identical to the pre-port console.log lines),
  // stderr in json mode (a terminal user still sees progress; stdout stays the one object),
  // nothing extra in ndjson mode (the event stream IS the progress)
  const human = (line: string): void => {
    if (mode === "text") out.write(`${line}\n`);
    else if (mode === "json") opts.stderr.write(`${line}\n`);
  };
  return {
    mode, signal: ac.signal,
    onEvent(ev) {
      if (mode === "ndjson") out.write(`${JSON.stringify(ev)}\n`);
      if (ev.type === "run_start") { sessionId = ev.sessionId; baseline = opts.messages().length; }
      else if (ev.type === "tool_execution_start") {
        calls.set(ev.callId, { tool: ev.tool, ok: false });
        human(`→ ${ev.tool} ${String(JSON.stringify(ev.args)).slice(0, 100)}`);
      } else if (ev.type === "tool_execution_end") {
        calls.set(ev.callId, { ...calls.get(ev.callId), ok: ev.ok, ms: ev.durationMs });
        human(`← ${ev.ok ? "ok" : "FAIL"} ${ev.output.slice(0, 200).replace(/\n/g, " ⏎ ")}`);
      } else if (ev.type === "tool_call_failed") {
        calls.set(ev.callId, { ...calls.get(ev.callId), ok: false });
      }
    },
    finish(end) {
      uninstall();
      const exitCode = exitCodeFor(end?.status);
      if (mode === "text") {
        if (end) out.write(`\n${end.summary}\n`);
        return exitCode;
      }
      const result = summarize(
        end ?? { status: "error", summary: "stream ended without run_end" }, exitCode, sessionId, opts.model,
        opts.messages().slice(baseline), calls, opts.catalog ?? new ModelCatalog(), Date.now() - t0,
      );
      out.write(`${JSON.stringify(mode === "json" ? result : { type: "result", ...result })}\n`);
      return exitCode;
    },
    close() { guard?.restore(); },
  };
}

// ---------- run deps ----------

/** cmdRun's LoopDeps, built in one place so the wiring is unit-testable (LOW-2): the runtime's
 *  registry/store/tools, guard (port #4), cwd (port #26) and hooks (port #29), with the sink's
 *  SIGINT signal (port #21) — the fields agentLoop reads. Same object literal cmdRun used to inline,
 *  evaluated at the same argument position (tools listed at call time). */
export function buildRunDeps(rt: Pick<Runtime, "registry" | "store" | "guard" | "cwd" | "hooks">, stream: StreamFn, sink: Pick<OutputSink, "signal">): LoopDeps {
  return { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, signal: sink.signal, hooks: rt.hooks };
}

function summarize(
  end: RunEnd, exitCode: number, sessionId: string | null, model: ModelRef, msgs: Message[],
  calls: Map<string, CallRecord>, catalog: PricingSource, durationMs: number,
): RunResult {
  const assistants = msgs.filter((m) => m.role === "assistant");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost: number | null = 0;
  for (const m of assistants) {
    const u = m.usage;
    if (!u) continue;
    const n = { input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
    usage.input += n.input; usage.output += n.output; usage.cacheRead += n.cacheRead; usage.cacheWrite += n.cacheWrite;
    if (cost === null || (n.input === 0 && n.output === 0 && n.cacheRead === 0 && n.cacheWrite === 0)) continue;
    // priced PER MESSAGE at the model that served it (Message.origin — the tui/cost.ts idiom)
    const o = m.origin ?? model;
    const pricing = catalog.lookup(o.provider, o.model)?.pricing;
    const c = pricing ? costUsd(n, pricing) : undefined;
    cost = c === undefined ? null : cost + c;
  }
  // names for calls that never started (denied/truncated/not_found) come from the tool_call parts
  const names = new Map<string, string>();
  for (const m of assistants) for (const p of m.parts) if (p.kind === "tool_call") names.set(p.id, p.tool);
  const served = assistants.at(-1)?.origin;
  return {
    status: end.status, summary: end.summary, sessionId,
    model: { provider: model.provider, model: model.model },
    origin: served ? { provider: served.provider, model: served.model } : null,
    usage, costUsd: cost,
    toolCalls: [...calls].map(([id, c]) => ({ tool: c.tool ?? names.get(id) ?? "unknown", ok: c.ok, ...(c.ms !== undefined ? { ms: c.ms } : {}) })),
    durationMs, exitCode,
  };
}
