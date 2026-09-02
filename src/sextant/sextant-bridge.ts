/** Sextant bridge (port #44): pure helpers between aion's app/Renderer seam and the surface state —
 *  a user line → row (image chips split off), a replayed tool card → row, how many duplicate app
 *  notes a RunEvent triggers (the #41 reducer already produced the row), and the RunEvent / TaskInfo
 *  → nimbus forwarding table (#45's report: start/read/edit/write/remove/run/glob/grep/plan/spawn on
 *  starts + observe over written content and edit newLines; tool_fail/pass/fail + a fail-line
 *  reaction on tool ends; denied on a permission refusal; done/stopped/error at run_end; laneDone /
 *  laneFail from the task manager). Pure: `now` is a parameter, no I/O, no timers. */

import type { RunEvent } from "../core/types.ts";
import type { TaskInfo } from "../core/tasks.ts";
import type { Pet, PetEventData } from "./pet.ts";
import { baseName, describeCall, relPath } from "./tool-rows.ts";
import type { MessageRow, ToolRow } from "./types.ts";

type UserRow = Extract<MessageRow, { kind: "user" }>;
const CHIP_RE = /\[image: ([^\]]*)\]/g;
const TEST_CMD = /\b(tests?|vitest|jest|pytest|mocha|spec)\b/i;
const RUN_TOOLS = new Set(["bash", "shell", "run"]);
const REMOVE_TOOLS = new Set(["remove", "rm", "delete", "unlink"]);

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, max = 40): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** tui/attach.ts userTurnLine: the text, then ONE line of `[image: name]` chips (or chips alone) */
export function userRow(line: string, now: number): UserRow {
  const lines = line.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const chips = [...last.matchAll(CHIP_RE)].map((m) => m[1]!);
  const chipLine = chips.length > 0 && last.replace(CHIP_RE, "").trim() === "";
  const row: UserRow = { kind: "user", text: (chipLine ? lines.slice(0, -1) : lines).join("\n"), at: now };
  if (chipLine) row.images = chips;
  return row;
}

/** args for a replayed tool card: session-cmd replayTranscript hands the renderer a ≤120-char JSON
 *  slice — the whole object when it still parses, else the path/command/pattern/url/question/label
 *  fields recovered from the intact prefix (a truncated escape yields nothing for that key) */
export function argsFromPreview(preview: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(preview);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* truncated — fall through */ }
  const out: Record<string, unknown> = {};
  for (const k of ["path", "command", "pattern", "url", "question", "label"]) {
    const m = new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`).exec(preview);
    if (!m) continue;
    try { out[k] = JSON.parse(`"${m[1]}"`); } catch { /* unterminated escape */ }
  }
  return out;
}

/** a replayed tool card (the renderer is NOT busy: session history) → a settled row; toolEnd fills ok/detail */
export function replayToolRow(callId: string, tool: string, argsPreview: string, cwd: string): ToolRow {
  const d = describeCall(tool, argsFromPreview(argsPreview), cwd);
  const row: ToolRow = { kind: "tool", callId, tool, verb: d.verb, label: d.label, running: false };
  if (d.path) row.path = d.path;
  if (d.verb === "edit" || d.verb === "write") { row.add = d.add; row.del = d.del; }
  return row;
}

/** how many addSystemNote calls app.ts makes for this event that duplicate a reducer row: the
 *  compaction note, "↪ steering applied", and the run_end error/warn line (none for `done`) — the
 *  renderer drops exactly that many, and only those */
export function duplicateNotes(ev: RunEvent): number {
  if (ev.type === "compaction" || ev.type === "steer") return 1;
  if (ev.type === "run_end") return ev.status === "done" ? 0 : 1;
  return 0;
}

/** what the renderer remembers per live call so the end event can find its tool/command */
export interface LiveCall { tool: string; cmd: string }

/** RunEvent → nimbus (see the header table) */
export function petOnEvent(pet: Pet, ev: RunEvent, calls: Map<string, LiveCall>, cwd: string, now: number): void {
  switch (ev.type) {
    case "run_start": pet.event("start", undefined, now); break;
    case "tool_execution_start": {
      const a = rec(ev.args), f = baseName(relPath(cwd, str(a.path))) || "file";
      calls.set(ev.callId, { tool: ev.tool, cmd: str(a.command) || str(a.cmd) });
      petOnStart(pet, ev.tool, a, f, now);
      break;
    }
    case "tool_execution_end": {
      const c = calls.get(ev.callId);
      calls.delete(ev.callId);
      petOnEnd(pet, c, ev.ok, ev.output, now);
      break;
    }
    case "tool_call_failed":
      calls.delete(ev.callId);
      pet.event(ev.reason === "permission_denied" ? "denied" : "tool_fail", undefined, now);
      break;
    case "run_end":
      calls.clear();
      pet.event(ev.status === "done" ? "done" : ev.status === "error" ? "error" : "stopped", undefined, now);
      break;
    default: break;
  }
}

function petOnStart(pet: Pet, tool: string, a: Record<string, unknown>, f: string, now: number): void {
  const data: PetEventData = { f };
  if (tool === "read") pet.event("read", data, now);
  else if (tool === "edit") {
    pet.event("edit", data, now);
    const lines = (Array.isArray(a.edits) ? a.edits : []).flatMap((e) => { const nl = rec(e).newLines; return Array.isArray(nl) ? nl.map(String) : []; });
    if (lines.length) pet.observe(lines.join("\n"), "ins", now);
  } else if (tool === "write") { pet.event("write", data, now); if (str(a.content)) pet.observe(str(a.content), "ins", now); }
  else if (REMOVE_TOOLS.has(tool)) pet.event("remove", data, now);
  else if (RUN_TOOLS.has(tool)) pet.event("run", undefined, now);
  else if (tool === "glob") pet.event("glob", undefined, now);
  else if (tool === "todo_write") { const n = Array.isArray(a.todos) ? a.todos.length : 0; if (n) pet.event("plan", { n }, now); }
  else if (tool === "task") pet.event("spawn", { a: oneLine(str(a.label) || str(a.agent) || "a worker", 20) }, now);
}

function petOnEnd(pet: Pet, c: LiveCall | undefined, ok: boolean, output: string, now: number): void {
  if (c && RUN_TOOLS.has(c.tool)) {
    const lines = output.replace(/^exit=-?\d+\r?\n?/, "").split(/\r?\n/).filter((l) => l.trim());
    const r = oneLine(lines[lines.length - 1] ?? "");
    if (TEST_CMD.test(c.cmd)) pet.event(ok ? "pass" : "fail", { r }, now);
    else if (!ok) pet.event("tool_fail", undefined, now);
    if (lines.some((l) => /^\s*FAIL\b/.test(l))) pet.react("fail-line", now);
    else if (ok && lines.some((l) => /^\s*PASS\b/.test(l))) pet.react("pass-line", now);
    return;
  }
  if (!ok) { pet.event("tool_fail", undefined, now); return; }
  if (c?.tool === "grep") pet.event("grep", { n: output.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("(")).length }, now);
}

/** TaskManager status transitions → laneDone / laneFail quips (queued/running/cancelled say nothing) */
export function petOnTask(pet: Pet, t: TaskInfo, now: number): void {
  if (t.status === "done") pet.event("laneDone", { a: oneLine(t.label, 20), r: oneLine(t.summary ?? "done") }, now);
  else if (t.status === "failed") pet.event("laneFail", { a: oneLine(t.label, 20), r: oneLine(t.error ?? "failed") }, now);
}
