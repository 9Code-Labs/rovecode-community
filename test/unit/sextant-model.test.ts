/** Port #41 model: the pure RunEvent reducer (activity transitions incl. ERROR/SUCCESS/IDLE, the run
 *  clock, the streaming assistant row, tool rows — verbs/labels/details per tool, +a −b from edit
 *  args or the diff hook, touched-file TTL, code-panel targets, steer/compaction/system rows,
 *  interrupted rows at run_end), the files tree (order, expansion, statuses, guides), toasts, usage
 *  math over core/usage.ts, plan setters, and the purity pin (no clocks/timers/process in the pure modules). */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyEvent, makeApplyEvent, initialState, setFiles, treeRows, treeGuides, repoModified, fileCount, expandTo,
  pushToast, pruneToasts, elapsed, fmtClock, fmtElapsed, fmtK, contextPercent, setUsage, setPlan, planCounts, setCrew, TOUCH_MS, TOAST_MS,
} from "../../src/sextant/model.ts";
import { describeCall, summarizeEnd, relPath } from "../../src/sextant/tool-rows.ts";
import { drawFiles } from "../../src/sextant/draw-frame.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import type { SextantState, ToolRow, TreeRow } from "../../src/sextant/types.ts";
import type { RunEvent } from "../../src/core/types.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const T = 1_700_000_000_000;
const CWD = "C:/work/atlas";

function state(): SextantState {
  const s = initialState({ cwd: CWD, repo: { name: "atlas", branch: "main" }, version: "0.2.0", theme: "night", mode: "act", yolo: false, commands: [], now: T, model: { provider: "openai", model: "gpt-5" } });
  setFiles(s, ["src/app.ts", "src/auth/callback.ts", "src/auth/session.ts", "README.md"], new Map([["src/auth/session.ts", "M"]]));
  return s;
}
const run = (s: SextantState, at = T) => applyEvent(s, { type: "run_start", runId: "r1", sessionId: "sess", goal: "go" }, at);
const start = (s: SextantState, callId: string, tool: string, args: unknown, at = T) => applyEvent(s, { type: "tool_execution_start", callId, tool, args }, at);
const end = (s: SextantState, callId: string, ok: boolean, output: string, at = T, durationMs = 5) => applyEvent(s, { type: "tool_execution_end", callId, ok, output, durationMs }, at);
const lastTool = (s: SextantState): ToolRow => { const r = s.messages.filter((m) => m.kind === "tool").at(-1); if (!r || r.kind !== "tool") throw new Error("no tool row"); return r; };
const EDIT_ARGS = { path: "src/auth/callback.ts", edits: [
  { tag: "a1b2", anchorLine: 2, anchorHash: "e5f6", newLines: ["x", "y", "z"] },
  { tag: "a1b2", anchorLine: 3, anchorHash: "0a1b", newLines: ["w"] },
] };

// ---------- initial state ----------

test("initialState: idle, not running, bootAt = now, model/version/mode/theme/commands carried, empty panels", () => {
  const s = state();
  expect(s.activity).toEqual({ state: "IDLE", label: "idle", runId: null, startedAt: null, endedAt: null });
  expect(s.running).toBe(false);
  expect(s.bootAt).toBe(T);
  expect(s.usage).toEqual({ provider: "openai", model: "gpt-5", turns: 0, tokensIn: 0, tokensOut: 0, contextPct: null, costUsd: null });
  expect(s).toMatchObject({ cwd: CWD, mode: "act", yolo: false, theme: "night", version: "0.2.0", focus: "messages", card: null, palette: null, help: false, escUntil: 0, stick: true, msgScroll: 0 });
  expect(s.plan).toEqual({ todos: [] });
  expect(s.crew).toEqual([]);
  expect(s.toasts).toEqual([]);
  expect(s.code).toMatchObject({ mode: "code", file: null, content: null, hl: null, run: null, search: null, diff: null });
  expect(s.repo).toEqual({ name: "atlas", branch: "main", modified: 1 });
  expect(elapsed(s, T + 5000)).toBe(0);
});

// ---------- run lifecycle ----------

test("run_start: THINKING, startedAt = now, endedAt null, runId, running; turn_start keeps THINKING and counts turns", () => {
  const s = state();
  run(s, T + 10);
  expect(s.activity).toEqual({ state: "THINKING", label: "thinking", runId: "r1", startedAt: T + 10, endedAt: null });
  expect(s.running).toBe(true);
  applyEvent(s, { type: "turn_start", turn: 1 }, T + 20);
  expect(s.usage.turns).toBe(1);
  expect(elapsed(s, T + 4010)).toBe(4000);
});

test("run_end done → SUCCESS 'done', endedAt frozen, running false; the summary becomes the assistant row when no text streamed", () => {
  const s = state();
  run(s);
  applyEvent(s, { type: "run_end", status: "done", summary: "all set" }, T + 12_000);
  expect(s.activity).toMatchObject({ state: "SUCCESS", label: "done", endedAt: T + 12_000 });
  expect(s.running).toBe(false);
  expect(s.messages).toEqual([{ kind: "assistant", text: "all set", streaming: false }]);
  expect(elapsed(s, T + 99_000)).toBe(12_000); // frozen
  // with streamed text the summary is NOT duplicated
  const s2 = state();
  run(s2);
  applyEvent(s2, { type: "message_update", messageId: "m", delta: "hi" }, T);
  applyEvent(s2, { type: "run_end", status: "done", summary: "hi" }, T + 1);
  expect(s2.messages).toEqual([{ kind: "assistant", text: "hi", streaming: false, id: "m" }]);
});

test("run_end error → ERROR + error system row; stopped/budget → IDLE + warn row; running tool rows are closed as interrupted", () => {
  const s = state();
  run(s);
  start(s, "c1", "bash", { command: "sleep 100" });
  applyEvent(s, { type: "run_end", status: "error", summary: "provider exploded" }, T + 5);
  expect(s.activity).toMatchObject({ state: "ERROR", label: "error", endedAt: T + 5 });
  expect(lastTool(s)).toMatchObject({ running: false, ok: false, detail: "interrupted" });
  expect(s.messages.at(-1)).toEqual({ kind: "system", tone: "error", text: "provider exploded" });
  const s2 = state();
  run(s2);
  applyEvent(s2, { type: "run_end", status: "stopped", summary: "user interrupt" }, T + 5);
  expect(s2.activity).toMatchObject({ state: "IDLE", label: "stopped" });
  expect(s2.messages.at(-1)).toEqual({ kind: "system", tone: "warn", text: "run stopped: user interrupt" });
  const s3 = state();
  run(s3);
  applyEvent(s3, { type: "run_end", status: "budget", summary: "max turns" }, T + 5);
  expect(s3.activity.label).toBe("budget");
});

// ---------- streaming assistant row ----------

test("message_update: creates a streaming row, appends deltas to it, WRITING; a tool start or turn boundary finalizes it and a later delta opens a new row", () => {
  const s = state();
  run(s);
  applyEvent(s, { type: "message_update", messageId: "m1", delta: "Let me " }, T);
  applyEvent(s, { type: "message_update", messageId: "m1", delta: "look." }, T);
  expect(s.messages).toEqual([{ kind: "assistant", text: "Let me look.", streaming: true, id: "m1" }]); // #44 contract: id = the RunEvent messageId
  expect(s.activity).toMatchObject({ state: "WRITING", label: "writing" });
  start(s, "c1", "read", { path: "README.md" });
  expect(s.messages[0]).toEqual({ kind: "assistant", text: "Let me look.", streaming: false, id: "m1" });
  end(s, "c1", true, "README.md#aa\n1#bb|# atlas\n(showing lines 1-1 of 1)");
  applyEvent(s, { type: "message_update", messageId: "m2", delta: "Done." }, T);
  expect(s.messages.at(-1)).toEqual({ kind: "assistant", text: "Done.", streaming: true, id: "m2" });
  applyEvent(s, { type: "turn_end", turn: 1, stopReason: "end_turn" as never }, T);
  expect(s.messages.at(-1)).toMatchObject({ streaming: false });
  applyEvent(s, { type: "turn_start", turn: 2 }, T);
  applyEvent(s, { type: "message_update", messageId: "m3", delta: "More." }, T);
  expect(s.messages.filter((m) => m.kind === "assistant")).toHaveLength(3);
});

// ---------- tool rows ----------

test("edit start: EDITING 'editing <basename>', touched for exactly 1.5 s, tree expanded to the file, code panel targets the file + anchor range, row +a −b from the ops", () => {
  const s = state();
  run(s);
  start(s, "c1", "edit", EDIT_ARGS, T + 100);
  expect(s.activity).toMatchObject({ state: "EDITING", label: "editing callback.ts" });
  expect(s.files.touched.get("src/auth/callback.ts")).toBe(T + 100 + TOUCH_MS);
  expect(TOUCH_MS).toBe(1500);
  expect([...s.files.expanded]).toEqual(["src", "src/auth"]);
  expect(s.code).toMatchObject({ mode: "code", file: "src/auth/callback.ts", hl: [2, 4], content: null, scroll: 0 });
  expect(lastTool(s)).toEqual({ kind: "tool", callId: "c1", tool: "edit", verb: "edit", label: "callback.ts", path: "src/auth/callback.ts", running: true, add: 4, del: 2 }); // #44 contract: path = the code-panel target
  const row = treeRows(s).find((r) => r.path === "src/auth/callback.ts")!;
  expect(row.touchedUntil).toBe(T + 1600);
  // the drawer shows the diamond spinner only while the clock is inside the TTL
  const grid = (now: number) => { const g = new GridScreen(40, 12); drawFiles(g, { x: 0, y: 0, w: 40, h: 12 }, s, nightTheme(), now); return g.toText(); };
  expect(grid(T + 1599)).toMatch(/callback\.ts [◇◈◆]/);
  expect(grid(T + 1600)).not.toMatch(/callback\.ts [◇◈◆]/);
  // edit landed: THINKING again, add/del kept from the args, no detail
  end(s, "c1", true, "applied 2 edit(s); new TAG b7c8", T + 200, 42);
  expect(lastTool(s)).toMatchObject({ running: false, ok: true, ms: 42, add: 4, del: 2 });
  expect(lastTool(s).detail).toBeUndefined();
  expect(s.activity).toMatchObject({ state: "THINKING", label: "thinking" });
});

test("diff hook: makeApplyEvent({ diffFor }) replaces the args-derived +a −b with real hunks and switches the code panel to diff mode", () => {
  const seen: unknown[] = [];
  const apply = makeApplyEvent({ diffFor: (file, tool) => { seen.push([file, tool]); return { hunks: [{ rows: [{ op: "+", text: "y" }], oldStart: 2, newStart: 2 }], add: 21, del: 4 }; } });
  const s = state();
  apply(s, { type: "run_start", runId: "r", sessionId: "s", goal: "g" }, T);
  apply(s, { type: "tool_execution_start", callId: "c1", tool: "edit", args: EDIT_ARGS }, T);
  apply(s, { type: "tool_execution_end", callId: "c1", ok: true, output: "applied 2 edit(s); new TAG x", durationMs: 1 }, T);
  expect(seen).toEqual([["src/auth/callback.ts", "edit"]]);
  expect(lastTool(s)).toMatchObject({ add: 21, del: 4 });
  expect(s.code.mode).toBe("diff");
  expect(s.code.diff).toEqual({ file: "src/auth/callback.ts", hunks: [{ rows: [{ op: "+", text: "y" }], oldStart: 2, newStart: 2 }], add: 21, del: 4 });
  // a hook returning null leaves the args-derived counts and code mode alone; a FAILED edit never asks the hook
  const calls: string[] = [];
  const apply2 = makeApplyEvent({ diffFor: (f) => { calls.push(f); return null; } });
  const s2 = state();
  apply2(s2, { type: "tool_execution_start", callId: "c1", tool: "edit", args: EDIT_ARGS }, T);
  apply2(s2, { type: "tool_execution_end", callId: "c1", ok: false, output: "Edit rejected: stale read — …", durationMs: 1 }, T);
  expect(calls).toEqual([]);
  expect(lastTool(s2)).toMatchObject({ ok: false, add: 4, del: 2, detail: "Edit rejected: stale read — …" });
  expect(s2.code.mode).toBe("code");
});

test("read: READING 'reading <base>', absolute path under cwd → cwd-relative posix, window → hl, end → 'N lines' from the footer", () => {
  const s = state();
  run(s);
  start(s, "c1", "read", { path: `${CWD.replace(/\//g, "\\")}\\src\\auth\\session.ts`, offset: 10, limit: 20 });
  expect(s.activity).toMatchObject({ state: "READING", label: "reading session.ts" });
  expect(s.code).toMatchObject({ file: "src/auth/session.ts", hl: [10, 29] });
  expect(s.files.touched.has("src/auth/session.ts")).toBe(true);
  end(s, "c1", true, "src/auth/session.ts#ab\n10#cd|a\n11#ef|b\n(showing lines 10-11 of 40)");
  expect(lastTool(s)).toMatchObject({ verb: "read", label: "session.ts", ok: true, detail: "2 lines" });
  start(s, "c2", "read", { path: "README.md" });
  expect(s.code.hl).toBeNull();
  end(s, "c2", true, "README.md#aa\n1#bb|x\n2#cc|y\n3#dd|z"); // no footer → count anchored lines
  expect(lastTool(s).detail).toBe("3 lines");
  expect(relPath(CWD, "D:\\elsewhere\\x.ts")).toBe("D:/elsewhere/x.ts"); // outside cwd stays absolute (posix separators)
  expect(relPath(CWD, "./src/a.ts")).toBe("src/a.ts");
});

test("write: EDITING 'writing <base>', add = content lines; a landed write adds the new path to the tree (sorted) with a byte-count detail", () => {
  const s = state();
  run(s);
  start(s, "c1", "write", { path: "src/auth/guard.ts", content: "a\nb\nc" });
  expect(s.activity).toMatchObject({ state: "EDITING", label: "writing guard.ts" });
  expect(lastTool(s)).toMatchObject({ verb: "write", label: "guard.ts", add: 3, del: 0 });
  expect(s.files.paths).not.toContain("src/auth/guard.ts");
  end(s, "c1", true, "wrote C:/work/atlas/src/auth/guard.ts (5 bytes, TAG 1a2b)");
  expect(s.files.paths).toEqual(["README.md", "src/app.ts", "src/auth/callback.ts", "src/auth/guard.ts", "src/auth/session.ts"]);
  expect(lastTool(s).detail).toBe("5 bytes");
  expect(fileCount(s)).toBe(5);
});

test("bash: RUNNING 'running <head>' (TESTING 'running tests' for test/vitest/jest/pytest), run panel filled from the exit= output, fail → ERROR", () => {
  const s = state();
  run(s);
  start(s, "c1", "bash", { command: "npm   run build\n" });
  expect(s.activity).toMatchObject({ state: "RUNNING", label: "running npm run build" });
  expect(lastTool(s)).toMatchObject({ verb: "run", label: "npm run build" });
  expect(s.code).toMatchObject({ mode: "run", run: { cmd: "npm   run build\n", lines: [], status: "running" } });
  end(s, "c1", true, "exit=0\nbuilding…\ndone in 3s\n\n");
  expect(s.code.run).toEqual({ cmd: "npm   run build\n", lines: ["building…", "done in 3s"], status: "ok", exitCode: 0 }); // #44 contract: exitCode from the exit= header
  expect(lastTool(s)).toMatchObject({ ok: true, detail: "done in 3s" });
  for (const cmd of ["bun test", "npx vitest run", "jest --ci", "pytest -q tests", "npm run tests"]) {
    expect(describeCall("bash", { command: cmd }, CWD)).toMatchObject({ state: "TESTING", activity: "running tests" });
  }
  expect(describeCall("bash", { command: "npm run build" }, CWD).state).toBe("RUNNING");
  start(s, "c2", "bash", { command: "bun test" });
  expect(s.activity).toMatchObject({ state: "TESTING", label: "running tests" });
  end(s, "c2", false, "exit=1\n 17 pass\n 1 fail");
  expect(s.code.run).toMatchObject({ status: "fail", lines: [" 17 pass", " 1 fail"] }); // a red run still fills the panel
  expect(lastTool(s)).toMatchObject({ ok: false, detail: "1 fail" });
  expect(s.activity).toMatchObject({ state: "ERROR", label: "run failed" });
  expect(summarizeEnd({ verb: "run" }, "bash", true, "exit=0\n")).toEqual({ detail: "exit 0", runLines: [], exitCode: 0 });
  expect(summarizeEnd({ verb: "run" }, "bash", false, "no header\nboom")).toEqual({ detail: "boom", runLines: ["no header", "boom"] }); // no exit= header → no exitCode key
});

test("glob/grep: SEARCH mode with the query, READING 'searching <q>', results counted without the truncation notes", () => {
  const s = state();
  run(s);
  start(s, "c1", "glob", { pattern: "src/**/*.ts" });
  expect(s.activity).toMatchObject({ state: "READING", label: "searching src/**/*.ts" });
  expect(s.code).toMatchObject({ mode: "search", search: { query: "src/**/*.ts", lines: [] } });
  expect(lastTool(s)).toMatchObject({ verb: "search", label: "src/**/*.ts" });
  end(s, "c1", true, "src/a.ts\nsrc/b.ts\nsrc/c.ts\n(3 files, more available)");
  expect(s.code.search).toEqual({ query: "src/**/*.ts", lines: ["src/a.ts", "src/b.ts", "src/c.ts", "(3 files, more available)"] });
  expect(lastTool(s).detail).toBe("3 files");
  start(s, "c2", "grep", { pattern: "TODO", glob: "*.ts" });
  end(s, "c2", true, "src/a.ts:3: // TODO x\nsrc/b.ts:9: // TODO y");
  expect(lastTool(s).detail).toBe("2 matches");
  end(s, "c3", true, "");
  expect(describeCall("grep", { pattern: "x" }, CWD).label).toBe("x");
});

test("web_fetch → 'fetching <host>'; task → DELEGATING; ask_user → WAITING; todo_write → 'planning'; unknown tool → RUNNING 'running <tool>' with the name as label", () => {
  expect(describeCall("web_fetch", { url: "https://docs.example.com/x/y?z=1" }, CWD)).toMatchObject({ verb: "fetch", label: "docs.example.com", state: "READING", activity: "fetching docs.example.com" });
  expect(describeCall("web_fetch", { url: "not a url" }, CWD).label).toBe("not a url");
  expect(describeCall("task", { agent: "worker", goal: "write tests", label: "tests" }, CWD)).toMatchObject({ verb: "task", label: "tests", state: "DELEGATING", activity: "delegating tests" });
  expect(describeCall("task", { agent: "worker" }, CWD).label).toBe("worker");
  expect(describeCall("ask_user", { question: "Deploy to prod?\nreally?" }, CWD)).toMatchObject({ verb: "other", label: "Deploy to prod?", state: "WAITING", activity: "waiting for you" });
  expect(describeCall("todo_write", { todos: [] }, CWD)).toMatchObject({ label: "todos", state: "THINKING", activity: "planning" });
  expect(describeCall("mcp_weather", { city: "x" }, CWD)).toMatchObject({ verb: "other", label: "mcp_weather", state: "RUNNING", activity: "running mcp_weather" });
  expect(describeCall("ls", { path: "src" }, CWD)).toMatchObject({ label: "src", activity: "listing src" });
  expect(describeCall("remove", { path: "src/old.ts" }, CWD)).toMatchObject({ verb: "remove", label: "old.ts", state: "EDITING", activity: "removing old.ts" });
  expect(describeCall("read", null, CWD)).toMatchObject({ label: "file", path: null }); // malformed args never throw
  expect(summarizeEnd({ verb: "fetch" }, "web_fetch", true, "hello world")).toEqual({ detail: "11 chars" });
  expect(summarizeEnd({ verb: "other" }, "x", true, "\n\n  first   line \nsecond")).toEqual({ detail: "first line" });
});

test("tool_execution_update appends notes to the row detail; end ok:false → ERROR '<verb> failed' with the first output line as detail", () => {
  const s = state();
  run(s);
  start(s, "c1", "mcp_tool", {});
  applyEvent(s, { type: "tool_execution_update", callId: "c1", note: "step 1" }, T);
  applyEvent(s, { type: "tool_execution_update", callId: "c1", note: "step 2\nignored second line" }, T);
  expect(lastTool(s).detail).toBe("step 1 · step 2");
  applyEvent(s, { type: "tool_execution_update", callId: "nope", note: "orphan" }, T); // unknown call: ignored, no throw
  end(s, "c1", false, "Error: boom\nstack…");
  expect(lastTool(s)).toMatchObject({ running: false, ok: false, detail: "Error: boom" });
  expect(s.activity).toMatchObject({ state: "ERROR", label: "other failed" });
});

test("parallel tool calls: a finished call only flips to THINKING once no sibling is still running; an end without a start synthesizes a row", () => {
  const s = state();
  run(s);
  start(s, "c1", "read", { path: "src/app.ts" });
  start(s, "c2", "read", { path: "README.md" });
  end(s, "c1", true, "src/app.ts#a\n1#b|x\n(showing lines 1-1 of 1)");
  expect(s.activity.state).toBe("READING");
  end(s, "c2", true, "README.md#a\n1#b|x\n(showing lines 1-1 of 1)");
  expect(s.activity.state).toBe("THINKING");
  end(s, "ghost", true, "late output");
  expect(lastTool(s)).toMatchObject({ callId: "ghost", verb: "other", label: "ghost", running: false, ok: true, detail: "late output" });
});

test("tool_call_failed: error system row always; an existing row is closed with the reason; ERROR label 'denied' for permission_denied", () => {
  const s = state();
  run(s);
  applyEvent(s, { type: "tool_call_failed", callId: "c9", reason: "permission_denied", detail: "user denied" }, T);
  expect(s.messages.at(-1)).toEqual({ kind: "system", tone: "error", text: "permission denied: user denied" });
  expect(s.activity).toMatchObject({ state: "ERROR", label: "denied" });
  start(s, "c1", "edit", EDIT_ARGS);
  applyEvent(s, { type: "tool_call_failed", callId: "c1", reason: "truncated", detail: "response cut" }, T);
  expect(s.messages.filter((m) => m.kind === "tool").at(-1)).toMatchObject({ running: false, ok: false, detail: "truncated" });
  expect(s.messages.at(-1)).toEqual({ kind: "system", tone: "error", text: "truncated: response cut" });
  expect(s.activity.label).toBe("callback.ts truncated");
  applyEvent(s, { type: "tool_call_failed", callId: "c2", reason: "not_found", detail: "unknown tool zap" }, T);
  expect(s.activity.label).toBe("not found");
});

test("steer and compaction append their rows", () => {
  const s = state();
  run(s);
  applyEvent(s, { type: "steer", text: "task done: write tests" }, T);
  applyEvent(s, { type: "compaction", strategy: "head-summarize", trigger: "speculative", tokensBefore: 120_000, tokensAfter: 30_500 }, T);
  applyEvent(s, { type: "compaction", strategy: "context-drop", tokensBefore: 900, tokensAfter: 400 }, T);
  expect(s.messages).toEqual([
    { kind: "steer", text: "task done: write tests" },
    { kind: "compaction", text: "compacted (head-summarize, speculative): 120.0k → 30.5k tokens" },
    { kind: "compaction", text: "compacted (context-drop): 900 → 400 tokens" },
  ]);
});

test("run_end prunes expired touched entries and keeps live ones", () => {
  const s = state();
  run(s);
  start(s, "c1", "read", { path: "src/app.ts" }, T);
  start(s, "c2", "read", { path: "README.md" }, T + 1000);
  applyEvent(s, { type: "run_end", status: "done", summary: "" }, T + 2000);
  expect([...s.files.touched.keys()]).toEqual(["README.md"]);
});

// ---------- files tree ----------

test("setFiles + treeRows: dirs first, case-insensitive order, expanded dirs walk, collapsed dirs with changes flag '·', status-only paths (untracked A / deleted D) join the tree", () => {
  const s = state();
  setFiles(s, ["src\\Zeta.ts", "src/alpha.ts", "src/auth/callback.ts", "lib/x.ts", "b.md", "A.md"], new Map([["src/auth/callback.ts", "M"], ["new.ts", "A"], ["lib/gone.ts", "D"]]));
  expect(s.repo.modified).toBe(3);
  expect(repoModified(s)).toBe(3);
  expect(fileCount(s)).toBe(7); // 6 + new.ts (untracked); gone.ts is not in paths
  const rows = treeRows(s);
  expect(rows.map((r) => `${r.depth}:${r.dir ? "d" : "f"}:${r.name}${r.status ? ":" + r.status : ""}${r.hasChanges ? ":·" : ""}${r.expanded ? ":open" : ""}`)).toEqual([
    "0:d:lib:·", "0:d:src:·", "0:f:A.md", "0:f:b.md", "0:f:new.ts:A",
  ]);
  s.files.expanded.add("src");
  expect(treeRows(s).map((r) => r.path)).toEqual(["lib", "src", "src/auth", "src/alpha.ts", "src/Zeta.ts", "A.md", "b.md", "new.ts"]);
  expect(treeRows(s).find((r) => r.path === "src/auth")).toMatchObject({ dir: true, expanded: false, hasChanges: true });
  expandTo(s, "lib/gone.ts");
  const gone = treeRows(s).find((r) => r.path === "lib/gone.ts");
  expect(gone).toMatchObject({ dir: false, status: "D", depth: 1 });
  expect(treeRows(s).find((r) => r.path === "lib")).toMatchObject({ expanded: true });
  expect(treeRows(s).find((r) => r.path === "lib")!.hasChanges).toBeUndefined(); // open dirs carry no dot
  setFiles(s, [], null);
  expect(treeRows(s)).toEqual([]);
  expect(s.repo.modified).toBe(0);
});

test("treeGuides: tee/end for siblings, bar/blank for open ancestors (app.js guide semantics)", () => {
  const rows: TreeRow[] = [
    { path: "src", name: "src", depth: 0, dir: true, expanded: true },
    { path: "src/auth", name: "auth", depth: 1, dir: true, expanded: true },
    { path: "src/auth/a.ts", name: "a.ts", depth: 2, dir: false },
    { path: "src/auth/b.ts", name: "b.ts", depth: 2, dir: false },
    { path: "src/app.ts", name: "app.ts", depth: 1, dir: false },
    { path: "README.md", name: "README.md", depth: 0, dir: false },
  ];
  expect(treeGuides(rows)).toEqual([[], ["tee"], ["bar", "tee"], ["bar", "end"], ["end"], []]);
  const last: TreeRow[] = [
    { path: "src", name: "src", depth: 0, dir: true, expanded: true },
    { path: "src/auth", name: "auth", depth: 1, dir: true, expanded: true },
    { path: "src/auth/a.ts", name: "a.ts", depth: 2, dir: false },
  ];
  expect(treeGuides(last)).toEqual([[], ["end"], ["blank", "end"]]);
  expect(treeGuides([])).toEqual([]);
});

// ---------- toasts · clock · usage · plan ----------

test("toasts: until = now + 2.6 s, at most six kept, pruned when expired", () => {
  const s = state();
  pushToast(s, "theme · night", T);
  expect(s.toasts).toEqual([{ text: "theme · night", until: T + TOAST_MS, tone: "info" }]);
  expect(TOAST_MS).toBe(2600);
  for (let i = 0; i < 8; i++) pushToast(s, `t${i}`, T + i, "warn");
  expect(s.toasts).toHaveLength(6);
  expect(s.toasts[0]!.text).toBe("t2");
  pruneToasts(s, T + 5 + TOAST_MS);
  expect(s.toasts.map((t) => t.text)).toEqual(["t6", "t7"]);
});

test("fmtClock / fmtK follow engine.js", () => {
  expect(fmtClock(0)).toBe("00:00.0");
  expect(fmtClock(14_000)).toBe("00:14.0");
  expect(fmtClock(61_560)).toBe("01:01.6");
  expect(fmtClock(-5)).toBe("00:00.0");
  expect(fmtK(999)).toBe("999");
  expect(fmtK(4200)).toBe("4.2k");
  expect(fmtK(1_000_000)).toBe("1000.0k");
});

test("usage: contextPercent via core/usage contextHealth (null without a window, clamped at 100, degenerate window = full); setUsage patches only what it is given", () => {
  expect(contextPercent(24_000, 200_000)).toBe(12);
  expect(contextPercent(1, undefined)).toBeNull();
  expect(contextPercent(250_000, 200_000)).toBe(100);
  expect(contextPercent(10, 0)).toBe(100);
  const s = state();
  setUsage(s, { tokensIn: 4200, tokensOut: 1300 });
  expect(s.usage).toMatchObject({ tokensIn: 4200, tokensOut: 1300, contextPct: null, costUsd: null, provider: "openai" });
  setUsage(s, { contextTokens: 24_000, contextWindow: 200_000, costUsd: 0.03, model: "gpt-5-mini" });
  expect(s.usage).toMatchObject({ contextPct: 12, costUsd: 0.03, model: "gpt-5-mini", tokensIn: 4200 });
  setUsage(s, { contextTokens: 5, contextWindow: undefined });
  expect(s.usage.contextPct).toBeNull();
  setUsage(s, { costUsd: null });
  expect(s.usage.costUsd).toBeNull();
});

test("setPlan carries the loader note only when present; planCounts; setCrew copies", () => {
  const s = state();
  setPlan(s, { items: [{ id: "a", content: "x", status: "completed" }, { id: "b", content: "y", status: "in_progress" }], note: "todos.json is not valid JSON — treating the list as empty" });
  expect(s.plan.note).toContain("not valid JSON");
  expect(planCounts(s)).toEqual({ total: 2, pending: 0, inProgress: 1, completed: 1 });
  setPlan(s, { items: [] });
  expect(s.plan).toEqual({ todos: [] });
  const crew = [{ id: "t1", label: "x", agent: "a", goal: "g", isolated: false, depth: 1, status: "running" as const, createdAt: T }];
  setCrew(s, crew);
  expect(s.crew).toEqual(crew);
  expect(s.crew).not.toBe(crew);
});

// ---------- purity ----------

test("negative: the pure modules never read the clock, start timers or touch process; only git-status.ts spawns", () => {
  const dir = join(import.meta.dir, "..", "..", "src", "sextant");
  const code = (f: string) => readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments may name the rule
  for (const f of ["model.ts", "tool-rows.ts", "draw-frame.ts", "draw-plan.ts", "frame.ts", "grid.ts"]) {
    expect(code(f), f).not.toMatch(/Date\.now|setTimeout|setInterval|performance\.now|\bprocess\.|child_process|node:fs/);
  }
  const git = code("git-status.ts");
  expect(git).toMatch(/spawnSync/);
  expect(git).not.toMatch(/Date\.now|setTimeout|setInterval|\bprocess\./);
  // the reducer is a pure function of (state, event, now): same inputs, same outputs
  const a = state(), b = state();
  const events: [RunEvent, number][] = [
    [{ type: "run_start", runId: "r", sessionId: "s", goal: "g" }, T],
    [{ type: "tool_execution_start", callId: "c1", tool: "edit", args: EDIT_ARGS }, T + 1],
    [{ type: "tool_execution_end", callId: "c1", ok: true, output: "applied", durationMs: 3 }, T + 2],
    [{ type: "run_end", status: "done", summary: "ok" }, T + 3],
  ];
  for (const [e, at] of events) { applyEvent(a, e, at); applyEvent(b, e, at); }
  expect(JSON.stringify(a, (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v))).toBe(JSON.stringify(b, (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)));
});

// ------------------------------------------------------------------ the live turn (thinking indicator)

test("live turn: turn_start stamps turnAt + zero tokens; reasoning_update is cumulative, message_update adds the answer estimate; a tool start / turn_end / run_end settles both", () => {
  const s = state(); run(s);
  expect(s.activity.turnAt).toBeUndefined();
  applyEvent(s, { type: "reasoning_update", messageId: "m0", tokens: 7 }, T + 100);
  expect(s.activity.tokens).toBeUndefined(); // no turn in flight yet: nothing to attribute it to
  applyEvent(s, { type: "turn_start", turn: 1 }, T + 500);
  expect(s.activity).toMatchObject({ state: "THINKING", label: "thinking", turnAt: T + 500, tokens: 0 }); // the clock starts at the provider call
  applyEvent(s, { type: "reasoning_update", messageId: "m1", tokens: 120 }, T + 900);
  expect(s.activity).toMatchObject({ state: "THINKING", tokens: 120 });
  expect(s.messages.some((m) => m.kind === "assistant")).toBe(false); // reasoning is not writing: no row, no caret
  applyEvent(s, { type: "reasoning_update", messageId: "m1", tokens: 300 }, T + 1200);
  expect(s.activity.tokens).toBe(300); // replaces, never adds
  applyEvent(s, { type: "message_update", messageId: "m1", delta: "x".repeat(40) }, T + 1300); // 40 chars → 10 tokens
  expect(s.activity).toMatchObject({ state: "WRITING", tokens: 310 });
  applyEvent(s, { type: "message_update", messageId: "m1", delta: "yyyy" }, T + 1400); // 44 → 11
  expect(s.activity.tokens).toBe(311);
  start(s, "c1", "read", { path: "a.ts" }, T + 2000);
  expect(s.activity.turnAt).toBeUndefined(); expect(s.activity.tokens).toBeUndefined(); // a tool runs: the provider turn is over
  applyEvent(s, { type: "tool_execution_end", callId: "c1", ok: true, output: "ok", durationMs: 1 }, T + 2100);
  applyEvent(s, { type: "turn_start", turn: 2 }, T + 2200);
  expect(s.activity).toMatchObject({ turnAt: T + 2200, tokens: 0 }); // fresh per turn
  applyEvent(s, { type: "reasoning_update", messageId: "m2", tokens: 5 }, T + 2300);
  applyEvent(s, { type: "turn_end", turn: 2, stopReason: "end_turn" }, T + 2400);
  expect(s.activity.turnAt).toBeUndefined();
  applyEvent(s, { type: "turn_start", turn: 3 }, T + 2500);
  applyEvent(s, { type: "tool_call_failed", callId: "c9", reason: "permission_denied", detail: "no" }, T + 2550);
  expect(s.activity.turnAt).toBeUndefined();
  applyEvent(s, { type: "turn_start", turn: 4 }, T + 2600);
  applyEvent(s, { type: "run_end", status: "done", summary: "ok" }, T + 2700);
  expect(s.activity.turnAt).toBeUndefined(); expect(s.activity.tokens).toBeUndefined();
});

test("fmtElapsed: whole seconds, then `Nm Ns`, then `Nh Nm` — boundaries at 1 s, 60 s and 1 h; fmtK is the token count's format", () => {
  expect([fmtElapsed(0), fmtElapsed(999), fmtElapsed(1000), fmtElapsed(-5)]).toEqual(["0s", "0s", "1s", "0s"]);
  expect([fmtElapsed(59_999), fmtElapsed(60_000), fmtElapsed(406_000)]).toEqual(["59s", "1m 0s", "6m 46s"]);
  expect([fmtElapsed(3_599_999), fmtElapsed(3_600_000), fmtElapsed(3_900_000), fmtElapsed(36_000_000)]).toEqual(["59m 59s", "1h 0m", "1h 5m", "10h 0m"]);
  expect([fmtK(0), fmtK(999), fmtK(1000), fmtK(11_400)]).toEqual(["0", "999", "1.0k", "11.4k"]);
});
