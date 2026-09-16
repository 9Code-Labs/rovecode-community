/** lanes/progress.ts: what a running lane says it has done, folded from the REAL recorded streams of all
 *  four CLIs (test/fixtures/lanes/*.jsonl) rather than from hand-written events — a counter is only as
 *  good as the stream it was checked against, and two of these four report one call twice.
 *
 *  The three properties, each with the way it could lie named in the test title:
 *    1. a call reported twice counts ONCE (codex `item.started` + `item.completed`, opencode's part
 *       updated running → completed, claude's tool_use + tool_result);
 *    2. a file counts as written only when the CLI CONFIRMED it — so agy, which confirms nothing, reports
 *       zero files live, and a claude edit whose tool_result carries is_error is a CALL but never a FILE
 *       (`wrote` is set at the result or never, so the call event cannot promote itself);
 *    3. usage stays ABSENT when the CLI reported none, so "we could not read it" never renders as "none".
 *  Plus filesFromPatch, which is the only proof at the end. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agyAdapter } from "../../src/lanes/agy.ts";
import { claudeAdapter } from "../../src/lanes/claude.ts";
import { codexAdapter } from "../../src/lanes/codex.ts";
import { opencodeAdapter } from "../../src/lanes/opencode.ts";
import { filesFromPatch, LaneTally, MAX_TRACKED_FILES, type LaneProgress } from "../../src/lanes/progress.ts";
import { newParseState, type AgentAdapter, type LaneEvent } from "../../src/lanes/types.ts";

const fixture = (name: string): string[] =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "lanes", `${name}.jsonl`), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");

/** every event of a recorded run, in order — exactly what the runner folds */
function eventsOf(adapter: AgentAdapter, lines: string[]): LaneEvent[] {
  const st = newParseState();
  const out: LaneEvent[] = [];
  for (const l of lines) {
    try { out.push(...adapter.parse(l, st)); } catch { /* garbage, as the runner treats it */ }
  }
  return out;
}

function tallyOf(adapter: AgentAdapter, name: string): LaneProgress {
  const t = new LaneTally();
  for (const ev of eventsOf(adapter, fixture(name))) t.add(ev);
  return t.snapshot();
}

describe("folded over the recorded streams", () => {
  test("claude: 3 tool calls (not 6 — each tool_use and its tool_result share one callId), 2 files written, usage as the CLI reported it", () => {
    const p = tallyOf(claudeAdapter, "claude");
    // the fixture is Edit + Write + Bash, each with a result: six edit/bash events, three calls
    expect(p.toolCalls).toBe(3); // MUTATION TARGET: count events instead of callIds → 6
    expect(p.filesWritten).toEqual(["src/auth/session.test.ts", "src/auth/session.ts"]);
    expect(p.filesWrittenTotal).toBe(2);
    expect(p.usage).toEqual({ input: 1200, output: 450, cacheRead: 8000, cacheWrite: 300, costUsd: 0.0421 });
  });

  test("codex: 2 tool calls (item_1 reported at start AND completion is one call), 2 files written, usage summed", () => {
    const p = tallyOf(codexAdapter, "codex");
    expect(p.toolCalls).toBe(2); // MUTATION TARGET: drop callId from command_execution → 3
    expect(p.filesWritten).toEqual(["src/guard.ts", "tests/guard.test.ts"]);
    expect(p.filesWrittenTotal).toBe(2);
    expect(p.usage).toEqual({ input: 5300, output: 800, cacheRead: 2000 });
  });

  test("opencode: 3 tool calls, 2 files written, per-message usage summed", () => {
    const p = tallyOf(opencodeAdapter, "opencode");
    expect(p.toolCalls).toBe(3);
    expect(p.filesWritten).toEqual(["src/auth/index.ts", "src/auth/session.ts"]);
    expect(p.usage).toMatchObject({ input: 900, output: 210 });
  });

  test("agy: its calls are counted, but it confirms NO write, so files stay empty — the honest answer while it runs", () => {
    const p = tallyOf(agyAdapter, "agy");
    expect(p.toolCalls).toBe(2); // write_file + command, neither with an id of its own
    // agy's step_update carries no result: the write is not counted, and the patch is the only proof
    expect(p.filesWritten).toEqual([]); // MUTATION TARGET: set wrote:true in agy.ts → ["README.md"]
    expect(p.filesWrittenTotal).toBe(0);
    expect(p.usage).toEqual({ input: 700, output: 120 });
  });

  test("the real opencode capture (a live run, not synthetic) folds the same way: one write, confirmed, one call", () => {
    const p = tallyOf(opencodeAdapter, "opencode-live-run");
    expect(p.toolCalls).toBe(1);
    expect(p.filesWritten.length).toBe(1);
    expect(p.filesWritten[0]).toContain("hello.txt");
  });
});

describe("a FAILED write is a call, never a file", () => {
  /** one lane's worth of lines through the REAL adapter, as the runner would feed it */
  const fold = (adapter: AgentAdapter, lines: string[]): LaneProgress => {
    const t = new LaneTally();
    for (const ev of eventsOf(adapter, lines)) t.add(ev);
    return t.snapshot();
  };

  test("claude: a tool_result with is_error → the edit stays UNconfirmed, so the path is not in filesWritten (the call still counts)", () => {
    // the CALL carries the path and no `wrote`; the failing RESULT must not promote it. This is the
    // assertion behind the design: `wrote` is set at the result or never, so a refused, failed or
    // hallucinated edit can never reach the file list.
    const p = fold(claudeAdapter, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/nope.ts", old_string: "a", new_string: "b" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "String to replace not found in file." }] } }),
    ]);
    expect(p.toolCalls).toBe(1);      // the lane DID make the call — that is true and worth showing
    expect(p.filesWritten).toEqual([]); // MUTATION TARGET: set wrote at the tool_use → ["src/nope.ts"]
    expect(p.filesWrittenTotal).toBe(0);
  });

  test("claude: a failure AFTER a success leaves only the successful file, and both calls are counted", () => {
    const p = fold(claudeAdapter, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "src/ok.ts", content: "x" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "File created successfully" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/bad.ts", old_string: "a", new_string: "b" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "no match" }] } }),
    ]);
    expect(p.toolCalls).toBe(2);
    expect(p.filesWritten).toEqual(["src/ok.ts"]);
  });

  test("opencode: a tool part whose state is `error` never reaches the confirmation path either", () => {
    const part = (status: string, extra: Record<string, unknown>) => JSON.stringify({
      type: "message.part.updated",
      properties: { part: { id: "prt_1", callID: "call_1", type: "tool", tool: "write", state: { status, input: { filePath: "src/nope.ts", content: "x" }, ...extra } } },
    });
    const p = fold(opencodeAdapter, [part("running", {}), part("error", { error: "permission denied" })]);
    expect(p.filesWritten).toEqual([]); // the error branch is a log, not an edit — nothing to confirm
    expect(p.toolCalls).toBe(0);        // and opencode reports no COMPLETED call here at all
  });
});

describe("usage stays absent when the CLI reported none", () => {
  test("a stream CUT OFF before any usage line (a killed lane) leaves `usage` undefined — not a zeroed object", () => {
    // codex reports usage once, on turn.completed; drop that last line and the run genuinely told us
    // nothing about tokens, which is what a lane killed mid-turn looks like
    const truncated = fixture("codex").slice(0, -1);
    const t = new LaneTally();
    for (const ev of eventsOf(codexAdapter, truncated)) t.add(ev);
    const p = t.snapshot();
    expect(p.usage).toBeUndefined(); // MUTATION TARGET: default to {input:0,output:0} → a lane whose tokens
    expect(p.toolCalls).toBe(2);     // we failed to read looks identical to one that burned none
  });

  test("a CLI that reports zeros reports ZEROS — the live claude failures said 0 tokens and we say 0, which is not the same fact as silence", () => {
    // both live captures are real runs that failed at auth: claude still emits a usage object, all zeros.
    // "the CLI said none" and "the CLI said nothing" must stay distinguishable, so this is present-and-zero
    // while the truncated stream above is absent.
    for (const name of ["claude-live-auth-failed", "claude-live-bare-nokey"]) {
      const p = tallyOf(claudeAdapter, name);
      expect(p.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
      expect(p.filesWritten).toEqual([]);
      expect(p.toolCalls).toBe(0);
    }
  });

  test("a tally with nothing folded at all is zeros and no usage — what a cancelled-before-spawn lane reports", () => {
    expect(new LaneTally().snapshot()).toEqual({ toolCalls: 0, filesWritten: [], filesWrittenTotal: 0 });
  });
});

describe("the fold's rules, directly", () => {
  const t = (evs: LaneEvent[]): LaneProgress => { const x = new LaneTally(); for (const e of evs) x.add(e); return x.snapshot(); };

  test("an edit WITHOUT `wrote` is a call but not a file — the path was only mentioned in the arguments", () => {
    const p = t([{ kind: "edit", path: "a.ts", op: "edit", callId: "c1" }]);
    expect(p).toEqual({ toolCalls: 1, filesWritten: [], filesWrittenTotal: 0 });
  });

  test("the same file confirmed twice is one file; two paths under one callId are one call and two files", () => {
    expect(t([
      { kind: "edit", path: "a.ts", op: "edit", wrote: true, callId: "c1" },
      { kind: "edit", path: "a.ts", op: "edit", wrote: true, callId: "c2" },
    ])).toEqual({ toolCalls: 2, filesWritten: ["a.ts"], filesWrittenTotal: 1 });
    expect(t([
      { kind: "edit", path: "a.ts", op: "write", wrote: true, callId: "c1" },
      { kind: "edit", path: "b.ts", op: "write", wrote: true, callId: "c1" },
    ])).toEqual({ toolCalls: 1, filesWritten: ["a.ts", "b.ts"], filesWrittenTotal: 2 });
  });

  test("events with no callId each count (agy's shape); log / progress / ask / done / fail count for nothing", () => {
    expect(t([{ kind: "bash", command: "x" }, { kind: "bash", command: "y" }]).toolCalls).toBe(2);
    expect(t([
      { kind: "log", text: "tool Grep: 3 matches" }, // a log that MENTIONS a tool is not a tool call
      { kind: "progress", text: "plan 1/3" },
      { kind: "ask", text: "ok?" },
      { kind: "done", summary: "s" },
      { kind: "fail", error: "e" },
    ])).toEqual({ toolCalls: 0, filesWritten: [], filesWrittenTotal: 0 });
    // …but a `tool` event IS one: the countable form of the same thing (events.ts toolEvent default)
    expect(t([{ kind: "tool", name: "Grep", callId: "c1" }, { kind: "tool", name: "Read", callId: "c2" }]).toolCalls).toBe(2);
  });

  test(`past ${MAX_TRACKED_FILES} files the names stop growing but the total keeps counting`, () => {
    const many: LaneEvent[] = [];
    for (let i = 0; i < MAX_TRACKED_FILES + 25; i++) many.push({ kind: "edit", path: `f${String(i).padStart(4, "0")}.ts`, op: "write", wrote: true, callId: `c${i}` });
    const p = t(many);
    expect(p.filesWritten.length).toBe(MAX_TRACKED_FILES);
    expect(p.filesWrittenTotal).toBe(MAX_TRACKED_FILES + 25);
  });

  test("a snapshot is a copy: folding more events does not mutate one a surface is already holding", () => {
    const x = new LaneTally();
    x.add({ kind: "edit", path: "a.ts", op: "write", wrote: true, callId: "c1" });
    x.add({ kind: "usage", usage: { input: 1, output: 2 } });
    const first = x.snapshot();
    x.add({ kind: "edit", path: "b.ts", op: "write", wrote: true, callId: "c2" });
    x.add({ kind: "usage", usage: { input: 10, output: 20 } });
    expect(first).toEqual({ toolCalls: 1, filesWritten: ["a.ts"], filesWrittenTotal: 1, usage: { input: 1, output: 2 } });
    expect(x.snapshot()).toMatchObject({ toolCalls: 2, filesWrittenTotal: 2, usage: { input: 11, output: 22 } });
  });

  test("withFiles replaces the live list with the measured one, keeping the calls and the usage", () => {
    const x = new LaneTally();
    x.add({ kind: "edit", path: "guessed.ts", op: "write", wrote: true, callId: "c1" });
    x.add({ kind: "usage", usage: { input: 5, output: 6 } });
    expect(x.withFiles(["real-a.ts", "real-b.ts", "real-a.ts"])).toEqual({
      toolCalls: 1, filesWritten: ["real-a.ts", "real-b.ts"], filesWrittenTotal: 2, usage: { input: 5, output: 6 },
    });
  });
});

describe("filesFromPatch — the proof at the end", () => {
  test("a normal diff names every changed file once, sorted", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-x", "+y",
      "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1 +1 @@", "-p", "+q",
    ].join("\n");
    expect(filesFromPatch(patch)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a NEW file, a DELETED file and a RENAME each resolve to a real path — never /dev/null", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+hi",
      "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
      "diff --git a/old-name.ts b/new-name.ts", "similarity index 100%", "rename from old-name.ts", "rename to new-name.ts",
    ].join("\n");
    expect(filesFromPatch(patch)).toEqual(["gone.ts", "new-name.ts", "new.ts"]);
  });

  test("a quoted path (a space, or a non-ASCII byte git escapes) is unquoted; an empty patch is no files", () => {
    const patch = [
      'diff --git "a/src/my file.ts" "b/src/my file.ts"', "--- a/src/my file.ts", "+++ b/src/my file.ts",
      "diff --git a/plain.ts b/plain.ts", "--- a/plain.ts", "+++ b/plain.ts",
    ].join("\n");
    expect(filesFromPatch(patch)).toEqual(["plain.ts", "src/my file.ts"]);
    expect(filesFromPatch("")).toEqual([]);
    expect(filesFromPatch("not a patch at all\njust text\n")).toEqual([]);
  });

  test("an unreadable header is SKIPPED, not guessed at — a strange path is missing rather than poisoning the list", () => {
    const patch = ["diff --git nonsense", "diff --git a/ok.ts b/ok.ts", "+++ b/ok.ts"].join("\n");
    expect(filesFromPatch(patch)).toEqual(["ok.ts"]);
  });
});
