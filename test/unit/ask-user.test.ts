/** PORT #33 — ask_user tool. Bar items pinned here (each test names its mutation target):
 *  - headless fail-closed: no asker bound → the exact clear error, ok:false, never hangs
 *  - answer shapes: choice → `answer: <label>` (+data), free text → `answer: <text>` (+data)
 *  - declined (null) → ok:false "user declined to answer"
 *  - abort: pre-aborted signal, and abort mid-question against a surface that never resolves
 *    → "ask_user aborted" within a deadline (mutation: drop the race → hangs → deadline fails)
 *  - arg validation (>8 options, empty question, long option, nothing to answer with)
 *  - registry/policy pins: createRuntime registers ask_user; kind read auto-runs under the gated
 *    AND plan rule sets with NO approver (mutation: kind "custom" → permission denied)
 *  - setAskUser late-binds/unbinds the asker (setBlockStore idiom)
 *  - the HTTP surface never binds an asker: over SSE the tool fails closed with the exact error
 *  HOUSE HAZARD: an await with no pending timer hangs the runner — every probe rides a deadline. */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askUserTool, parseQuestion, ASK_USER_UNAVAILABLE, ASK_USER_ABORTED, ASK_USER_DECLINED, MAX_OPTIONS,
  type AskFn, type QuestionAnswer, type QuestionPrompt,
} from "../../src/tools/ask-user.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import { applyModeRules } from "../../src/core/modes.ts";
import { startServer, type RovecodeServer } from "../../src/server/http.ts";
import type { Message, ModelRef, RunEvent, StreamEvent, StreamFn, ToolCallPart, ToolContext } from "../../src/core/types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** House hazard guard: a probe that never settles FAILS at the deadline instead of hanging. */
function deadline<T>(p: Promise<T>, ms = 2000, what = "probe"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} did not settle within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (timer) clearTimeout(timer); });
}

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { sessionId: "s-ask", cwd: process.cwd(), signal, permissions: { effect: "allow" } };
}

const Q = { question: "Which database?", options: ["postgres", "sqlite"] };

/** Scripted surface: records every prompt + the signal it received; answers via value or fn. */
function surface(answer: QuestionAnswer | null | ((q: QuestionPrompt, s: AbortSignal) => Promise<QuestionAnswer | null>)) {
  const seen: { prompt: QuestionPrompt; signal: AbortSignal }[] = [];
  const ask: AskFn = (q, s) => {
    seen.push({ prompt: q, signal: s });
    return typeof answer === "function" ? answer(q, s) : Promise.resolve(answer);
  };
  return { ask, seen };
}

// ---------- headless fail-closed ----------

test("headless: no asker bound → fails closed with the exact error, ok:false, no hang", async () => {
  const out = await deadline(askUserTool(() => undefined).execute(Q, ctx()));
  expect(out.ok).toBe(false);
  expect(out.output).toBe(ASK_USER_UNAVAILABLE);
  expect(out.output).toContain("headless");      // the message says WHY…
  expect(out.output).toContain("best judgment"); // …and what the model should do instead
});

// ---------- answer shapes ----------

test("choice answer → `answer: <label>` with data {choice,label}; the surface gets the normalized prompt", async () => {
  const s = surface({ choice: 1 });
  const out = await deadline(askUserTool(() => s.ask).execute({ question: "  Which database? ", options: [" postgres", "sqlite "] }, ctx()));
  expect(out).toEqual({ ok: true, output: "answer: sqlite", data: { choice: 1, label: "sqlite" } });
  expect(s.seen).toHaveLength(1);
  expect(s.seen[0]!.prompt).toEqual({ question: "Which database?", options: ["postgres", "sqlite"], allowFreeText: true });
});

test("free-text answer → `answer: <text>` with data {text}; allowFreeText:false reaches the surface", async () => {
  const s = surface({ text: "  mysql, please " });
  const out = await deadline(askUserTool(() => s.ask).execute({ ...Q, allowFreeText: true }, ctx()));
  expect(out).toEqual({ ok: true, output: "answer: mysql, please", data: { text: "mysql, please" } });
  const s2 = surface({ choice: 0 });
  expect(await deadline(askUserTool(() => s2.ask).execute({ ...Q, allowFreeText: false }, ctx()))).toEqual({ ok: true, output: "answer: postgres", data: { choice: 0, label: "postgres" } });
  expect(s2.seen[0]!.prompt.allowFreeText).toBe(false);
});

test("declined (surface resolves null, no abort) → ok:false 'user declined to answer'", async () => {
  const out = await deadline(askUserTool(() => surface(null).ask).execute(Q, ctx()));
  expect(out.ok).toBe(false); // mutation target: declined mapped to ok:true
  expect(out.output).toBe(ASK_USER_DECLINED);
});

test("an unusable surface answer (choice out of range / fractional, blank text, empty) → ok:false", async () => {
  for (const a of [{ choice: 2 }, { choice: -1 }, { choice: 0.5 }, { text: "   " }, {}]) {
    const out = await deadline(askUserTool(() => surface(a).ask).execute(Q, ctx()));
    expect(out).toEqual({ ok: false, output: "ask_user failed: the surface returned an unusable answer" });
  }
});

// ---------- abort ----------

test("pre-aborted signal → 'ask_user aborted'; the surface is never asked", async () => {
  const ac = new AbortController();
  ac.abort();
  const s = surface({ choice: 0 });
  const out = await deadline(askUserTool(() => s.ask).execute(Q, ctx(ac.signal)));
  expect(out).toEqual({ ok: false, output: ASK_USER_ABORTED });
  expect(s.seen).toHaveLength(0);
});

test("abort mid-question against a surface that NEVER resolves → 'ask_user aborted' within the deadline; the surface got THE run signal; no listener leak", async () => {
  const ac = new AbortController();
  // count listeners on this very signal: the tool must remove its abort hook when it settles
  let live = 0;
  const sig = ac.signal;
  const add = sig.addEventListener.bind(sig), remove = sig.removeEventListener.bind(sig);
  sig.addEventListener = ((...a: Parameters<typeof add>) => { live++; return add(...a); }) as typeof sig.addEventListener;
  sig.removeEventListener = ((...a: Parameters<typeof remove>) => { live--; return remove(...a); }) as typeof sig.removeEventListener;
  const s = surface(() => new Promise<never>(() => {})); // deaf surface: ignores the signal, never settles
  const pending = askUserTool(() => s.ask).execute(Q, ctx(sig));
  await sleep(20);
  expect(s.seen).toHaveLength(1);
  expect(s.seen[0]!.signal).toBe(sig); // the surface receives the run controller's signal (so a real card can dismiss on it)
  expect(live).toBe(1);
  ac.abort();
  // mutation target: `await ask(...)` without the race → this never settles → the deadline throws
  const out = await deadline(pending, 1500, "aborted ask_user");
  expect(out).toEqual({ ok: false, output: ASK_USER_ABORTED });
  expect(live).toBe(0);
});

test("a surface that answers null BECAUSE the signal aborted reports aborted, not declined", async () => {
  const ac = new AbortController();
  const s = surface((_q, sig) => new Promise((res) => sig.addEventListener("abort", () => res(null), { once: true })));
  const pending = askUserTool(() => s.ask).execute(Q, ctx(ac.signal));
  await sleep(10);
  ac.abort();
  expect(await deadline(pending)).toEqual({ ok: false, output: ASK_USER_ABORTED });
});

// ---------- surface failures never escape the tool seam ----------

test("a rejecting or throwing surface (e.g. another overlay is already open) → ok:false 'ask_user failed: …'", async () => {
  const s = surface(() => Promise.reject(new Error("a question or approval overlay is already open")));
  const out = await deadline(askUserTool(() => s.ask).execute(Q, ctx()));
  expect(out).toEqual({ ok: false, output: "ask_user failed: a question or approval overlay is already open" });
  const s2 = surface(() => { throw new Error("boom"); });
  expect(await deadline(askUserTool(() => s2.ask).execute(Q, ctx()))).toEqual({ ok: false, output: "ask_user failed: boom" });
});

// ---------- validation ----------

test("arg validation fails closed BEFORE the surface is asked", async () => {
  const s = surface({ choice: 0 });
  const tool = askUserTool(() => s.ask);
  const bad: [unknown, string][] = [
    [undefined, "question must be a non-empty string"],
    [{ question: "   " }, "question must be a non-empty string"],
    [{ question: "x".repeat(2001) }, "question too long (2001 chars, max 2000)"],
    [{ question: "q?", options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`) }, `too many options (${MAX_OPTIONS + 1}, max ${MAX_OPTIONS})`],
    [{ question: "q?", options: "a,b" }, "options must be an array of strings"],
    [{ question: "q?", options: ["a", ""] }, "every option must be a non-empty string"],
    [{ question: "q?", options: ["a", 3] }, "every option must be a non-empty string"],
    [{ question: "q?", options: ["y".repeat(81)] }, `option too long (81 chars, max 80): ${"y".repeat(40)}…`],
    [{ question: "q?", allowFreeText: "yes" }, "allowFreeText must be a boolean"],
    [{ question: "q?", options: [], allowFreeText: false }, "nothing to answer with: provide options or allow free text"],
  ];
  for (const [args, msg] of bad) {
    expect(parseQuestion(args)).toBe(msg);
    expect(await deadline(tool.execute(args, ctx()))).toEqual({ ok: false, output: `ask_user failed: ${msg}` });
  }
  expect(s.seen).toHaveLength(0);
  // exactly MAX_OPTIONS is fine; an empty options array with free text collapses to free-text only
  expect(parseQuestion({ question: "q?", options: Array.from({ length: MAX_OPTIONS }, (_, i) => `o${i}`) })).toMatchObject({ allowFreeText: true });
  expect(parseQuestion({ question: "q?", options: [] })).toEqual({ question: "q?", allowFreeText: true });
});

// ---------- registry + policy pins (createRuntime) ----------

function tmpCwd(): string { return mkdtempSync(join(tmpdir(), "rovecode-askuser-")); }
const call = (args: unknown): ToolCallPart => ({ kind: "tool_call", id: "ask-1", tool: "ask_user", args });

test("createRuntime registers ask_user (kind read, sequential); the GATED rules run it with NO approver; unbound → the exact headless error", async () => {
  const cwd = tmpCwd();
  try {
    const rt = createRuntime({ cwd, stream: null });
    const tool = rt.registry.list().find((t) => t.schema.name === "ask_user");
    expect(tool).toBeDefined();
    expect(tool!.kind).toBe("read");      // mutation target: kind "custom" → action tool.ask_user has no rule → denied below
    expect(tool!.sequential).toBe(true);
    const cfg = rt.buildCfg(false);       // gated, approver-less: exactly what `rovecode run` / serve / acp build
    const events: RunEvent[] = [];
    const out = await deadline(rt.registry.dispatch(call(Q), ctx(), undefined, cfg.permissionRules, undefined, (e) => events.push(e)));
    expect(out).toEqual({ ok: false, output: ASK_USER_UNAVAILABLE });
    // it REACHED execute: no permission_denied and no approval on the way (asking must never need approval)
    expect(events.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("plan mode keeps ask_user runnable (file.read is re-allowed there while tool.* is denied)", async () => {
  const cwd = tmpCwd();
  try {
    const rt = createRuntime({ cwd, stream: null });
    const rules = applyModeRules("plan", rt.buildCfg(false).permissionRules);
    const events: RunEvent[] = [];
    const out = await deadline(rt.registry.dispatch(call(Q), ctx(), undefined, rules, undefined, (e) => events.push(e)));
    expect(out.output).toBe(ASK_USER_UNAVAILABLE); // reached execute, not "Permission denied"
    expect(events.some((e) => e.type === "tool_call_failed")).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("setAskUser late-binds the asker behind the registered tool; undefined unbinds (fail-closed again)", async () => {
  const cwd = tmpCwd();
  try {
    const rt = createRuntime({ cwd, stream: null });
    const rules = rt.buildCfg(false).permissionRules;
    const s = surface({ choice: 1 });
    rt.setAskUser(s.ask); // mutation target: getter always undefined → this stays UNAVAILABLE
    const answered = await deadline(rt.registry.dispatch(call(Q), ctx(), undefined, rules, undefined, () => {}));
    expect(answered).toEqual({ ok: true, output: "answer: sqlite", data: { choice: 1, label: "sqlite" } });
    expect(s.seen).toHaveLength(1);
    rt.setAskUser(undefined);
    const unbound = await deadline(rt.registry.dispatch(call(Q), ctx(), undefined, rules, undefined, () => {}));
    expect(unbound).toEqual({ ok: false, output: ASK_USER_UNAVAILABLE });
    expect(s.seen).toHaveLength(1); // the old asker is gone, not still reachable
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- headless surface end-to-end: the HTTP server never binds an asker ----------

const servers: RovecodeServer[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); }); // house rule: no orphan sockets

test("HTTP surface (serve): ask_user fails closed over SSE with the exact error and the run continues to a normal end", async () => {
  const cwd = tmpCwd();
  // scripted provider: turn 1 asks; once the tool answered (last message role tool) echo its output
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const last = messages[messages.length - 1];
    if (last?.role === "tool") {
      const out = last.parts.map((p) => (p.kind === "tool_result" ? p.output : "")).join("");
      yield { type: "turn", turn: { parts: [{ kind: "text", text: `SAW:${out}` }], stopReason: "end_turn", usage: { input: 0, output: 1 } } };
      return;
    }
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "ask-http", tool: "ask_user", args: Q }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
  };
  const srv = startServer({ port: 0, cwd, stream });
  servers.push(srv);
  try {
    const created = await deadline(fetch(`${srv.url}/session`, { method: "POST" }), 8000, "create session");
    const { id } = (await created.json()) as { id: string };
    const res = await deadline(fetch(`${srv.url}/session/${id}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ask me" }),
    }), 8000, "prompt");
    const body = await deadline(res.text(), 8000, "sse body"); // resolving proves the stream closed
    const frames = body.split("\n\n").filter((c) => c.trim()).map((c) => {
      const data = c.split("\n").find((l) => l.startsWith("data: "))!;
      return JSON.parse(data.slice("data: ".length)) as RunEvent;
    });
    const end = frames.find((f) => f.type === "tool_execution_end" && f.callId === "ask-http");
    expect(end).toBeDefined();
    if (end?.type === "tool_execution_end") { expect(end.ok).toBe(false); expect(end.output).toBe(ASK_USER_UNAVAILABLE); }
    expect(frames.some((f) => f.type === "tool_call_failed")).toBe(false); // policy let it run; execute failed closed
    const runEnd = frames.find((f) => f.type === "run_end");
    expect(runEnd?.type === "run_end" ? runEnd.status : "missing").toBe("done"); // the model saw the error and finished
    expect(runEnd?.type === "run_end" ? runEnd.summary : "").toBe(`SAW:${ASK_USER_UNAVAILABLE}`);
  } finally {
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15_000);
