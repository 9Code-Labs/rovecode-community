/** PORT #35 — output sink unit tests. Pins: --output parsing (usage error → injected fail), the
 *  post-command value strip (by position), text mode byte-identity with the pre-port console.log
 *  lines, json purity (nothing on stdout before finish) + result shape from a scripted event
 *  sequence, per-message origin pricing (unpriced → null), ndjson framing (verbatim events + one
 *  result line), exit-code mapping (stopped/aborted → 130), the SIGINT seam, the stdout guard, its
 *  INSTALL for json/ndjson over the real process.stdout + close() (LOW-1), and buildRunDeps —
 *  cmdRun's LoopDeps wiring incl. sink.signal (LOW-2). The mutation each test kills is named inline. */

import { test, expect, describe } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOutputSink, parseOutputMode, runPromptWords, exitCodeFor, guardStdout, buildRunDeps,
  type OutputMode, type RunResult, type RunEndStatus, type Writer, type PricingSource,
} from "../../src/cli/output.ts";
import type { Message, ModelRef, RunEvent } from "../../src/core/types.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { ToolGuard } from "../../src/core/guardrails.ts";
import { HookRunner } from "../../src/core/hooks.ts";
import { SessionStore } from "../../src/core/session.ts";
import { readTool } from "../../src/coding/hashline.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";

const argv = (...a: string[]) => ["bun", "main.ts", ...a];
const fail = (msg: string): never => { throw new Error(`usage: ${msg}`); };

function capture(): Writer & { text(): string } {
  const chunks: string[] = [];
  return { write(c: string) { chunks.push(c); return true; }, text: () => chunks.join("") };
}

const model: ModelRef = { provider: "p", model: "m" };
const RESULT_KEYS = ["costUsd", "durationMs", "exitCode", "model", "origin", "sessionId", "status", "summary", "toolCalls", "usage"];

function msg(role: Message["role"], parts: Message["parts"], extra: Partial<Message> = {}): Message {
  return { id: randomUUID(), role, parts, parentId: null, createdAt: Date.now(), ...extra };
}

/** A scripted one-tool run, in the loop's event order. */
const script: RunEvent[] = [
  { type: "run_start", runId: "r1", sessionId: "sess-1", goal: "go" },
  { type: "turn_start", turn: 1 },
  { type: "turn_end", turn: 1, stopReason: "tool_use" },
  { type: "tool_execution_start", callId: "c1", tool: "read", args: { path: "a.txt" } },
  { type: "tool_execution_end", callId: "c1", ok: true, output: "line1\nline2", durationMs: 7 },
  { type: "turn_start", turn: 2 },
  { type: "turn_end", turn: 2, stopReason: "end_turn" },
  { type: "run_end", status: "done", summary: "all done" },
];
/** What the loop would have appended to the store for `script`: usage + origin per assistant message. */
const storeMsgs: Message[] = [
  msg("user", [{ kind: "text", text: "go" }]),
  msg("assistant", [{ kind: "tool_call", id: "c1", tool: "read", args: { path: "a.txt" } }],
    { usage: { input: 100, output: 10, cacheRead: 5 }, origin: { provider: "p", model: "m" } }),
  msg("tool", [{ kind: "tool_result", callId: "c1", ok: true, output: "line1\nline2" }]),
  msg("assistant", [{ kind: "text", text: "all done" }],
    { usage: { input: 200, output: 20, cacheWrite: 3 }, origin: { provider: "p2", model: "served" } }),
];

type RunEnd = { status: RunEndStatus; summary: string };
interface DriveOpts { events?: RunEvent[]; store?: Message[]; pre?: Message[]; catalog?: PricingSource; end?: RunEnd | null }

/** Feed a scripted run through a sink. The messages accessor returns `pre` until run_start, then
 *  pre + store (the loop appends after yielding run_start). `end: null` = no run_end (defensive). */
function drive(mode: OutputMode, o: DriveOpts = {}) {
  const out = capture(), err = capture();
  const pre = o.pre ?? [];
  let live: Message[] = pre;
  const sink = createOutputSink(mode, {
    stdout: out, stderr: err, model, messages: () => live, onInterrupt: () => () => {},
    ...(o.catalog ? { catalog: o.catalog } : {}),
  });
  let end: RunEnd | undefined;
  for (const ev of o.events ?? script) {
    sink.onEvent(ev);
    if (ev.type === "run_start") live = [...pre, ...(o.store ?? storeMsgs)];
    if (ev.type === "run_end") end = ev;
  }
  const beforeFinish = out.text();
  const code = sink.finish(o.end === null ? undefined : (o.end ?? end));
  return { sink, out, err, code, beforeFinish };
}

/** stdout must be exactly one JSON object followed by one newline. */
function single(stdout: string): RunResult {
  const lines = stdout.split("\n");
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0]!) as RunResult;
}

// ---------- --output parsing ----------

describe("parseOutputMode", () => {
  test("default is text; json/ndjson before or after the command; --output= form; last one wins", () => {
    expect(parseOutputMode(argv("run", "hi"), fail)).toBe("text");
    expect(parseOutputMode(argv("run", "hi", "--output", "json"), fail)).toBe("json");
    expect(parseOutputMode(argv("--output", "ndjson", "run", "hi"), fail)).toBe("ndjson");
    expect(parseOutputMode(argv("run", "--output=json", "hi"), fail)).toBe("json");
    expect(parseOutputMode(argv("--output", "json", "run", "--output", "text"), fail)).toBe("text");
  });

  test("unknown mode → usage failure naming the value (exit 2 in the CLI)", () => {
    expect(() => parseOutputMode(argv("run", "hi", "--output", "xml"), fail)).toThrow('unknown --output mode "xml"');
    expect(() => parseOutputMode(argv("run", "--output=", "hi"), fail)).toThrow('unknown --output mode ""');
  });

  test("dangling --output (end of argv, or followed by a flag) → usage failure, never a silent default", () => {
    expect(() => parseOutputMode(argv("run", "hi", "--output"), fail)).toThrow("--output needs a value");
    expect(() => parseOutputMode(argv("--output", "--yolo", "run"), fail)).toThrow("--output needs a value");
  });
});

// ---------- prompt words ----------

describe("runPromptWords", () => {
  const cli = (cmd: string, ...rest: string[]) => ({ cmd, rest });

  test("a post-command --output value is dropped by POSITION (mutation: drop the splice → the prompt ends in 'json')", () => {
    expect(runPromptWords(cli("run", "hi", "json"), argv("run", "hi", "--output", "json"))).toEqual(["hi"]);
    // a prompt word equal to the mode survives — only the token that FOLLOWED --output goes
    expect(runPromptWords(cli("run", "convert", "to", "json", "json"), argv("run", "convert", "to", "json", "--output", "json"))).toEqual(["convert", "to", "json"]);
    expect(runPromptWords(cli("run", "json", "json", "please"), argv("run", "--output", "json", "json", "please"))).toEqual(["json", "please"]);
  });

  test("a pre-command --output value never reaches rest → words untouched", () => {
    expect(runPromptWords(cli("run", "hi"), argv("--output", "json", "run", "hi"))).toEqual(["hi"]);
    expect(runPromptWords(cli("hi", "there"), argv("--output", "json", "hi", "there"))).toEqual(["hi", "there"]);
  });

  test("bare-prompt path keeps cmd as the first word and still drops the value", () => {
    expect(runPromptWords(cli("hi", "json", "there"), argv("hi", "--output", "json", "there"))).toEqual(["hi", "there"]);
    expect(runPromptWords(cli("hi", "there"), argv("hi", "there"))).toEqual(["hi", "there"]);
  });

  test("edge forms: --output= (no value token), dangling --output, two --output flags, no prompt left", () => {
    expect(runPromptWords(cli("run", "hi"), argv("run", "hi", "--output=json"))).toEqual(["hi"]);
    expect(runPromptWords(cli("run", "hi"), argv("run", "hi", "--output"))).toEqual(["hi"]);
    expect(runPromptWords(cli("run", "hi", "json", "ndjson"), argv("run", "hi", "--output", "json", "--output", "ndjson"))).toEqual(["hi"]);
    expect(runPromptWords(cli("run", "json"), argv("run", "--output", "json"))).toEqual([]); // → the "hello" default at the call site
  });
});

// ---------- text mode ----------

describe("text mode — byte-identical to the pre-port cmdRun", () => {
  test("progress lines, blank line, summary on stdout; nothing on stderr; exit 0 (mutation: any reformatting)", () => {
    const r = drive("text");
    expect(r.out.text()).toBe('→ read {"path":"a.txt"}\n← ok line1 ⏎ line2\n\nall done\n');
    expect(r.err.text()).toBe("");
    expect(r.code).toBe(0);
  });

  test("clips: args to 100 chars, output to 200 chars; FAIL marker; error run exits 1", () => {
    const args = { s: "x".repeat(150) };
    const events: RunEvent[] = [
      { type: "run_start", runId: "r", sessionId: "s", goal: "g" },
      { type: "tool_execution_start", callId: "c", tool: "bash", args },
      { type: "tool_execution_end", callId: "c", ok: false, output: "y".repeat(300), durationMs: 1 },
      { type: "run_end", status: "error", summary: "error: boom" },
    ];
    const r = drive("text", { events });
    const lines = r.out.text().split("\n");
    expect(lines[0]).toBe(`→ bash ${JSON.stringify(args).slice(0, 100)}`);
    expect(lines[1]).toBe(`← FAIL ${"y".repeat(200)}`);
    expect(lines.slice(2)).toEqual(["", "error: boom", ""]);
    expect(r.code).toBe(1);
  });

  test("no run_end (defensive path): nothing more is printed, exit 1", () => {
    const r = drive("text", { events: script.slice(0, -1), end: null });
    expect(r.out.text()).toBe('→ read {"path":"a.txt"}\n← ok line1 ⏎ line2\n');
    expect(r.code).toBe(1);
  });
});

// ---------- json mode ----------

describe("json mode", () => {
  test("purity: NOTHING on stdout until finish; human progress goes to stderr (mutation: human() → stdout in json)", () => {
    const r = drive("json");
    expect(r.beforeFinish).toBe("");
    expect(r.err.text()).toBe('→ read {"path":"a.txt"}\n← ok line1 ⏎ line2\n');
  });

  test("exactly one JSON object + newline with the pinned key set (mutation: drop `usage` from the result)", () => {
    const res = single(drive("json").out.text());
    expect(Object.keys(res).sort()).toEqual(RESULT_KEYS);
  });

  test("values from the scripted run: status/summary/sessionId, requested model vs SERVED origin, summed usage, toolCalls with ms, exit 0", () => {
    const r = drive("json");
    const res = single(r.out.text());
    expect(res).toMatchObject({
      status: "done", summary: "all done", sessionId: "sess-1",
      model: { provider: "p", model: "m" }, origin: { provider: "p2", model: "served" },
      usage: { input: 300, output: 30, cacheRead: 5, cacheWrite: 3 },
      toolCalls: [{ tool: "read", ok: true, ms: 7 }], exitCode: 0,
    });
    expect(Number.isInteger(res.durationMs) && res.durationMs >= 0).toBe(true);
    expect(r.code).toBe(0);
  });

  test("unpriced cost is null (the default catalog knows no provider 'p') — never 0, never a lower bound", () => {
    expect(single(drive("json").out.text()).costUsd).toBeNull();
  });

  test("priced PER MESSAGE at the serving origin: fixed pricing → exact arithmetic; one unpriced origin → null; all-zero usage → 0", () => {
    const flat: PricingSource = { lookup: () => ({ pricing: { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2 } }) };
    // msg1 100in/10out/5cr → 0.0001 + 0.0001 + 0.0000005; msg2 200in/20out/3cw → 0.0002 + 0.0002 + 0.000006
    expect(single(drive("json", { catalog: flat }).out.text()).costUsd).toBeCloseTo(0.0006065, 12);
    const onlyP2: PricingSource = { lookup: (prov) => prov === "p2" ? { pricing: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 } } : undefined };
    expect(single(drive("json", { catalog: onlyP2 }).out.text()).costUsd).toBeNull(); // msg1 (origin p) is unpriced
    const zero = [msg("assistant", [{ kind: "text", text: "x" }], { usage: { input: 0, output: 0 }, origin: { provider: "p", model: "m" } })];
    expect(single(drive("json", { store: zero }).out.text()).costUsd).toBe(0); // nothing spent, nothing to price
  });

  test("only THIS run's messages count: prior-session usage before run_start is excluded", () => {
    const pre = [msg("assistant", [{ kind: "text", text: "old" }], { usage: { input: 9999, output: 9999 }, origin: { provider: "old", model: "old" } })];
    const res = single(drive("json", { pre }).out.text());
    expect(res.usage).toEqual({ input: 300, output: 30, cacheRead: 5, cacheWrite: 3 });
    expect(res.origin).toEqual({ provider: "p2", model: "served" });
  });

  test("a call that never executed (tool_call_failed, no start) lists ok:false WITHOUT ms; its name comes from the store's tool_call part", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r", sessionId: "s", goal: "g" },
      { type: "tool_call_failed", callId: "c9", reason: "permission_denied", detail: "no approver" },
      { type: "run_end", status: "done", summary: "could not" },
    ];
    const store = [msg("assistant", [{ kind: "tool_call", id: "c9", tool: "bash", args: { command: "rm" } }], { usage: { input: 1, output: 1 } })];
    const res = single(drive("json", { events, store }).out.text());
    expect(res.toolCalls).toEqual([{ tool: "bash", ok: false }]);
    expect("ms" in res.toolCalls[0]!).toBe(false);
  });

  test("loop ended without run_end: a result is still emitted — status error, exit 1", () => {
    const r = drive("json", { events: script.slice(0, -1), end: null });
    expect(single(r.out.text())).toMatchObject({ status: "error", summary: "stream ended without run_end", exitCode: 1 });
    expect(r.code).toBe(1);
  });
});

// ---------- LOW-B (#39): toolCalls keyed per issuing turn ----------

describe("toolCalls per ISSUED call (LOW-B, #39: the rovecode.tool_calls equality)", () => {
  /** turn `n` issues call id `same` (the SSE adapter's `tc<idx>` fallback shape) and executes it */
  const issue = (n: number, tool: string, ok: boolean, ms: number): RunEvent[] => [
    { type: "turn_start", turn: n }, { type: "turn_end", turn: n, stopReason: "tool_use" },
    { type: "tool_execution_start", callId: "same", tool, args: { n } },
    { type: "tool_execution_end", callId: "same", ok, output: `out${n}`, durationMs: ms },
  ];
  /** turn `n` issues `same` and it never dispatches */
  const refuse = (n: number, reason: "permission_denied" | "not_found"): RunEvent[] => [
    { type: "turn_start", turn: n }, { type: "turn_end", turn: n, stopReason: "tool_use" },
    { type: "tool_call_failed", callId: "same", reason, detail: reason },
  ];
  const scripted = (...body: RunEvent[][]): RunEvent[] => [
    { type: "run_start", runId: "r", sessionId: "s", goal: "g" }, ...body.flat(),
    { type: "turn_start", turn: 9 }, { type: "turn_end", turn: 9, stopReason: "end_turn" },
    { type: "run_end", status: "done", summary: "done" },
  ];
  /** the store's assistant message that issued `same` as `tool` */
  const part = (tool: string) => msg("assistant", [{ kind: "tool_call", id: "same", tool, args: {} }], { usage: { input: 1, output: 1 } });

  test("a call id REUSED across 3 turns is 3 entries in event order, each with its own tool/ok/ms — never a merge (mutation: key by callId alone → one entry carrying the last call's fields)", () => {
    const res = single(drive("json", { events: scripted(issue(1, "read", true, 1), issue(2, "bash", false, 2), issue(3, "write", true, 3)), store: [] }).out.text());
    expect(res.toolCalls).toEqual([{ tool: "read", ok: true, ms: 1 }, { tool: "bash", ok: false, ms: 2 }, { tool: "write", ok: true, ms: 3 }]);
  });

  test("never-dispatched reuses are their OWN entries on the turn that issued them, named from the store's tool_call parts by OCCURRENCE (the n-th record with an id ↔ the n-th part carrying it): turn 1 denied `rm`, turn 2 ran `read`, turn 3 `nope` not found → [rm ✗ no ms, read ✓ 1ms, nope ✗]; a later failure never flips an earlier entry (mutation: name by the LAST part → 'nope' for turn 1)", () => {
    const res = single(drive("json", { events: scripted(refuse(1, "permission_denied"), issue(2, "read", true, 1), refuse(3, "not_found")), store: [part("rm"), part("read"), part("nope")] }).out.text());
    expect(res.toolCalls).toEqual([{ tool: "rm", ok: false }, { tool: "read", ok: true, ms: 1 }, { tool: "nope", ok: false }]);
    expect("ms" in res.toolCalls[0]! || "ms" in res.toolCalls[2]!).toBe(false);
  });
});

// ---------- ndjson mode ----------

describe("ndjson mode", () => {
  test("one JSON line per RunEvent, verbatim and in order, then exactly one {type:'result'} line (mutation: drop the result line)", () => {
    const r = drive("ndjson");
    const lines = r.out.text().split("\n");
    expect(lines.at(-1)).toBe(""); // trailing newline
    const objs = lines.slice(0, -1).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(objs.length).toBe(script.length + 1);
    expect(objs.slice(0, script.length)).toEqual(script.map((e) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>));
    const last = objs.at(-1)!;
    expect(last["type"]).toBe("result");
    expect(Object.keys(last).sort()).toEqual([...RESULT_KEYS, "type"].sort());
    expect(last).toMatchObject({ status: "done", summary: "all done", sessionId: "sess-1", exitCode: 0 });
    expect(r.code).toBe(0);
  });

  test("events stream as they happen (not buffered to the end); no human lines anywhere", () => {
    const out = capture(), err = capture();
    const sink = createOutputSink("ndjson", { stdout: out, stderr: err, model, messages: () => [], onInterrupt: () => () => {} });
    sink.onEvent(script[0]!);
    expect(JSON.parse(out.text().trimEnd())).toEqual(JSON.parse(JSON.stringify(script[0])));
    sink.onEvent(script[3]!); // a tool start: no "→" line on either stream
    expect(err.text()).toBe("");
    expect(out.text()).not.toContain("→");
  });
});

// ---------- exit codes ----------

describe("exit codes", () => {
  test("mapping: done 0 · error/budget 1 · stopped (the loop's abort status) 130 · missing 1 (mutation: flatten to done?0:1)", () => {
    expect(exitCodeFor("done")).toBe(0);
    expect(exitCodeFor("error")).toBe(1);
    expect(exitCodeFor("budget")).toBe(1);
    expect(exitCodeFor("stopped")).toBe(130);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  test("an aborted run: finish returns 130 in every mode and the json result carries exitCode 130 + status stopped", () => {
    const r = drive("json", { end: { status: "stopped", summary: "run aborted" } });
    expect(r.code).toBe(130);
    expect(single(r.out.text())).toMatchObject({ status: "stopped", summary: "run aborted", exitCode: 130 });
    expect(drive("text", { end: { status: "stopped", summary: "run aborted" } }).code).toBe(130);
    expect(drive("ndjson", { end: { status: "stopped", summary: "run aborted" } }).code).toBe(130);
    expect(drive("json", { end: { status: "budget", summary: "max turns (60) reached" } }).code).toBe(1);
  });
});

// ---------- SIGINT seam ----------

describe("SIGINT → run abort", () => {
  test("the sink's signal aborts when the installed interrupt handler fires; finish uninstalls it once", () => {
    let handler: (() => void) | undefined;
    let uninstalled = 0;
    const sink = createOutputSink("json", {
      stdout: capture(), stderr: capture(), model, messages: () => [],
      onInterrupt: (h) => { handler = h; return () => { uninstalled++; }; },
    });
    expect(sink.signal.aborted).toBe(false);
    handler!();
    expect(sink.signal.aborted).toBe(true);
    sink.finish({ status: "stopped", summary: "run aborted" });
    expect(uninstalled).toBe(1);
  });

  test("default installer: exactly one SIGINT listener while the run lives, removed by finish", () => {
    const before = process.listenerCount("SIGINT");
    const sink = createOutputSink("text", { stdout: capture(), stderr: capture(), model, messages: () => [] });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    sink.finish({ status: "done", summary: "" });
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

// ---------- stdout guard ----------

describe("guardStdout (pi output-guard takeOverStdout)", () => {
  test("console.log/info/debug and process.stdout.write relay to the given stderr; restore puts the originals back (mutation: skip the console patch)", () => {
    const err = capture();
    const orig = { log: console.log, info: console.info, debug: console.debug, write: process.stdout.write };
    const g = guardStdout(err);
    try {
      console.log("stray %s %d", "a", 1);
      console.info("info");
      console.debug("debug");
      process.stdout.write("direct\n");
      process.stdout.write(new TextEncoder().encode("bytes\n"));
    } finally {
      g.restore();
    }
    expect(err.text()).toBe("stray a 1\ninfo\ndebug\ndirect\nbytes\n");
    expect(console.log).toBe(orig.log);
    expect(console.info).toBe(orig.info);
    expect(console.debug).toBe(orig.debug);
    expect(process.stdout.write).toBe(orig.write);
  });

  test("a sink over non-process writers never installs the guard (tests and embedders keep their console)", () => {
    const orig = { log: console.log, write: process.stdout.write };
    drive("json");
    drive("ndjson");
    expect(console.log).toBe(orig.log);
    expect(process.stdout.write).toBe(orig.write);
  });

  test("LOW-1: a json/ndjson sink over the REAL process.stdout installs the guard — strays via console.log AND process.stdout.write relay to the sink's stderr; close() restores the originals (mutation: `false && mode !== \"text\"` → console.log stays the original)", () => {
    for (const mode of ["json", "ndjson"] as const) {
      const err = capture();
      const orig = { log: console.log, info: console.info, debug: console.debug, write: process.stdout.write };
      const sink = createOutputSink(mode, { stdout: process.stdout, stderr: err, model, messages: () => [], onInterrupt: () => () => {} });
      try {
        expect(console.log).not.toBe(orig.log);
        expect(process.stdout.write).not.toBe(orig.write);
        console.log("LEAK %s", mode);
        process.stdout.write("LEAK2\n");
      } finally {
        sink.close();
      }
      expect(err.text()).toBe(`LEAK ${mode}\nLEAK2\n`);
      expect(console.log).toBe(orig.log);
      expect(console.info).toBe(orig.info);
      expect(console.debug).toBe(orig.debug);
      expect(process.stdout.write).toBe(orig.write);
    }
  });

  test("text mode over the real process.stdout installs NO guard (its console.log lines ARE the transcript); close() is a no-op (mutation: drop `mode !== \"text\"` → text mode hijacks console.log)", () => {
    const orig = { log: console.log, write: process.stdout.write };
    const sink = createOutputSink("text", { stdout: process.stdout, stderr: capture(), model, messages: () => [], onInterrupt: () => () => {} });
    try {
      expect(console.log).toBe(orig.log);
      expect(process.stdout.write).toBe(orig.write);
    } finally {
      sink.close(); // a mutant that DID install the guard must not leak a hijacked console into later tests
    }
    expect(console.log).toBe(orig.log);
    expect(process.stdout.write).toBe(orig.write);
  });
});

// ---------- cmdRun's LoopDeps ----------

describe("buildRunDeps (LOW-2: the hand-merged cmdRun LoopDeps, now one testable function)", () => {
  test("threads sink.signal and the runtime's hooks/guard/cwd/registry/store by IDENTITY, lists the registry's tool schemas, and nothing else; the signal is LIVE — the sink's SIGINT is the abort the loop sees (mutation: drop `signal` → deps.signal undefined)", () => {
    const root = mkdtempSync(join(tmpdir(), "rovecode-deps-"));
    try {
      const registry = new ToolRegistry();
      registry.register(readTool);
      const rt = { registry, store: new SessionStore(root, "s1"), guard: new ToolGuard(), planReminder: () => null, cwd: root, hooks: new HookRunner({ cwd: root, sessionId: "s1" }) };
      const stream = mockStream({ turns: [textTurn("unused")] });
      let fire: (() => void) | undefined;
      const sink = createOutputSink("json", { stdout: capture(), stderr: capture(), model, messages: () => [], onInterrupt: (h) => { fire = h; return () => {}; } });
      const deps = buildRunDeps(rt, stream, sink);
      expect(deps.signal).toBe(sink.signal);
      expect(deps.hooks).toBe(rt.hooks);
      expect(deps.guard).toBe(rt.guard);
      expect(deps.cwd).toBe(rt.cwd);
      expect(deps.stream).toBe(stream);
      expect(deps.registry).toBe(rt.registry);
      expect(deps.store).toBe(rt.store);
      expect(deps.tools).toEqual(registry.list().map((t) => t.schema));
      expect(deps.tools!.map((s) => s.name)).toEqual(["read"]);
      expect(Object.keys(deps).sort()).toEqual(["cwd", "guard", "hooks", "planReminder", "registry", "signal", "store", "stream", "tools"]);
      expect(deps.planReminder).toBe(rt.planReminder); // port #32: the open plan rides every headless turn too
      expect(deps.signal!.aborted).toBe(false);
      fire!();
      expect(deps.signal!.aborted).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
