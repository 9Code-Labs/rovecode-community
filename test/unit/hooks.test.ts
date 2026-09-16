/** Hooks v2 (port #29) unit tests: the loader (project + user scope, order, missing, syntax error,
 *  version gate, .ts + .js) and the runner (first-deny-wins, validation + bounds, timeout, isolation,
 *  post_tool chaining, open()/run() ordering, close() once, warnings, observer mapping). Every hooks
 *  file lives in a fresh temp dir — Bun caches modules by path — and each talks back through a
 *  test-unique globalThis key (a loaded module has no other channel to the test). */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustFile } from "../../src/core/trust.ts";
import {
  HookRunner, loadHooks, hookTimeoutMs, HOOKS_API_VERSION, HOOK_NAMES, DEFAULT_HOOK_TIMEOUT_MS,
  MAX_DENY_REASON_CHARS, MAX_POST_TOOL_GROWTH_CHARS, type HookCtx,
} from "../../src/core/hooks.ts";
import type { RunEvent } from "../../src/core/types.ts";

const ctx: HookCtx = { cwd: "/w", sessionId: "s1" };
const call = { id: "c1", tool: "bash", args: { command: "ls" } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** deadline guard — house hazard: an awaited promise with no pending timer hangs the runner forever */
const deadline = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "DEADLINE" as const)]);

let seq = 0;
interface Rig { cwd: string; home: string; key: string; log: unknown[]; done: () => void }
function rig(): Rig {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-hooks-home-"));
  const key = `__rovecodeHooksTest_${process.pid}_${++seq}`;
  const log: unknown[] = [];
  (globalThis as Record<string, unknown>)[key] = log;
  homeOf.set(cwd, home); // project() approves the file it writes in THIS rig's home (the trust gate, core/trust.ts)
  return {
    cwd, home, key, log,
    done: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      delete (globalThis as Record<string, unknown>)[key];
    },
  };
}
/** a hooks module whose hooks push into the rig's log */
function moduleText(key: string, hooksBody: string, version: string | number = HOOKS_API_VERSION): string {
  return `const log = globalThis[${JSON.stringify(key)}];\nexport default { version: ${version}, hooks: { ${hooksBody} } };\n`;
}
const homeOf = new Map<string, string>();
/** a PROJECT hooks file, approved as written (since 2026-09-07 an untrusted project file is not imported —
 *  test/unit/project-trust.test.ts pins that; these tests are about what a trusted file does) */
function project(cwd: string, text: string, ext = "ts"): string {
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  const p = join(cwd, ".rovecode", `hooks.${ext}`);
  writeFileSync(p, text);
  const t = trustFile(homeOf.get(cwd)!, p);
  if (!t.ok) throw new Error(t.reason);
  return p;
}
function user(home: string, text: string, ext = "ts"): string {
  const p = join(home, `hooks.${ext}`);
  writeFileSync(p, text);
  return p;
}

// ---------- contract ----------

test("contract: nine typed hooks (ADR-013 budget ≤10), API version 1", () => {
  expect(HOOKS_API_VERSION).toBe(1);
  expect(HOOK_NAMES.length).toBe(9);
  expect(HOOK_NAMES.length).toBeLessThanOrEqual(10);
  expect([...HOOK_NAMES].sort()).toEqual([
    "approval", "compaction", "on_event", "post_run", "post_tool", "pre_run", "pre_tool", "session_close", "session_open",
  ]);
});

// ---------- loader ----------

test("loadHooks: no files anywhere → no sets, no warnings", async () => {
  const r = rig();
  try {
    expect(await loadHooks(r.cwd, { home: r.home })).toEqual({ hooks: [], sources: [], warnings: [] });
  } finally { r.done(); }
});

test("loadHooks: user scope first, project second, both .ts; the loaded functions are live", async () => {
  const r = rig();
  try {
    const u = user(r.home, moduleText(r.key, `pre_run(ctx) { log.push(["user", ctx.sessionId]); }`));
    const p = project(r.cwd, moduleText(r.key, `pre_run(ctx) { log.push(["project", ctx.sessionId]); }, on_event() {}`));
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.sources).toEqual([u, p]);
    expect(loaded.hooks.map((h) => Object.keys(h).sort())).toEqual([["pre_run"], ["on_event", "pre_run"]]);
    for (const h of loaded.hooks) await h.pre_run!(ctx);
    expect(r.log).toEqual([["user", "s1"], ["project", "s1"]]);
  } finally { r.done(); }
});

test("loadHooks: .js loads too — ESM default export (project) and CJS module.exports (user scope)", async () => {
  const r = rig();
  try {
    user(r.home, `module.exports = { version: 1, hooks: { pre_run() { globalThis[${JSON.stringify(r.key)}].push("cjs"); } } };\n`, "js");
    project(r.cwd, moduleText(r.key, `pre_run() { log.push("esm"); }`), "js");
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.hooks.length).toBe(2);
    for (const h of loaded.hooks) await h.pre_run!(ctx);
    expect(r.log).toEqual(["cjs", "esm"]);
  } finally { r.done(); }
});

test("loadHooks: hooks.ts shadows hooks.js in the same scope, with a warning naming both", async () => {
  const r = rig();
  try {
    const ts = project(r.cwd, moduleText(r.key, `pre_run() { log.push("ts"); }`));
    const js = project(r.cwd, moduleText(r.key, `pre_run() { log.push("js"); }`), "js");
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.sources).toEqual([ts]);
    expect(loaded.warnings).toEqual([`${js}: ignored — ${ts} takes precedence`]);
    await loaded.hooks[0]!.pre_run!(ctx);
    expect(r.log).toEqual(["ts"]);
  } finally { r.done(); }
});

test("loadHooks: a syntax error and an import-time throw each become ONE warning naming the file — never a throw; a healthy sibling still loads", async () => {
  const r = rig();
  try {
    const bad = project(r.cwd, "export default { version: 1, hooks: {\n"); // unterminated → Bun BuildMessage (not an Error)
    const boom = user(r.home, "throw new Error('boom at import');\n");
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.hooks).toEqual([]);
    expect(loaded.warnings.length).toBe(2);
    expect(loaded.warnings[0]).toBe(`${boom}: failed to load — boom at import`);
    expect(loaded.warnings[1]!.startsWith(`${bad}: failed to load — `)).toBe(true);
    expect(loaded.warnings[1]!.length).toBeGreaterThan(`${bad}: failed to load — `.length); // the parser's message rides along
  } finally { r.done(); }
  const r2 = rig();
  try {
    user(r2.home, "export default { version: 1, hooks: {\n");
    const ok = project(r2.cwd, moduleText(r2.key, `pre_run() { log.push("ok"); }`));
    const loaded = await loadHooks(r2.cwd, { home: r2.home });
    expect(loaded.sources).toEqual([ok]);
    expect(loaded.warnings.length).toBe(1);
    await loaded.hooks[0]!.pre_run!(ctx);
    expect(r2.log).toEqual(["ok"]);
  } finally { r2.done(); }
});

test("version gate: version 2, a missing version, and a missing default export are each skipped with a warning; the version-1 sibling still loads", async () => {
  const r = rig();
  try {
    const v2 = user(r.home, moduleText(r.key, `pre_run() { log.push("v2"); }`, 2));
    const ok = project(r.cwd, moduleText(r.key, `pre_run() { log.push("ok"); }`));
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.sources).toEqual([ok]);
    expect(loaded.warnings).toEqual([`${v2}: hooks API version 2 is not supported (this rovecode speaks 1) — skipped`]);
    await loaded.hooks[0]!.pre_run!(ctx);
    expect(r.log).toEqual(["ok"]); // the v2 file's hooks never ran
  } finally { r.done(); }
  const r2 = rig();
  try {
    const noVersion = user(r2.home, "export default { hooks: { pre_run() {} } };\n");
    const noDefault = project(r2.cwd, "export const hooks = { pre_run() {} };\n");
    const loaded = await loadHooks(r2.cwd, { home: r2.home });
    expect(loaded.hooks).toEqual([]);
    expect(loaded.warnings).toEqual([
      `${noVersion}: hooks API version missing is not supported (this rovecode speaks 1) — skipped`,
      `${noDefault}: default export must be { version: 1, hooks: {…} } — skipped`,
    ]);
  } finally { r2.done(); }
});

test("loadHooks: unknown hook names, non-function members and a non-object `hooks` are warned about; the valid hooks stay", async () => {
  const r = rig();
  try {
    const p = project(r.cwd, moduleText(r.key, `pre_run() { log.push("ok"); }, before_tool() {}, post_run: 42`));
    const notObject = user(r.home, "export default { version: 1, hooks: 'nope' };\n");
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.sources).toEqual([p]);
    expect(loaded.hooks.map((h) => Object.keys(h))).toEqual([["pre_run"]]);
    expect(loaded.warnings).toEqual([
      `${notObject}: "hooks" must be an object of hook functions — skipped`,
      `${p}: unknown hook "before_tool" ignored (known: ${HOOK_NAMES.join(", ")})`,
      `${p}: hook "post_run" is not a function — ignored`,
    ]);
  } finally { r.done(); }
});

test("ROVECODE_NO_HOOKS=1 skips the files silently", async () => {
  const r = rig();
  const saved = process.env.ROVECODE_NO_HOOKS;
  try {
    project(r.cwd, moduleText(r.key, `pre_run() {}`));
    process.env.ROVECODE_NO_HOOKS = "1";
    expect(await loadHooks(r.cwd, { home: r.home })).toEqual({ hooks: [], sources: [], warnings: [] });
  } finally {
    if (saved === undefined) delete process.env.ROVECODE_NO_HOOKS; else process.env.ROVECODE_NO_HOOKS = saved;
    r.done();
  }
});

test("version gate shows a STRING version quoted: `version: \"1\"` is refused as \"1\", never rendered as the supported number 1", async () => {
  const r = rig();
  try {
    const strV = project(r.cwd, moduleText(r.key, `pre_run() { log.push("never"); }`, '"1"'));
    const loaded = await loadHooks(r.cwd, { home: r.home });
    expect(loaded.hooks).toEqual([]);
    expect(loaded.warnings).toEqual([`${strV}: hooks API version "1" is not supported (this rovecode speaks 1) — skipped`]);
    expect(r.log).toEqual([]);
  } finally { r.done(); }
});

// ---------- runner ----------

test("run(pre_tool): sets run in attach order, the first deny wins and later sets are not consulted; void falls through", async () => {
  const seen: string[] = [];
  const runner = new HookRunner(ctx);
  runner.add({ pre_tool: () => { seen.push("a"); } }, "a");
  runner.add({ pre_tool: async () => { seen.push("b"); return { deny: "b says no" }; } }, "b");
  runner.add({ pre_tool: () => { seen.push("c"); return { deny: "c never runs" }; } }, "c");
  expect(await runner.run("pre_tool", ctx, call)).toEqual({ deny: "b says no" });
  expect(seen).toEqual(["a", "b"]);
  expect(runner.warnings).toEqual([]);
  expect(runner.size).toBe(3);
  expect(runner.has("pre_tool")).toBe(true);
  expect(runner.has("approval")).toBe(false);
  expect(await new HookRunner(ctx).run("pre_tool", ctx, call)).toBeUndefined(); // no sets → nothing
});

test("results are validated: bad pre_tool/approval results are ignored with a warning; a deny reason is bounded", async () => {
  const runner = new HookRunner(ctx);
  runner.add({ pre_tool: () => ({ deny: "   " }) as never, approval: () => "maybe" as never }, "junk");
  runner.add({ pre_tool: () => ({ deny: "x".repeat(MAX_DENY_REASON_CHARS + 50) }), approval: () => "deny" }, "real");
  const d = await runner.run("pre_tool", ctx, call);
  expect(d!.deny.length).toBe(MAX_DENY_REASON_CHARS + 1); // clipped + "…"
  expect(d!.deny.endsWith("…")).toBe(true);
  expect(await runner.run("approval", ctx, { tool: "bash", args: {}, revisedArgs: {}, reason: "r" })).toBe("deny");
  expect(runner.warnings).toEqual([
    "junk: pre_tool hook returned an invalid result (object with keys deny) — ignored",
    'junk: approval hook returned an invalid result ("maybe") — ignored',
  ]);
  // void hooks ignore a stray return value without complaint
  const quiet = new HookRunner(ctx);
  quiet.add({ pre_run: () => 42 as never });
  expect(await quiet.run("pre_run", ctx)).toBeUndefined();
  expect(quiet.warnings).toEqual([]);
});

test("approver(): the approval hook as an ApprovalFn — 'allow' → 'once', 'deny' → 'deny', void → the human's verdict, void with no human → 'deny' (fail closed); an invalid result is void + a warning; ctx is the runner's own", async () => {
  const seen: HookCtx[] = [];
  let answer: unknown = "allow";
  const runner = new HookRunner(ctx);
  runner.add({ approval: (c) => { seen.push(c); return answer as "allow"; } }, "set");
  const req = { tool: "bash", args: { command: "x" }, revisedArgs: { command: "x" }, reason: "r" };
  const human: string[] = [];
  const withHuman = runner.approver(async (r) => { human.push(r.reason); return "always"; });
  expect(await withHuman(req)).toBe("once");
  answer = "deny";
  expect(await withHuman(req)).toBe("deny");
  answer = undefined;
  expect(await withHuman(req)).toBe("always");
  expect(human).toEqual(["r"]);
  answer = "maybe";
  expect(await withHuman(req)).toBe("always"); // invalid → void → the human decides
  expect(runner.warnings).toEqual(['set: approval hook returned an invalid result ("maybe") — ignored']);
  const headless = runner.approver();
  answer = undefined;
  expect(await headless(req)).toBe("deny");
  answer = "allow";
  expect(await headless(req)).toBe("once");
  expect(seen.length).toBe(6);
  expect(seen.every((c) => c === ctx)).toBe(true); // the runner's base ctx, by identity
  // no approval hook at all → straight to the human, or fail closed without one
  const bare = new HookRunner(ctx);
  expect(await bare.approver(async () => "once")(req)).toBe("once");
  expect(await bare.approver()(req)).toBe("deny");
});

test("run(post_tool): sets chain (the next set sees the previous output), {} leaves the output alone, growth is bounded with a marker", async () => {
  const runner = new HookRunner(ctx);
  const seen: string[] = [];
  runner.add({ post_tool: (_c, _call, r) => { seen.push(r.output); return { output: r.output + " +a" }; } }, "a");
  runner.add({ post_tool: (_c, _call, r) => { seen.push(r.output); return {}; } }, "b");
  runner.add({ post_tool: (_c, _call, r) => { seen.push(r.output); return { output: r.output + " +c" }; } }, "c");
  expect(await runner.run("post_tool", ctx, call, { ok: true, output: "base" })).toEqual({ output: "base +a +c" });
  expect(seen).toEqual(["base", "base +a", "base +a"]);
  // growth bound: original (4 chars) + cap, then a marker
  const big = new HookRunner(ctx);
  big.add({ post_tool: () => ({ output: "y".repeat(MAX_POST_TOOL_GROWTH_CHARS + 4 + 1000) }) });
  const out = (await big.run("post_tool", ctx, call, { ok: true, output: "base" }))!.output!;
  expect(out.startsWith("y".repeat(MAX_POST_TOOL_GROWTH_CHARS + 4))).toBe(true);
  expect(out).toContain(`[post_tool output truncated: hooks may add at most ${MAX_POST_TOOL_GROWTH_CHARS} chars]`);
  expect(out.length).toBeLessThan(MAX_POST_TOOL_GROWTH_CHARS + 4 + 200);
  // a non-string output is invalid → ignored with a warning
  const bad = new HookRunner(ctx);
  bad.add({ post_tool: () => ({ output: 42 }) as never }, "bad");
  expect(await bad.run("post_tool", ctx, call, { ok: true, output: "base" })).toBeUndefined();
  expect(bad.warnings).toEqual(["bad: post_tool hook returned an invalid result (object with keys output) — ignored"]);
});

test("timeout: a hanging hook resolves undefined at ~timeoutMs with a warning; the next set still runs; nothing hangs", async () => {
  const runner = new HookRunner(ctx, { timeoutMs: 80 });
  runner.add({ pre_tool: () => new Promise(() => {}) }, "hang");
  runner.add({ pre_tool: () => ({ deny: "after the hang" }) }, "next");
  const t0 = Date.now();
  const d = await deadline(runner.run("pre_tool", ctx, call), 3000);
  const elapsed = Date.now() - t0;
  expect(d).toEqual({ deny: "after the hang" });
  expect(elapsed).toBeGreaterThanOrEqual(75);
  expect(elapsed).toBeLessThan(2500);
  expect(runner.warnings).toEqual(["hang: pre_tool hook timed out after 80ms — ignored, run continues"]);
});

test("isolation: a sync throw and an async rejection each become undefined + one warning; other sets still run", async () => {
  const runner = new HookRunner(ctx);
  runner.add({ pre_tool: () => { throw new Error("sync boom"); }, pre_run: async () => { throw new TypeError("async boom"); } }, "bad");
  runner.add({ pre_tool: () => ({ deny: "still consulted" }) }, "good");
  expect(await runner.run("pre_tool", ctx, call)).toEqual({ deny: "still consulted" });
  expect(await runner.run("pre_run", ctx)).toBeUndefined();
  expect(runner.warnings).toEqual([
    "bad: pre_tool hook threw: sync boom — ignored, run continues",
    "bad: pre_run hook threw: async boom — ignored, run continues",
  ]);
});

test("open(): a run() issued before the load settles still sees the file's hooks; session_open fires once (a second open() is a no-op)", async () => {
  const r = rig();
  try {
    project(r.cwd, moduleText(r.key, `session_open(ctx) { log.push(["open", ctx.sessionId]); }, pre_run(ctx) { log.push(["pre_run", ctx.runId]); }`));
    const runner = new HookRunner({ cwd: r.cwd, sessionId: "boot" });
    const opening = runner.open(r.cwd, { home: r.home });
    const early = runner.run("pre_run", { cwd: r.cwd, sessionId: "boot", runId: "r1" }); // issued mid-load, not awaited yet
    expect(runner.open(r.cwd, { home: r.home })).toBe(opening);
    await opening; await early; await runner.ready;
    expect(r.log).toEqual([["open", "boot"], ["pre_run", "r1"]]); // session_open first, exactly once, then the early run
    expect(runner.size).toBe(1);
    expect(runner.warnings).toEqual([]);
  } finally { r.done(); }
});

test("close(): session_close fires once, after in-flight on_event taps settle; repeated close() shares the promise", async () => {
  const log: string[] = [];
  const runner = new HookRunner(ctx, { timeoutMs: 500 });
  runner.add({
    on_event: async (_c, ev) => { await sleep(30); log.push(`ev:${ev.type}`); },
    session_close: () => { log.push("close"); },
  });
  const obs = runner.observer(ctx);
  await obs.observe({ type: "turn_start", turn: 1 });
  const c1 = runner.close();
  const c2 = runner.close();
  expect(c1).toBe(c2);
  await c1;
  await runner.close();
  expect(log).toEqual(["ev:turn_start", "close"]);
});

test("warnings: bounded to 50 notes of ≤300 chars; onWarning replays the buffer then streams; drainWarnings empties", async () => {
  const runner = new HookRunner(ctx);
  runner.add({ pre_run: () => { throw new Error("e".repeat(1000)); } }, "noisy");
  for (let i = 0; i < 60; i++) await runner.run("pre_run", ctx);
  expect(runner.warnings.length).toBe(50);
  expect(runner.warnings[0]!.length).toBe(301); // 300 + "…"
  const got: string[] = [];
  runner.onWarning((w) => got.push(w));
  expect(got.length).toBe(50); // replayed
  await runner.run("pre_run", ctx);
  expect(got.length).toBe(51); // streamed
  expect(runner.drainWarnings().length).toBe(50);
  expect(runner.warnings).toEqual([]);
});

test("hookTimeoutMs: ROVECODE_HOOK_TIMEOUT_MS parses; blank/invalid/zero fall back to 5000; the option overrides", () => {
  expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(5000);
  expect(hookTimeoutMs({})).toBe(5000);
  expect(hookTimeoutMs({ ROVECODE_HOOK_TIMEOUT_MS: "" })).toBe(5000);
  expect(hookTimeoutMs({ ROVECODE_HOOK_TIMEOUT_MS: "abc" })).toBe(5000);
  expect(hookTimeoutMs({ ROVECODE_HOOK_TIMEOUT_MS: "0" })).toBe(5000);
  expect(hookTimeoutMs({ ROVECODE_HOOK_TIMEOUT_MS: "250.9" })).toBe(250);
  expect(new HookRunner(ctx, { timeoutMs: 7 }).timeoutMs).toBe(7);
});

test("observer.close() (the loop's consumer-closed teardown, #39 MED-1): after run_start it fires post_run ONCE with {stopped, run aborted} and synthesizes NO on_event; a second close() is a no-op; after a yielded run_end it is a no-op; before any run_start it does nothing", async () => {
  const log: unknown[] = [];
  const runner = new HookRunner(ctx);
  runner.add({
    pre_run: (c) => { log.push(["pre_run", c.runId]); },
    post_run: (c, r) => { log.push(["post_run", c.runId, r]); },
    on_event: (_c, ev) => { log.push(["ev", ev.type]); },
  });
  const a = runner.observer({ cwd: "/w", sessionId: "s1" });
  await a.close(); // nothing started: no post_run
  await a.observe({ type: "run_start", runId: "A", sessionId: "s1", goal: "g" });
  await a.observe({ type: "turn_start", turn: 1 });
  await a.close(); // the consumer .return()ed the generator (MUTATION TARGET: drop the post_run → no boundary)
  await a.close(); // idempotent (mutation: drop `ended` → a second post_run)
  await runner.settle();
  expect(log).toEqual([["ev", "run_start"], ["pre_run", "A"], ["ev", "turn_start"], ["post_run", "A", { status: "stopped", summary: "run aborted" }]]);
  log.length = 0;
  const b = runner.observer({ cwd: "/w", sessionId: "s1" });
  await b.observe({ type: "run_start", runId: "B", sessionId: "s1", goal: "g" });
  await b.observe({ type: "run_end", status: "done", summary: "ok" });
  await b.close(); // a yielded run_end already fired post_run: nothing more
  await runner.settle();
  expect(log.filter((e) => (e as unknown[])[0] === "post_run")).toEqual([["post_run", "B", { status: "done", summary: "ok" }]]);
  expect(log.filter((e) => (e as unknown[])[0] === "ev").length).toBe(2); // run_start + run_end only — never a synthesized event
  expect(runner.warnings).toEqual([]);
});

test("observer: run_start → pre_run (runId captured), compaction → compaction hook, run_end → post_run; on_event taps every event in order", async () => {
  const log: unknown[] = [];
  const runner = new HookRunner(ctx);
  runner.add({
    pre_run: (c) => { log.push(["pre_run", c.runId]); },
    compaction: (c, ev) => { log.push(["compaction", c.runId, ev.strategy]); },
    post_run: (c, r) => { log.push(["post_run", c.runId, r]); },
    on_event: (c, ev) => { log.push(["ev", c.runId, ev.type]); },
  });
  const obs = runner.observer({ cwd: "/w", sessionId: "s1" });
  const events: RunEvent[] = [
    { type: "run_start", runId: "R", sessionId: "s1", goal: "g" },
    { type: "turn_start", turn: 1 },
    { type: "compaction", strategy: "keep-window", trigger: "speculative", tokensBefore: 9, tokensAfter: 3 },
    { type: "run_end", status: "done", summary: "ok" },
  ];
  for (const ev of events) await obs.observe(ev);
  await runner.settle();
  expect(log).toEqual([
    ["ev", "R", "run_start"], ["pre_run", "R"],
    ["ev", "R", "turn_start"],
    ["ev", "R", "compaction"], ["compaction", "R", "keep-window"],
    ["ev", "R", "run_end"], ["post_run", "R", { status: "done", summary: "ok" }],
  ]);
});
