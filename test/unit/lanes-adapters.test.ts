/** PORT #47 — the four lane adapters (src/lanes/{claude,codex,opencode,agy}.ts) + registry, WITHOUT any
 *  process: docs/test.md §3.1 dry-run (command() argv exact per the user's verified flags, incl. resume
 *  forms and agy's dangerous flag OFF by default) and §3.2 replay (parse() over the SYNTHETIC fixtures in
 *  test/fixtures/lanes/*.jsonl → the expected LaneEvent sequence per the docs/agentic-clis.md §3 table,
 *  garbage lines skipped and counted, never thrown). Each block names its mutation target. */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, CLAUDE_DEFAULT_ALLOW } from "../../src/lanes/claude.ts";
import { codexAdapter } from "../../src/lanes/codex.ts";
import { opencodeAdapter } from "../../src/lanes/opencode.ts";
import { agyAdapter, AGY_SOFT_DENY_NOTE, printTimeout } from "../../src/lanes/agy.ts";
import { ADAPTERS, CLAUDE_OAUTH_TOKEN_ENV, DEFAULT_LANE_TIMEOUT_MS, LANE_CLAUDE_BARE_ENV, laneApprovalText, laneModelEnv, laneOptsFor, lanePermissions, laneBinary, laneRefusal, laneStartNote, laneTimeoutFromEnv, lanesAllowed, onPath, resetPathProbe } from "../../src/lanes/registry.ts";
import { KEPT_ENV_EXACT } from "../../src/lanes/process.ts";
import { addUsage, renderEvent, usageFrom } from "../../src/lanes/events.ts";
import { ADAPTER_IDS, isAdapterId, newParseState, type AgentAdapter, type LaneEvent, type LaneOpts } from "../../src/lanes/types.ts";
import { fixtureLines } from "../helpers/fake-lane.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "lanes");
const fixture = (id: string): string[] => fixtureLines(readFileSync(join(FIX, `${id}.jsonl`), "utf8"));
const CWD = "D:/work/lane-1";
const opts = (over: Partial<LaneOpts> = {}): LaneOpts => ({ cwd: CWD, timeoutMs: DEFAULT_LANE_TIMEOUT_MS, ...over });
const GOAL = "implement sessions in src/auth/session.ts; keep the public API";

function parseAll(adapter: AgentAdapter, lines: string[]): { events: LaneEvent[]; garbage: number; sessionId?: string } {
  const st = newParseState();
  const events: LaneEvent[] = [];
  for (const l of lines) events.push(...adapter.parse(l, st));
  return { events, garbage: st.garbage, ...(st.sessionId ? { sessionId: st.sessionId } : {}) };
}

// ---------- §3.1 dry run: argv exact ----------

test("claude: `claude --bare -p <goal> --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools <list>`; resume adds --resume <id>; an empty allowlist drops the flag", () => {
  const c = claudeAdapter.command({ goal: GOAL }, opts());
  expect(c.bin).toBe("claude");
  expect(c.cwd).toBe(CWD);
  // mutation target: any flag renamed/reordered/dropped in claude.ts argv()
  expect(c.args).toEqual(["--bare", "-p", GOAL, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write"]);
  expect(CLAUDE_DEFAULT_ALLOW).toEqual(["Read", "Edit", "Write"]);
  const custom = claudeAdapter.command({ goal: GOAL }, opts({ allowlist: ["Read", "Edit", "Write", "Bash(npm run typecheck)"], model: "claude-opus-4-1" }));
  expect(custom.args.slice(8)).toEqual(["--allowedTools", "Read,Edit,Write,Bash(npm run typecheck)", "--model", "claude-opus-4-1"]);
  expect(claudeAdapter.command({ goal: GOAL }, opts({ allowlist: [] })).args).not.toContain("--allowedTools");
  const r = claudeAdapter.resume!("sess-9", "now add tests", opts());
  expect(r.args).toEqual(["--bare", "-p", "now add tests", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write", "--resume", "sess-9"]);
  expect(claudeAdapter.command({ goal: "again" }, opts({ resume: "sess-9" })).args.slice(-2)).toEqual(["--resume", "sess-9"]);
  expect(claudeAdapter.interruptFirst).toBe(true); // SIGINT finishes the turn (agentic-clis.md §2)
  expect(claudeAdapter.permissionSummary(opts())).toBe("permission-mode acceptEdits · allow: Read,Edit,Write · bare · worktree");
  expect(claudeAdapter.permissionSummary(opts({ allowlist: [] }))).toBe("permission-mode acceptEdits · allow: none · bare · worktree");
  // live finding 2026-09-03: `--bare` authenticates with ANTHROPIC_API_KEY ALONE (the CLI's login is never
  // read) — bare:false drops the flag (only the flag; everything else identical) and the card says so
  const login = claudeAdapter.command({ goal: GOAL }, opts({ bare: false }));
  expect(login.args).toEqual(["-p", GOAL, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write"]); // mutation target: bare:false still emitting --bare
  expect(claudeAdapter.command({ goal: GOAL }, opts({ bare: true })).args[0]).toBe("--bare");
  expect(claudeAdapter.resume!("sess-9", "again", opts({ bare: false })).args).toEqual(["-p", "again", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write", "--resume", "sess-9"]);
  expect(claudeAdapter.permissionSummary(opts({ bare: false }))).toBe("permission-mode acceptEdits · allow: Read,Edit,Write · cli login · worktree");
});

test("codex: `codex -a never exec --json --sandbox workspace-write -C <dir> -o <lastfile> [--skip-git-repo-check] <goal>`; `-a never` BEFORE exec; resume = `exec resume <id>`; read-only sandbox honored", () => {
  const c = codexAdapter.command({ goal: GOAL }, opts({ lastMessageFile: "D:/tmp/last.md" }));
  expect(c.bin).toBe("codex");
  // mutation target: the -a/exec order, the --json/--sandbox/-C/-o flags, the goal position (last)
  expect(c.args).toEqual(["-a", "never", "exec", "--json", "--sandbox", "workspace-write", "-C", CWD, "-o", "D:/tmp/last.md", "--skip-git-repo-check", GOAL]);
  expect(c.args).not.toContain("--ephemeral"); // kept resumable (no --ephemeral)
  const dflt = codexAdapter.command({ goal: GOAL }, opts());
  const o = dflt.args.indexOf("-o");
  expect(dflt.args[o + 1]!.startsWith(tmpdir())).toBe(true); // the last-message file lives OUTSIDE the worktree (never in its diff)
  expect(dflt.args[o + 1]!).toMatch(/rovecode-codex-last-[0-9a-f]+\.md$/);
  expect(codexAdapter.command({ goal: GOAL }, opts({ sandbox: "read-only", model: "o4-mini" })).args.slice(3, 6)).toEqual(["--json", "--sandbox", "read-only"]);
  expect(codexAdapter.command({ goal: GOAL }, opts({ model: "o4-mini" })).args.slice(-3)).toEqual(["-m", "o4-mini", GOAL]);
  const r = codexAdapter.resume!("thr-1", "rebase onto main and resolve", opts({ lastMessageFile: "D:/tmp/last.md" }));
  expect(r.args).toEqual(["-a", "never", "exec", "resume", "thr-1", "--json", "--sandbox", "workspace-write", "-C", CWD, "-o", "D:/tmp/last.md", "--skip-git-repo-check", "rebase onto main and resolve"]);
  expect(codexAdapter.interruptFirst).toBe(false);
  expect(codexAdapter.permissionSummary(opts())).toBe("sandbox workspace-write · approval never · worktree");
  expect(codexAdapter.permissionSummary(opts({ sandbox: "read-only" }))).toBe("sandbox read-only · approval never · worktree");
});

test("opencode: `opencode run <goal> --format json --dir <dir>`; resume adds `-s <session>`; --attach <url> / -m <model> when given", () => {
  const c = opencodeAdapter.command({ goal: GOAL }, opts());
  expect(c.bin).toBe("opencode");
  expect(c.args).toEqual(["run", GOAL, "--format", "json", "--dir", CWD]); // mutation target: opencode.ts argv()
  expect(opencodeAdapter.resume!("ses_1", "fix the failing test", opts()).args).toEqual(["run", "fix the failing test", "--format", "json", "--dir", CWD, "-s", "ses_1"]);
  expect(opencodeAdapter.command({ goal: GOAL }, opts({ attach: "http://127.0.0.1:4096", model: "anthropic/claude-sonnet-4-5" })).args.slice(6))
    .toEqual(["--attach", "http://127.0.0.1:4096", "-m", "anthropic/claude-sonnet-4-5"]);
  expect(opencodeAdapter.interruptFirst).toBe(true);
  expect(opencodeAdapter.permissionSummary(opts())).toBe("permissions per opencode config (asks surface as lane events) · worktree");
  expect(opencodeAdapter.permissionSummary(opts({ attach: "http://127.0.0.1:4096" }))).toContain("attach http://127.0.0.1:4096");
});

test("agy: `agy -p <goal> --output-format stream-json --print-timeout 15m`; --dangerously-skip-permissions ONLY on an explicit allow-all; resume = --conversation <id>", () => {
  const c = agyAdapter.command({ goal: GOAL }, opts());
  expect(c.bin).toBe("agy");
  expect(c.args).toEqual(["-p", GOAL, "--output-format", "stream-json", "--print-timeout", "15m"]); // mutation target: agy.ts argv()
  expect(c.args).not.toContain("--dangerously-skip-permissions"); // mutation target: `opts.allowAll === true` → default-on
  expect(agyAdapter.command({ goal: GOAL }, opts({ allowAll: true })).args).toEqual(["-p", GOAL, "--output-format", "stream-json", "--print-timeout", "15m", "--dangerously-skip-permissions"]);
  expect(agyAdapter.command({ goal: GOAL }, opts({ allowAll: false })).args).not.toContain("--dangerously-skip-permissions");
  expect(agyAdapter.command({ goal: GOAL }, opts({ model: "gemini-3.5-flash-medium" })).args.slice(-2)).toEqual(["--model", "gemini-3.5-flash-medium"]);
  expect(agyAdapter.resume!("conv-7", "continue", opts()).args).toEqual(["-p", "continue", "--output-format", "stream-json", "--print-timeout", "15m", "--conversation", "conv-7"]);
  // the print timeout mirrors the lane budget, rounded UP to whole minutes (the CLI never cuts first)
  expect(printTimeout(DEFAULT_LANE_TIMEOUT_MS)).toBe("15m");
  expect(printTimeout(61_000)).toBe("2m");
  expect(printTimeout(500)).toBe("1m");
  expect(agyAdapter.command({ goal: GOAL }, opts({ timeoutMs: 20 * 60_000 })).args.slice(4)).toEqual(["--print-timeout", "20m"]);
  expect(agyAdapter.interruptFirst).toBe(false);
  expect(agyAdapter.emptyDiffNote).toBe(AGY_SOFT_DENY_NOTE);
  expect(agyAdapter.permissionSummary(opts())).toBe("soft-deny (tools needing approval are refused, exit 0 — diff is cross-checked) · worktree");
  expect(agyAdapter.permissionSummary(opts({ allowAll: true }))).toBe("--dangerously-skip-permissions (every tool auto-approved) · worktree");
});

// ---------- §3.2 replay: parse() over the synthetic fixtures ----------

test("claude fixture → init log, text logs, Edit/Write → edit at the CALL then edit wrote:true at the RESULT (same callId, so one call and one file), Bash → bash, usage + done with session id; 2 garbage lines counted", () => {
  const { events, garbage, sessionId } = parseAll(claudeAdapter, fixture("claude"));
  expect(events).toEqual([
    { kind: "log", text: "init · model claude-sonnet-4-5 · 4 tools · session sess-claude-1" },
    { kind: "log", text: "I will add the session helper." },
    // the CALL: no `wrote` — claude has confirmed nothing yet
    { kind: "edit", path: "src/auth/session.ts", op: "edit", callId: "toolu_1" },
    // the RESULT (no is_error): the write is confirmed, under the SAME callId — progress.ts therefore
    // counts one tool call and one file, not two of either
    { kind: "edit", path: "src/auth/session.ts", op: "edit", wrote: true, callId: "toolu_1" },
    { kind: "edit", path: "src/auth/session.test.ts", op: "write", callId: "toolu_2" },
    { kind: "edit", path: "src/auth/session.test.ts", op: "write", wrote: true, callId: "toolu_2" },
    { kind: "bash", command: "npm run typecheck", callId: "toolu_3" },
    { kind: "log", text: "Bash result: ok" }, // a bash result stays a log: its output is the interesting part
    { kind: "log", text: "Done: sessions implemented, typecheck green." },
    { kind: "usage", usage: { input: 1200, output: 450, cacheRead: 8000, cacheWrite: 300, costUsd: 0.0421 } },
    { kind: "done", summary: "Done: sessions implemented, typecheck green.", sessionId: "sess-claude-1" },
  ]);
  expect(garbage).toBe(2); // the fixture header + "this line is not json" (mutation target: the garbage++ branch)
  expect(sessionId).toBe("sess-claude-1");
  // is_error → fail with the result text; a system/api_retry is a log, not garbage
  const st = newParseState();
  expect(claudeAdapter.parse('{"type":"system","subtype":"api_retry","attempt":2}', st)).toEqual([{ kind: "log", text: "system api_retry" }]);
  expect(claudeAdapter.parse('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"hit the turn cap","session_id":"s2"}', st))
    .toEqual([{ kind: "fail", error: "hit the turn cap", sessionId: "s2" }]);
  expect(claudeAdapter.parse('{"type":"result","subtype":"error_during_execution","is_error":true}', st)).toEqual([{ kind: "fail", error: "result error_during_execution", sessionId: "s2" }]);
  expect(st.garbage).toBe(0);
});

test("REAL claude captures (2.1.257, 2026-09-03): hooks → `hook <name> started/success`, init keeps the session id, the synthetic api-error assistant line → `api error: …` (never lastText), result is_error:true wins over subtype \"success\" → fail with the CLI's message, usage all-zero + $0", () => {
  const login = parseAll(claudeAdapter, fixture("claude-live-auth-failed"));
  expect(login.garbage).toBe(1); // the header only: every real line is a typed event
  expect(login.sessionId).toBe("f2604ab7-5bd7-4cfe-be50-fa24d6830e82"); // from system/init AND every later line
  expect(login.events.slice(0, 4)).toEqual([
    { kind: "log", text: "hook SessionStart:startup started" },
    { kind: "log", text: "hook SessionStart:startup started" },
    { kind: "log", text: "hook SessionStart:startup success" },
    { kind: "log", text: "hook SessionStart:startup success" },
  ]);
  expect(login.events[4]).toEqual({ kind: "log", text: "init · model claude-sonnet-4-5-20250929 · 29 tools · session f2604ab7-5bd7-4cfe-be50-fa24d6830e82" });
  expect(login.events.slice(5)).toEqual([
    { kind: "log", text: "api error: Failed to authenticate: OAuth session expired and could not be refreshed (authentication_failed)" }, // mutation target: the is_api_error_message branch → a plain log that becomes lastText
    { kind: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } },
    { kind: "fail", error: "Failed to authenticate: OAuth session expired and could not be refreshed", sessionId: "f2604ab7-5bd7-4cfe-be50-fa24d6830e82" },
  ]);
  const bare = parseAll(claudeAdapter, fixture("claude-live-bare-nokey"));
  expect(bare.events.map((e) => e.kind)).toEqual(["log", "log", "usage", "fail"]); // --bare: no hooks at all
  expect(bare.events[0]).toEqual({ kind: "log", text: "init · model claude-sonnet-4-5-20250929 · 3 tools · session bf3a8c1c-b44f-4825-8b85-cf7fc7a71119" });
  expect(bare.events[1]).toEqual({ kind: "log", text: "api error: Not logged in · Please run /login (authentication_failed)" });
  expect(bare.events[3]).toEqual({ kind: "fail", error: "Not logged in · Please run /login", sessionId: "bf3a8c1c-b44f-4825-8b85-cf7fc7a71119" });
  // the real result line says subtype "success" while is_error is true: is_error decides (mutation target: reading subtype)
  const st = newParseState();
  expect(claudeAdapter.parse('{"type":"result","subtype":"success","is_error":true,"result":"x","terminal_reason":"api_error","session_id":"s"}', st)).toEqual([{ kind: "fail", error: "x", sessionId: "s" }]);
  expect(claudeAdapter.parse('{"type":"assistant","message":{"content":[{"type":"text","text":"boom"}]},"error":"rate_limited","is_api_error_message":true}', st)).toEqual([{ kind: "log", text: "api error: boom (rate_limited)" }]);
  expect(st.lastText).toBeUndefined();
});

test("codex fixture → thread log, reasoning log, command started/completed → bash, plan → progress, file changes → edit, agent message → log, turn.completed → usage + done; turn.failed/error → fail", () => {
  const { events, garbage, sessionId } = parseAll(codexAdapter, fixture("codex"));
  expect(events).toEqual([
    { kind: "log", text: "thread thr-codex-1" },
    { kind: "log", text: "thinking: Look at the guard first." },
    { kind: "bash", command: "bash -lc 'ls tests'", callId: "item_1" },
    // the same item_1 again at completion — ONE call as far as progress.ts is concerned
    { kind: "bash", command: "bash -lc 'ls tests'", exitCode: 0, output: "guard.test.ts", callId: "item_1" },
    { kind: "progress", text: "plan 1/2 · write vitest cases" },
    // codex reports a file_change only once it HAS happened, so both paths are confirmed writes,
    // and both carry the same item id — one call, two files
    { kind: "edit", path: "tests/guard.test.ts", op: "write", wrote: true, callId: "item_3" },
    { kind: "edit", path: "src/guard.ts", op: "edit", wrote: true, callId: "item_3" },
    { kind: "log", text: "Added 4 vitest cases for requireAuth." },
    { kind: "usage", usage: { input: 5300, output: 800, cacheRead: 2000 } },
    { kind: "done", summary: "Added 4 vitest cases for requireAuth.", sessionId: "thr-codex-1" },
  ]);
  expect(garbage).toBe(1);
  expect(sessionId).toBe("thr-codex-1");
  const st = newParseState();
  expect(codexAdapter.parse('{"type":"turn.failed","error":{"message":"sandbox denied write"}}', st)).toEqual([{ kind: "fail", error: "sandbox denied write" }]);
  expect(codexAdapter.parse('{"type":"error","message":"rate limited"}', st)).toEqual([{ kind: "fail", error: "rate limited" }]);
  // a turn.completed with no agent message still ends the lane (empty summary → the runner falls back)
  expect(codexAdapter.parse('{"type":"turn.completed"}', st)).toEqual([{ kind: "done", summary: "" }]);
  expect(codexAdapter.parse('{"type":"item.completed","item":{"id":"i","type":"todo_list","items":[{"text":"a","completed":true}]}}', st)).toEqual([{ kind: "progress", text: "plan 1/1 · complete" }]);
});

test("opencode SDK-stream shape (synthetic; the `run --format json` CLI shape is the REAL fixture below) → finished text parts → log (growing part emitted once), completed tools → bash/edit, permission → ask, message tokens → usage, session.idle → done; session.error → fail", () => {
  const { events, garbage, sessionId } = parseAll(opencodeAdapter, fixture("opencode"));
  expect(events).toEqual([
    { kind: "log", text: "Reading the auth module" },
    // one tool part updated twice (running → completed) under callID call_1: ONE call
    { kind: "bash", command: "npm test", output: "18 passed", exitCode: 0, callId: "call_1" },
    // codex reports a file_change only once it happened, so both are confirmed writes
    { kind: "edit", path: "src/auth/session.ts", op: "edit", wrote: true, callId: "call_2" },
    { kind: "edit", path: "src/auth/index.ts", op: "write", wrote: true, callId: "call_3" },
    { kind: "ask", text: "Run git push?" },
    { kind: "log", text: "Sessions wired; tests green." },
    { kind: "usage", usage: { input: 900, output: 210, cacheRead: 100, cacheWrite: 0, costUsd: 0.0031 } },
    { kind: "done", summary: "Sessions wired; tests green.", sessionId: "ses_oc_1" },
  ]);
  expect(garbage).toBe(1);
  expect(sessionId).toBe("ses_oc_1");
  const st = newParseState();
  expect(opencodeAdapter.parse('{"type":"session.error","properties":{"sessionID":"ses_2","error":{"name":"ProviderAuthError","data":{"message":"invalid api key"}}}}', st))
    .toEqual([{ kind: "fail", error: "invalid api key", sessionId: "ses_2" }]);
  expect(opencodeAdapter.parse('{"type":"message.part.updated","properties":{"part":{"id":"p9","type":"tool","tool":"bash","state":{"status":"error","input":{"command":"x"},"error":"boom"}}}}', st))
    .toEqual([{ kind: "log", text: "tool bash error: boom" }]);
  // the same finished text twice is emitted once (mutation target: the dedupe map)
  const line = '{"type":"message.part.updated","properties":{"part":{"id":"p1","type":"text","text":"same","time":{"start":1,"end":2}}}}';
  expect([...opencodeAdapter.parse(line, st), ...opencodeAdapter.parse(line, st)]).toEqual([{ kind: "log", text: "same" }]);
});

test("REAL opencode 1.18.23 `run --format json` capture (2026-09-03): FLAT {type,sessionID,part} lines — step_start ignored, text → log, tool_use write → edit, step_finish tool-calls → usage only, step_finish stop → usage + done (summary = last text, session id); no idle event exists", () => {
  const { events, garbage, sessionId } = parseAll(opencodeAdapter, fixture("opencode-live-run"));
  expect(garbage).toBe(1); // the header only
  expect(sessionId).toBe("ses_f9befaa3fffeABBp5svat5C9w9"); // top-level sessionID of every flat line
  expect(events).toEqual([
    { kind: "log", text: "[N] he wants a hello.txt. trivial. shipping." },
    { kind: "edit", path: "D:\\scratch\\lane-live\\.aion\\worktrees\\1bf74c13\\hello.txt", op: "write", wrote: true, callId: "call_003c475ca1414dc38144191b" }, // mutation target: the FLAT set → tool_use dropped
    { kind: "usage", usage: { input: 27035, output: 106, cacheRead: 0, cacheWrite: 0, costUsd: 0 } }, // reason "tool-calls": usage, NO done (mutation target: done on every step_finish → the lane ends after step 1)
    { kind: "log", text: "DONE" },
    { kind: "usage", usage: { input: 149, output: 15, cacheRead: 27008, cacheWrite: 0, costUsd: 0 } },
    { kind: "done", summary: "DONE", sessionId: "ses_f9befaa3fffeABBp5svat5C9w9" }, // mutation target: `reason === "stop"` → the runner reports `exited 0 without a result event` (the live O2 verdict before this fix)
  ]);
  // REAL flat error line (live O3, 2026-09-03: `-s <session>` resume after the lane's worktree was removed → the CLI exits 1 right after it): error.data.message → fail, session id kept
  const err = newParseState();
  expect(opencodeAdapter.parse('{"type":"error","timestamp":1788385429790,"sessionID":"ses_f9befaa3fffeABBp5svat5C9w9","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_855c7676"}}}', err))
    .toEqual([{ kind: "fail", error: "Unexpected server error. Check server logs for details.", sessionId: "ses_f9befaa3fffeABBp5svat5C9w9" }]);
  // reason error/length/content-filter → fail; other reasons → nothing (the runner's exit-code fallback decides)
  const st = newParseState();
  expect(opencodeAdapter.parse('{"type":"step_finish","sessionID":"s1","part":{"type":"step-finish","reason":"length","tokens":{"input":1,"output":2}}}', st)).toEqual([{ kind: "usage", usage: { input: 1, output: 2 } }, { kind: "fail", error: "step finished: length", sessionId: "s1" }]);
  expect(opencodeAdapter.parse('{"type":"step_finish","sessionID":"s1","part":{"type":"step-finish","reason":"unknown"}}', st)).toEqual([]);
  expect(opencodeAdapter.parse('{"type":"step_start","sessionID":"s1","part":{"type":"step-start","snapshot":"abc"}}', st)).toEqual([]);
  // a reasoning part logs as thinking and never becomes the summary
  expect(opencodeAdapter.parse('{"type":"reasoning","sessionID":"s1","part":{"id":"r1","type":"reasoning","text":"plan it","time":{"start":1,"end":2}}}', st)).toEqual([{ kind: "log", text: "thinking: plan it" }]);
  expect(st.lastText).toBeUndefined();
  // a running tool part is silent; the same completed part is not repeated by dedupe of text only (tools have no dedupe) — status decides
  expect(opencodeAdapter.parse('{"type":"tool_use","sessionID":"s1","part":{"type":"tool","tool":"bash","state":{"status":"running","input":{"command":"ls"}}}}', st)).toEqual([]);
  expect(opencodeAdapter.parse('{"type":"tool_use","sessionID":"s1","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a b","metadata":{"exit":0}}}}', st)).toEqual([{ kind: "bash", command: "ls", output: "a b", exitCode: 0 }]);
});

test("agy fixture → init log, text deltas flushed per completed line, tool steps → edit/bash, result SUCCESS → usage + done; ERROR/INVALID → fail", () => {
  const { events, garbage, sessionId } = parseAll(agyAdapter, fixture("agy"));
  expect(events).toEqual([
    { kind: "log", text: "init · model gemini-3.5-flash-medium · conversation conv-agy-1" },
    { kind: "log", text: "Planning the change." },
    { kind: "edit", path: "README.md", op: "write" },
    { kind: "bash", command: "git diff --stat", output: "1 file changed" },
    { kind: "log", text: "Editing README done" },
    { kind: "usage", usage: { input: 700, output: 120 } },
    { kind: "done", summary: "Added a comment to README.", sessionId: "conv-agy-1" },
  ]);
  expect(garbage).toBe(1);
  expect(sessionId).toBe("conv-agy-1");
  const st = newParseState();
  expect(agyAdapter.parse('{"type":"result","status":"ERROR","response":"model overloaded"}', st)).toEqual([{ kind: "fail", error: "model overloaded" }]);
  expect(agyAdapter.parse('{"type":"result","status":"INVALID"}', st)).toEqual([{ kind: "fail", error: "result INVALID" }]);
  // a SUCCESS without a response falls back to the accumulated text
  const st2 = newParseState();
  agyAdapter.parse('{"type":"step_update","step_type":"text","text_delta":"all set"}', st2);
  expect(agyAdapter.parse('{"type":"result","status":"SUCCESS"}', st2)).toEqual([{ kind: "log", text: "all set" }, { kind: "done", summary: "all set" }]);
});

// ---------- garbage never throws ----------

const GARBAGE = ["", "   ", "not json", "{", '{"a":', "[1,2,3]", "42", "null", '"str"', '{"no":"type"}', '{"type":42}', "\u0000\u0001", "}{", '{"type":"unknown.event","x":1}'];

test("every adapter skips garbage without throwing and counts non-events; an unknown but typed event is ignored, not counted", () => {
  for (const id of ADAPTER_IDS) {
    const a = ADAPTERS[id];
    const st = newParseState();
    for (const g of GARBAGE) expect(() => a.parse(g, st)).not.toThrow(); // mutation target: JSON.parse outside the try in parseJsonLine
    // the last one is a typed-but-unknown event → ignored (not garbage); everything else counts
    expect(st.garbage).toBe(GARBAGE.length - 1);
    for (const g of GARBAGE) expect(a.parse(g, newParseState())).toEqual([]);
  }
});

// ---------- registry: gate, knobs, card text ----------

test("ROVECODE_LANES_ALLOW gate is ON by default: unset = all four, DEFINED is an exact list, and empty is the kill switch", () => {
  // The default changed on 2026-09-07 and this is the assertion that says so out loud. Unset must be
  // ALL, not "none" and not "the ones installed" — installedness is a separate refusal below, because
  // a machine's PATH is not a policy and the two must not be readable as one thing.
  expect([...lanesAllowed({})]).toEqual(["claude", "codex", "opencode", "agy"]);
  // Defined-wins is the part that makes turning the default on safe: someone who had already narrowed
  // the set does not get silently widened, and "" is how you turn every lane off.
  expect([...lanesAllowed({ ROVECODE_LANES_ALLOW: "" })]).toEqual([]);
  expect([...lanesAllowed({ ROVECODE_LANES_ALLOW: " Codex, claude ,nope" })]).toEqual(["codex", "claude"]);
  expect(laneRefusal("codex", { ROVECODE_LANES_ALLOW: "codex" }, () => true)).toBeNull();
  expect(laneRefusal("codex", {}, () => true)).toBeNull();               // on by default, end to end
  // mutation target: the `allowed.has(id)` check → null for everyone, which would make "" mean nothing
  expect(laneRefusal("codex", { ROVECODE_LANES_ALLOW: "" }, () => true))
    .toBe("external lane 'codex' is not in ROVECODE_LANES_ALLOW (currently allowed: none) — add it, or unset ROVECODE_LANES_ALLOW to allow all of claude,codex,opencode,agy");
  const narrowed = laneRefusal("claude", { ROVECODE_LANES_ALLOW: "codex" }, () => true);
  expect(narrowed).toContain("currently allowed: codex");
  // The refusal must NOT tell someone to opt in to a thing that is already on — that was the old text,
  // and left in place it would send a user to set a knob that cannot fix their problem.
  expect(narrowed).not.toContain("to opt in");
  expect(isAdapterId("codex")).toBe(true); expect(isAdapterId("main")).toBe(false); expect(isAdapterId(undefined)).toBe(false);
});

test("a lane whose CLI is not on PATH is refused AT THE GATE, by name, before any worktree exists", () => {
  // With the gate off this was academic; with lanes on by default it is the common case. Left to the
  // spawn it reads `spawn failed: codex: ENOENT` — after a worktree was built and a turn was spent.
  expect(laneBinary("codex")).toBe("codex");
  expect(laneBinary("agy")).toBe("agy");   // the id and the binary happen to match here; the others are read from command()
  expect(ADAPTER_IDS.map((id) => laneBinary(id))).toEqual(["claude", "codex", "opencode", "agy"]);
  const missing = laneRefusal("codex", {}, () => false);
  expect(missing).toBe("external lane 'codex' needs the 'codex' CLI, which is not on PATH — install it, or start a different lane (claude, opencode, agy)");
  // A list the user narrowed themselves is answered FIRST: telling someone to install codex when they
  // deliberately allowed only claude sends them to fix the wrong thing.
  expect(laneRefusal("codex", { ROVECODE_LANES_ALLOW: "claude" }, () => false)).toContain("is not in ROVECODE_LANES_ALLOW");
});

test("the PATH probe answers from PATH alone, treats an absent PATH as 'present', and is memoised per PATH", () => {
  resetPathProbe();
  const dir = mkdtempSync(join(tmpdir(), "rove-probe-"));
  const exe = process.platform === "win32" ? "tool.CMD" : "tool";
  writeFileSync(join(dir, exe), "");
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  expect(onPath("tool", env)).toBe(true);          // found via PATHEXT on win32, bare name elsewhere
  expect(onPath("nope-not-here", env)).toBe(false);
  // A probe that guessed "missing" with nothing to search would block a lane the OS could have started.
  expect(onPath("codex", { PATH: "" })).toBe(true);
  expect(onPath("codex", {})).toBe(true);
  // An explicit path is not a PATH lookup: it either exists or it does not.
  expect(onPath(join(dir, exe), env)).toBe(true);
  expect(onPath(join(dir, "ghost.exe"), env)).toBe(false);
  // Memoised per (bin, PATH): deleting the file does not change the cached answer, but a different
  // PATH is a different question. This is why `task start` in a loop does not re-stat the disk.
  rmSync(join(dir, exe));
  expect(onPath("tool", env)).toBe(true);
  resetPathProbe();
  expect(onPath("tool", env)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("laneStartNote states the lane's REAL flags, so a permission=auto user is told what just began", () => {
  // Turning the gate on removes the approval that came with it for anyone on permission=auto, where no
  // card is ever shown. This sentence is the replacement, and it is built from lanePermissions so it
  // cannot drift from the flags the lane actually got.
  const note = laneStartNote("codex", { ROVECODE_LANE_CODEX_SANDBOX: "read-only" });
  expect(note).toContain(lanePermissions("codex", { ROVECODE_LANE_CODEX_SANDBOX: "read-only" }));
  expect(note).toContain("sandbox read-only");
  expect(note).toContain("started");
  expect(note).toContain("its own worktree");
  // the dangerous flag is named in the note exactly as the card names it, never softened
  expect(laneStartNote("agy", { ROVECODE_LANES_ALLOW_ALL: "agy" })).toContain("every tool auto-approved");
});

test("laneOptsFor: the worktree cwd always wins, timeout from ROVECODE_LANE_TIMEOUT_MS (≥1s else 15 min), claude allowlist / codex sandbox / agy allow-all from their env knobs", () => {
  expect(laneTimeoutFromEnv({})).toBe(15 * 60_000);
  expect(laneTimeoutFromEnv({ ROVECODE_LANE_TIMEOUT_MS: "120000" })).toBe(120_000);
  expect(laneTimeoutFromEnv({ ROVECODE_LANE_TIMEOUT_MS: "5" })).toBe(15 * 60_000);
  expect(laneTimeoutFromEnv({ ROVECODE_LANE_TIMEOUT_MS: "soon" })).toBe(15 * 60_000);
  expect(laneOptsFor("codex", "D:/wt", {})).toEqual({ cwd: "D:/wt", timeoutMs: 15 * 60_000, sandbox: "workspace-write" });
  expect(laneOptsFor("codex", "D:/wt", { ROVECODE_LANE_CODEX_SANDBOX: "read-only" }).sandbox).toBe("read-only");
  expect(laneOptsFor("codex", "D:/wt", { ROVECODE_LANE_CODEX_SANDBOX: "danger-full-access" }).sandbox).toBe("workspace-write"); // never offered
  expect(laneOptsFor("claude", "D:/wt", {}).allowlist).toBeUndefined(); // → the adapter's default list
  expect(laneOptsFor("claude", "D:/wt", { ROVECODE_LANE_CLAUDE_ALLOW: "Read, Edit,Bash(npm test)," }).allowlist).toEqual(["Read", "Edit", "Bash(npm test)"]);
  // claude --bare only when the lane env can authenticate it (ANTHROPIC_API_KEY); ROVECODE_LANE_CLAUDE_BARE=1|0 forces
  expect(laneOptsFor("claude", "D:/wt", {}).bare).toBe(false); // mutation target: default-on → a login-only machine gets 'Not logged in' at once
  expect(laneOptsFor("claude", "D:/wt", { ANTHROPIC_API_KEY: "" }).bare).toBe(false);
  expect(laneOptsFor("claude", "D:/wt", { ANTHROPIC_API_KEY: "sk-ant-x" }).bare).toBe(true);
  expect(laneOptsFor("claude", "D:/wt", { ANTHROPIC_API_KEY: "sk-ant-x", ROVECODE_LANE_CLAUDE_BARE: "0" }).bare).toBe(false);
  expect(laneOptsFor("claude", "D:/wt", { ROVECODE_LANE_CLAUDE_BARE: "1" }).bare).toBe(true);
  expect(laneOptsFor("codex", "D:/wt", { ANTHROPIC_API_KEY: "sk-ant-x" }).bare).toBeUndefined(); // claude-only knob
  // CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, the documented headless login) → oauthToken for the card's auth word; claude-only; absent when unset/empty
  expect(CLAUDE_OAUTH_TOKEN_ENV).toBe("CLAUDE_CODE_OAUTH_TOKEN"); expect(KEPT_ENV_EXACT).toContain(CLAUDE_OAUTH_TOKEN_ENV); // the seam must let the name through for the label to be truthful
  expect(laneOptsFor("claude", "D:/wt", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }).oauthToken).toBe(true);
  expect(laneOptsFor("claude", "D:/wt", {}).oauthToken).toBeUndefined();
  expect(laneOptsFor("claude", "D:/wt", { CLAUDE_CODE_OAUTH_TOKEN: "" }).oauthToken).toBeUndefined();
  expect(laneOptsFor("codex", "D:/wt", { CLAUDE_CODE_OAUTH_TOKEN: "x" }).oauthToken).toBeUndefined();
  // ROVECODE_LANE_<ID>_MODEL → the adapter's model flag; blank/whitespace sets nothing
  expect(laneOptsFor("opencode", "D:/wt", { ROVECODE_LANE_OPENCODE_MODEL: " cf-workers/llama-3.3-70b " }).model).toBe("cf-workers/llama-3.3-70b");
  expect(laneOptsFor("claude", "D:/wt", { ROVECODE_LANE_CLAUDE_MODEL: "opus" }).model).toBe("opus");
  expect(laneOptsFor("claude", "D:/wt", { ROVECODE_LANE_OPENCODE_MODEL: "x" }).model).toBeUndefined(); // another lane's knob
  expect(laneOptsFor("codex", "D:/wt", { ROVECODE_LANE_CODEX_MODEL: "  " }).model).toBeUndefined();
  // The harness this came from read every knob through a central core/env.ts that also accepted a legacy
  // second spelling, and these lines pinned which spelling won. rovecode has ONE prefix and no central
  // reader (registry.ts:envName), so that precedence rule does not exist here and pinning it would be
  // pinning a fiction. What survives is what the knobs actually do — including the one rule that is easy
  // to get wrong: for `bare`, DEFINED-ness does not decide, the value does, and anything that is neither
  // "1" nor "0" falls through to "is there an API key", because that is what the CLI itself requires.
  expect(LANE_CLAUDE_BARE_ENV).toBe("ROVECODE_LANE_CLAUDE_BARE");
  expect(laneModelEnv("opencode")).toBe("ROVECODE_LANE_OPENCODE_MODEL");
  expect(laneOptsFor("claude", "D:/wt", { ROVECODE_LANE_CLAUDE_BARE: "1" }).bare).toBe(true);
  expect(laneOptsFor("claude", "D:/wt", { ANTHROPIC_API_KEY: "sk-ant-x", ROVECODE_LANE_CLAUDE_BARE: "0" }).bare).toBe(false); // explicit 0 beats a present key
  expect(laneOptsFor("claude", "D:/wt", { ROVECODE_LANE_CLAUDE_BARE: "" }).bare).toBe(false); // neither 1 nor 0 → key rule → no key → not bare
  expect(laneOptsFor("claude", "D:/wt", { ANTHROPIC_API_KEY: "sk-ant-x", ROVECODE_LANE_CLAUDE_BARE: "" }).bare).toBe(true); // …and with a key, bare
  expect(laneOptsFor("opencode", "D:/wt", { ROVECODE_LANE_OPENCODE_MODEL: "new/model" }).model).toBe("new/model");
  expect(laneOptsFor("opencode", "D:/wt", { ROVECODE_LANE_OPENCODE_MODEL: "" }).model).toBeUndefined();
  expect(laneOptsFor("agy", "D:/wt", {}).allowAll).toBeUndefined();
  expect(laneOptsFor("agy", "D:/wt", { ROVECODE_LANES_ALLOW_ALL: "agy" }).allowAll).toBe(true);
  expect(laneOptsFor("agy", "D:/wt", { ROVECODE_LANES_ALLOW_ALL: "codex" }).allowAll).toBeUndefined();
  expect(laneOptsFor("opencode", "D:/wt", {}, { cwd: "elsewhere", model: "m" })).toEqual({ cwd: "D:/wt", timeoutMs: 15 * 60_000, model: "m" });
});

test("lanePermissions / laneApprovalText: the card text per adapter, from a `task start` args object; null for non-lane calls", () => {
  expect(lanePermissions("codex", {})).toBe("spawn codex lane · sandbox workspace-write · approval never · worktree");
  expect(lanePermissions("claude", {})).toBe("spawn claude lane · permission-mode acceptEdits · allow: Read,Edit,Write · cli login · worktree");
  expect(lanePermissions("claude", { ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("spawn claude lane · permission-mode acceptEdits · allow: Read,Edit,Write · bare · worktree");
  // the token login is named on the card (mutation target: authOf ignoring oauthToken); `--bare` is key-only, so a key beside the token — or a forced bare — still reads `bare`
  expect(lanePermissions("claude", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" })).toBe("spawn claude lane · permission-mode acceptEdits · allow: Read,Edit,Write · oauth token · worktree");
  expect(lanePermissions("claude", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("spawn claude lane · permission-mode acceptEdits · allow: Read,Edit,Write · bare · worktree");
  expect(lanePermissions("claude", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", ROVECODE_LANE_CLAUDE_BARE: "1" })).toContain(" · bare · ");
  expect(lanePermissions("agy", {})).toBe("spawn agy lane · soft-deny (tools needing approval are refused, exit 0 — diff is cross-checked) · worktree");
  expect(lanePermissions("agy", { ROVECODE_LANES_ALLOW_ALL: "agy" })).toBe("spawn agy lane · --dangerously-skip-permissions (every tool auto-approved) · worktree");
  expect(lanePermissions("opencode", {})).toBe("spawn opencode lane · permissions per opencode config (asks surface as lane events) · worktree");
  expect(laneApprovalText({ action: "start", agent: "codex", goal: "x" }, {})).toBe(lanePermissions("codex", {}));
  // mutation targets: the action/agent guards
  expect(laneApprovalText({ action: "start", agent: "main", goal: "x" }, {})).toBeNull();
  expect(laneApprovalText({ action: "cancel", agent: "codex", id: "t1" }, {})).toBeNull();
  expect(laneApprovalText("start codex", {})).toBeNull();
  expect(laneApprovalText(undefined, {})).toBeNull();
});

// ---------- event helpers ----------

test("usageFrom reads every CLI's token shape; addUsage sums; renderEvent gives one bounded line per event", () => {
  expect(usageFrom({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, { total_cost_usd: 0.5 })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5 });
  expect(usageFrom({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 6 })).toEqual({ input: 10, output: 6, cacheRead: 4 });
  expect(usageFrom({ input: 5, output: 1, cache: { read: 2, write: 1 } }, { cost: 0.01 })).toEqual({ input: 5, output: 1, cacheRead: 2, cacheWrite: 1, costUsd: 0.01 });
  expect(usageFrom({ prompt_tokens: 7, completion_tokens: 3 })).toEqual({ input: 7, output: 3 });
  expect(usageFrom({ duration_ms: 5 })).toBeUndefined();
  expect(usageFrom("nope")).toBeUndefined();
  expect(addUsage(undefined, { input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
  expect(addUsage({ input: 1, output: 2, costUsd: 0.1 }, { input: 3, output: 4, cacheRead: 5 })).toEqual({ input: 4, output: 6, cacheRead: 5, costUsd: 0.1 });
  expect(renderEvent({ kind: "bash", command: "npm test", exitCode: 0, output: "18 passed" })).toBe("$ npm test → exit 0 · 18 passed");
  expect(renderEvent({ kind: "edit", path: "a.ts", op: "write" })).toBe("write a.ts");
  expect(renderEvent({ kind: "edit", path: "a.ts", op: "write", wrote: true })).toBe("write a.ts (ok)"); // the confirmed write reads differently in the log
  expect(renderEvent({ kind: "tool", name: "Grep" })).toBe("tool Grep");
  expect(renderEvent({ kind: "tool", name: "Grep", detail: "3 matches" })).toBe("tool Grep: 3 matches");
  expect(renderEvent({ kind: "usage", usage: { input: 1, output: 2, costUsd: 0.04 } })).toBe("usage: 1 in · 2 out · $0.0400");
  expect(renderEvent({ kind: "done", summary: "" })).toBe("done: (no output)");
  expect(renderEvent({ kind: "log", text: "x".repeat(300) })).toHaveLength(200);
  expect(renderEvent({ kind: "ask", text: "Run git push?" })).toBe("ask: Run git push?");
  expect(renderEvent({ kind: "progress", text: "plan 1/2" })).toBe("progress: plan 1/2");
  expect(renderEvent({ kind: "fail", error: "boom" })).toBe("fail: boom");
});
