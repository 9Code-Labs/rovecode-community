/**
 * Tests for the tool-loop guardrails port. `:N` citations refer to upstream
 * hermes-agent `agent/tool_guardrails.py`; sequences mirror upstream tests
 * (tests/agent/test_tool_guardrails.py, tests/agent/test_stall_guards.py).
 */
import { test, expect } from "bun:test";
import {
  GUARDRAIL_DEFAULTS,
  ToolGuard,
  canonicalJson,
  type GuardVerdict,
} from "../../src/core/guardrails.ts";

/** Exactly at the dedup threshold — stubbed (>= semantics; upstream
 *  test_stall_guards.py:190 uses the same construction). */
const BIG = "x".repeat(GUARDRAIL_DEFAULTS.dedupMinChars);

/** Simulate the documented wiring: checkCall → execute (skipped when stubbed)
 *  → checkResult with the raw output. */
function runLoop(
  guard: ToolGuard,
  n: number,
  tool = "web_search",
  args: unknown = { query: "same" },
  output: string | ((i: number) => string) = BIG,
): { actions: GuardVerdict["action"][]; verdicts: GuardVerdict[]; deduped: boolean[] } {
  const verdicts: GuardVerdict[] = [];
  const deduped: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const v = guard.checkCall(tool, args);
    verdicts.push(v);
    if (v.action !== "stub") {
      const out = typeof output === "function" ? output(i) : output;
      deduped.push(guard.checkResult(tool, args, out).deduped);
    }
  }
  return { actions: verdicts.map((v) => v.action), verdicts, deduped };
}

// ── behavior 1: escalation allow → warn → stub, upstream order/thresholds ──

test("loop-guard scenario: 12 identical calls give the exact allow/warn/stub sequence", () => {
  const g = new ToolGuard();
  const { actions, deduped } = runLoop(g, 12);
  expect(actions).toEqual([
    "allow", "allow",                                            // tolerated (warn_after=2, :119/:123)
    "warn", "warn", "warn",                                      // first warn = 3rd consecutive call (:85)
    "stub", "stub", "stub", "stub", "stub", "stub", "stub",      // blocked from the 6th (block_after=5, :120/:124)
  ]);
  // dedup starts on the 2nd identical result (:611) — before the first warn —
  // and only the 5 executed calls ever produced results
  expect(deduped).toEqual([false, true, true, true, true]);
});

test("warn notes carry the ordinal; stub notes tell the model to change approach", () => {
  const g = new ToolGuard();
  const { verdicts } = runLoop(g, 6, "read_file", { path: "/a" });
  expect(verdicts[0]!.action).toBe("allow");
  expect(verdicts[0]!.note).toBeUndefined();
  expect(verdicts[2]!.action).toBe("warn");
  expect(verdicts[2]!.note).toContain("3rd consecutive call");
  expect(verdicts[2]!.note).toContain("read_file");
  expect(verdicts[3]!.note).toContain("4th"); // notice fires on every subsequent call (:598)
  expect(verdicts[5]!.action).toBe("stub");
  expect(verdicts[5]!.note).toContain("blocked read_file");
  expect(verdicts[5]!.note!.toLowerCase()).toContain("stop repeating");
  expect(verdicts[5]!.note!.toLowerCase()).toContain("change arguments or strategy");
});

test("streak survives stubbed calls: verdict stays stub, never resets back to allow", () => {
  const g = new ToolGuard();
  const { actions } = runLoop(g, 20, "t", { a: 1 });
  expect(actions.slice(5).every((a) => a === "stub")).toBe(true);
});

// ── behavior 2: signature = tool + canonical JSON args ──────────────────────

test("signature is key-order independent: reordered nested unicode args continue the streak", () => {
  // canonicalization parity with upstream test_tool_guardrails.py:14-33
  const a = { z: [{ "β": "☤", a: 1 }], a: { y: 2, x: "secret" } };
  const b = { a: { x: "secret", y: 2 }, z: [{ a: 1, "β": "☤" }] };
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(canonicalJson(a)).toBe('{"a":{"x":"secret","y":2},"z":[{"a":1,"β":"☤"}]}'); // sorted, compact, unicode raw (:285-295)
  const g = new ToolGuard();
  expect(g.checkCall("t", a).action).toBe("allow");
  expect(g.checkCall("t", b).action).toBe("allow");
  expect(g.checkCall("t", a).action).toBe("warn"); // 3rd of the same streak
});

test("different args or a different tool never form a loop", () => {
  const g = new ToolGuard();
  for (let i = 0; i < 12; i++) {
    expect(g.checkCall("web_search", { query: `q${i}` }).action).toBe("allow");
  }
  g.reset();
  for (let i = 0; i < 12; i++) {
    expect(g.checkCall(`tool_${i}`, { q: "same" }).action).toBe("allow");
  }
});

test("an intervening different call resets the streak (:344-351; upstream test_stall_guards.py:80-81)", () => {
  const g = new ToolGuard();
  const args = { path: "/a" };
  g.checkCall("read_file", args);
  g.checkResult("read_file", args, BIG);
  g.checkCall("read_file", args);
  g.checkResult("read_file", args, BIG);
  g.checkCall("write_file", { path: "/b", content: "y" });
  g.checkResult("write_file", { path: "/b", content: "y" }, "ok");
  // fresh streak: back to allow, and the duplicate result is NOT stubbed
  expect(g.checkCall("read_file", args).action).toBe("allow");
  expect(g.checkResult("read_file", args, BIG).deduped).toBe(false); // consecutive-only dedup (:570-571)
});

test("non-mapping args coerce to {} and share one signature (_coerce_args :770-771)", () => {
  const g = new ToolGuard();
  expect(g.checkCall("t", "raw-string").action).toBe("allow");
  expect(g.checkCall("t", 42).action).toBe("allow");
  expect(g.checkCall("t", [1, 2, 3]).action).toBe("warn"); // all coerced to {} → 3rd identical
});

// ── behavior 3: byte-identical duplicate result → reference stub ────────────

test("byte-identical duplicate result is replaced by a reference stub; first passes full", () => {
  const g = new ToolGuard();
  const args = { query: "hermes result stubbing", limit: 5 };
  g.checkCall("web_search", args);
  const r1 = g.checkResult("web_search", args, BIG);
  expect(r1).toEqual({ output: BIG, deduped: false });
  g.checkCall("web_search", args);
  const r2 = g.checkResult("web_search", args, BIG);
  expect(r2.deduped).toBe(true);
  expect(r2.output.length).toBeLessThan(BIG.length); // token saver
  expect(r2.output).toContain("byte-identical");
  expect(r2.output).toContain("web_search");
  expect(r2.output).toContain("call #1"); // pointer to the first occurrence
  expect(r2.output).toContain(`${BIG.length} chars`); // original length noted
  expect(r2.output).toContain("hermes result stubbing"); // args preview (:96-98; upstream test :282-289)
});

test("changing results pass through whole and keep the guard quiet (progress resets, :585-591)", () => {
  const g = new ToolGuard();
  const args = { id: "job1" };
  for (let i = 0; i < 10; i++) {
    expect(g.checkCall("poll_status", args).action).toBe("allow");
    const out = `state-${i}-` + "p".repeat(600);
    const r = g.checkResult("poll_status", args, out);
    expect(r).toEqual({ output: out, deduped: false });
  }
});

test("results below dedupMinChars are never stubbed; exactly-at-threshold is (:93, :613)", () => {
  const short = "y".repeat(GUARDRAIL_DEFAULTS.dedupMinChars - 1);
  const g = new ToolGuard();
  g.checkCall("t", {});
  g.checkResult("t", {}, short);
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, short).deduped).toBe(false);

  const g2 = new ToolGuard();
  g2.checkCall("t", {});
  g2.checkResult("t", {}, BIG); // BIG.length === dedupMinChars
  g2.checkCall("t", {});
  expect(g2.checkResult("t", {}, BIG).deduped).toBe(true);
});

test("error-looking results are never stubbed (:91-92, :612; classifier :326-328)", () => {
  const err = "Error: " + "e".repeat(600);
  const g = new ToolGuard();
  g.checkCall("t", {});
  g.checkResult("t", {}, err);
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, err)).toEqual({ output: err, deduped: false });

  const jsonErr = JSON.stringify({ error: "boom", detail: "z".repeat(600) });
  const g2 = new ToolGuard();
  g2.checkCall("t", {});
  g2.checkResult("t", {}, jsonErr);
  g2.checkCall("t", {});
  expect(g2.checkResult("t", {}, jsonErr).deduped).toBe(false);
});

test("ok:false results are never stubbed even when the text dodges the string sniff (MED-3)", () => {
  // rovecode failure shapes that do NOT start with "Error" and contain no
  // '"error"'/'"failed"' in the head — the sniff alone would let these stub
  const failure = "Permission denied by user. " + "d".repeat(600);
  const g = new ToolGuard();
  expect(looksLikeSniffMiss(failure)).toBe(true); // guard the fixture: it must dodge the sniff
  g.checkCall("t", {});
  g.checkResult("t", {}, failure, false);
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, failure, false).deduped).toBe(false); // errors stay verbatim
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, failure, false).deduped).toBe(false); // …every time
  // same payload with ok:true dedups — proving ok, not the text, decides
  const g2 = new ToolGuard();
  g2.checkCall("t", {});
  g2.checkResult("t", {}, failure, true);
  g2.checkCall("t", {});
  expect(g2.checkResult("t", {}, failure, true).deduped).toBe(true);
});

/** True when the sniff heuristic alone would NOT classify this as failed. */
function looksLikeSniffMiss(output: string): boolean {
  const head = output.slice(0, 500).toLowerCase();
  return !output.startsWith("Error") && !head.includes('"error"') && !head.includes('"failed"');
}

test("omitted ok flag falls back to the string sniff (:326-328)", () => {
  const err = "Error: " + "e".repeat(600);
  const g = new ToolGuard();
  g.checkCall("t", {});
  g.checkResult("t", {}, err); // no ok given
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, err).deduped).toBe(false);
});

test("mcp_call unwraps the inner tool name for the poller exemption (LOW-6)", () => {
  const g = new ToolGuard();
  // MCP poller via indirection: exempt from warn/stub, like a direct *_poll
  for (let i = 0; i < 8; i++) {
    expect(g.checkCall("mcp_call", { server: "jobs", tool: "render_poll", args: { id: 1 } }).action).toBe("allow");
  }
  const g2 = new ToolGuard();
  for (let i = 0; i < 8; i++) {
    expect(g2.checkCall("mcp_call", { server: "fal", tool: "fal_get_result", args: {} }).action).toBe("allow");
  }
  // non-poller inner tools still escalate — the unwrap is exemption-only
  const g3 = new ToolGuard();
  const seq: string[] = [];
  for (let i = 0; i < 6; i++) seq.push(g3.checkCall("mcp_call", { server: "s", tool: "search", args: { q: "same" } }).action);
  expect(seq).toEqual(["allow", "allow", "warn", "warn", "warn", "stub"]);
  // distinct inner tools never share a streak (signature hashes full args)
  const g4 = new ToolGuard();
  for (let i = 0; i < 8; i++) {
    expect(g4.checkCall("mcp_call", { server: "s", tool: `t${i}`, args: {} }).action).toBe("allow");
  }
});

test("JSON results are canonically compared: reordered keys still dedup (_result_hash :774-789)", () => {
  const pad = "p".repeat(600);
  const o1 = JSON.stringify({ a: 1, b: pad });
  const o2 = JSON.stringify({ b: pad, a: 1 });
  const g = new ToolGuard();
  g.checkCall("t", {});
  g.checkResult("t", {}, o1);
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, o2).deduped).toBe(true);
});

test("after a changed result the stub references the new first occurrence (upstream test :215-225)", () => {
  const g = new ToolGuard();
  const args = { q: 1 };
  g.checkCall("t", args);
  g.checkResult("t", args, "a".repeat(600)); // call #1
  g.checkCall("t", args);
  g.checkResult("t", args, "b".repeat(600)); // call #2 — changed → new streak starts here
  g.checkCall("t", args);
  const r = g.checkResult("t", args, "b".repeat(600)); // call #3 — duplicate of #2
  expect(r.deduped).toBe(true);
  expect(r.output).toContain("call #2");
});

test("pollers never get warn/stub verdicts but their duplicate results still dedup (:63-80, :562-567)", () => {
  const g = new ToolGuard();
  const args = { action: "poll", id: 7 };
  for (let i = 0; i < 8; i++) {
    expect(g.checkCall("process", args).action).toBe("allow"); // allowlist (:68-72)
    expect(g.checkResult("process", args, BIG).deduped).toBe(i >= 1);
  }
  const g2 = new ToolGuard();
  for (let i = 0; i < 8; i++) {
    expect(g2.checkCall("fal_get_result", { id: "x" }).action).toBe("allow"); // suffix (:77-80)
  }
});

test("dedup stub args preview is truncated to argsPreviewChars plus ellipsis (:98, :642-643)", () => {
  const g = new ToolGuard();
  const args = { q: "长".repeat(300) };
  g.checkCall("t", args);
  g.checkResult("t", args, BIG);
  g.checkCall("t", args);
  const r = g.checkResult("t", args, BIG);
  expect(r.deduped).toBe(true);
  const m = r.output.match(/Args: (.*)\]$/);
  expect(m?.[1]?.length).toBe(GUARDRAIL_DEFAULTS.argsPreviewChars + 1); // 120 + "…"
  expect(m?.[1]?.endsWith("…")).toBe(true);
});

test("lone-surrogate hashing is lossless (surrogatepass analog, :849-855): distinct surrogates never collide", () => {
  // Discriminating probe: utf-8 encoding collapses EVERY unpaired surrogate to
  // U+FFFD, so "\uD800"+pad and "\uDC00"+pad would hash identically and the
  // CHANGED result below would falsely dedup. utf16le keeps them distinct.
  const g = new ToolGuard();
  const highSurrogate = "\uD800" + "w".repeat(600);
  const lowSurrogate = "\uDC00" + "w".repeat(600); // same length, different lone surrogate
  g.checkCall("t", {});
  g.checkResult("t", {}, highSurrogate);
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, lowSurrogate).deduped).toBe(false); // changed content ⇒ no dedup
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, lowSurrogate).deduped).toBe(true); // identical content still dedups
});

// ── behavior 4: thresholds configurable, defaults = upstream's ──────────────

test("defaults mirror upstream", () => {
  expect(GUARDRAIL_DEFAULTS.warnAfterRepeats).toBe(2);   // :119/:123
  expect(GUARDRAIL_DEFAULTS.stubAfterRepeats).toBe(5);   // :120/:124
  expect(GUARDRAIL_DEFAULTS.dedupMinChars).toBe(512);    // :93
  expect(GUARDRAIL_DEFAULTS.argsPreviewChars).toBe(120); // :98
  expect(GUARDRAIL_DEFAULTS.warningsEnabled).toBe(true); // :117
  expect(GUARDRAIL_DEFAULTS.repeatableTools).toEqual(["process"]);              // :68-72
  expect(GUARDRAIL_DEFAULTS.repeatableSuffixes).toEqual(["_get_result", "_poll"]); // :77-80
});

test("custom thresholds shift the escalation boundaries", () => {
  const g = new ToolGuard({ warnAfterRepeats: 1, stubAfterRepeats: 2 });
  expect(runLoop(g, 5, "t", { a: 1 }).actions).toEqual(["allow", "warn", "stub", "stub", "stub"]);
});

test("junk threshold values fall back to defaults (_positive_int :808-815)", () => {
  const g = new ToolGuard({ warnAfterRepeats: 0, stubAfterRepeats: -3 });
  expect(runLoop(g, 6, "t", { a: 1 }).actions).toEqual(["allow", "allow", "warn", "warn", "warn", "stub"]);
  const g2 = new ToolGuard({ warnAfterRepeats: Number.NaN });
  expect(runLoop(g2, 3, "t", { a: 1 }).actions[2]).toBe("warn");
});

test("warningsEnabled:false suppresses warns but not stubs (warn gates :466/:480/:506; blocks :391-427)", () => {
  const g = new ToolGuard({ warningsEnabled: false });
  expect(runLoop(g, 7, "t", { a: 1 }).actions).toEqual([
    "allow", "allow", "allow", "allow", "allow", "stub", "stub",
  ]);
});

test("hardStop:false gives upstream's warn-only default behavior (:118)", () => {
  const g = new ToolGuard({ hardStop: false });
  expect(runLoop(g, 8, "t", { a: 1 }).actions).toEqual([
    "allow", "allow", "warn", "warn", "warn", "warn", "warn", "warn",
  ]);
});

test("custom dedupMinChars is honored", () => {
  const g = new ToolGuard({ dedupMinChars: 4 });
  g.checkCall("t", {});
  g.checkResult("t", {}, "tiny-result");
  g.checkCall("t", {});
  expect(g.checkResult("t", {}, "tiny-result").deduped).toBe(true);
});

// ── behavior 5: bounded memory + per-turn reset ─────────────────────────────

test("memory stays O(1): 10k distinct signatures never accumulate (single streak, :353-359)", () => {
  const g = new ToolGuard();
  // build a streak of 2 on sig-0, then bury it under 10k distinct calls
  g.checkCall("t", { i: 0 });
  g.checkCall("t", { i: 0 });
  for (let i = 1; i < 10_000; i++) {
    g.checkCall("t", { i });
    g.checkResult("t", { i }, `out-${i}`);
  }
  expect(g.trackedSignatures).toBe(1); // exactly the current streak — a per-sig map would hold 10k
  // discriminating probe: an accumulating per-signature counter would resume
  // sig-0 at count 3 ⇒ warn; the single-streak design starts fresh ⇒ allow
  expect(g.checkCall("t", { i: 0 }).action).toBe("allow");
});

test("onTurn() resets escalation and dedup baselines (reset_for_turn :338, :340-369)", () => {
  const g = new ToolGuard();
  const args = { q: 1 };
  g.checkCall("t", args);
  g.checkResult("t", args, BIG);
  g.checkCall("t", args);
  expect(g.checkResult("t", args, BIG).deduped).toBe(true);
  expect(g.checkCall("t", args).action).toBe("warn"); // 3rd
  g.checkResult("t", args, BIG);
  g.onTurn();
  expect(g.checkCall("t", args).action).toBe("allow");        // streak cleared
  expect(g.checkResult("t", args, BIG).deduped).toBe(false);  // baseline cleared
  expect(g.trackedSignatures).toBe(1);
});

test("reset() clears everything and call ordinals restart at #1", () => {
  const g = new ToolGuard();
  runLoop(g, 4, "t", { a: 1 });
  g.reset();
  expect(g.trackedSignatures).toBe(0);
  g.checkCall("t", { b: 2 });
  g.checkResult("t", { b: 2 }, BIG);
  g.checkCall("t", { b: 2 });
  const r = g.checkResult("t", { b: 2 }, BIG);
  expect(r.deduped).toBe(true);
  expect(r.output).toContain("call #1"); // ordinal counter restarted
});
