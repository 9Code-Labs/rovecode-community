/** Sextant model (port #41): the surface state and the pure RunEvent reducer. Ported from the
 *  user's sextant v0.4.0 app.js:100-161 (state S, fileStatus/changedFiles/expandTo, setState/
 *  elapsed/stateLabel, toast) and :272-301 (buildTree/treeRows); the mock session/scenario fields
 *  are replaced by state fed from rovecode's RunEvent stream (core/types.ts:135-149). Pure: `now` is a
 *  parameter, no Date.now()/timers/process access; `applyEvent` mutates the state in place. */

import { contextHealth } from "../core/usage.ts";
import { outstandingClause, outstandingTone } from "../core/loop.ts";
import { estimateTokens } from "../core/context.ts";
import { todoCounts, type TodoItem, type TodoCounts } from "../tools/todo.ts";
import type { TaskInfo } from "../core/tasks.ts";
import type { ActivityState, ApplyEvent, DiffHunk, FileStatus, MessageRow, Notice, SextantState, ThemeName, Toast, ToolRow, TreeRow } from "./types.ts";
import { MAX_NOTICES } from "./types.ts";
import { describeCall, summarizeEnd } from "./tool-rows.ts";

export const TOUCH_MS = 1500;
export const TOAST_MS = 2600;
const MAX_TOASTS = 6;
const NOTE_MAX = 120;

export interface InitOptions {
  cwd: string;
  repo: { name: string; branch: string | null; modified?: number };
  version: string;
  theme: ThemeName;
  mode: "plan" | "act";
  yolo: boolean;
  commands: { name: string; description: string }[];
  now: number;
  /** provider/model shown in the footer and the usage panel */
  model?: { provider: string; model: string };
}

export function initialState(o: InitOptions): SextantState {
  return {
    cwd: o.cwd,
    repo: { name: o.repo.name, branch: o.repo.branch, modified: o.repo.modified ?? 0 },
    files: { paths: [], statuses: new Map(), expanded: new Set(), touched: new Map(), cursor: 0, scroll: 0, version: 0 },
    activity: { state: "IDLE", label: "idle", runId: null, startedAt: null, endedAt: null },
    code: { mode: "code", file: null, content: null, hl: null, scroll: 0, search: null, run: null, diff: null, lane: 0, laneOpen: false },
    messages: [], msgScroll: 0, stick: true, card: null,
    plan: { todos: [] }, crew: [],
    usage: { provider: o.model?.provider ?? "", model: o.model?.model ?? "", turns: 0, tokensIn: 0, tokensOut: 0, contextPct: null, costUsd: null },
    input: { text: "", cur: 0, history: [], histIdx: -1, sgSel: 0 },
    focus: "messages", page: "code", palette: null, market: null, context: null, wizard: null, help: false, toasts: [], notices: [], staged: [], escUntil: 0,
    running: false, mode: o.mode, yolo: o.yolo, theme: o.theme, bootAt: o.now, commands: o.commands, version: o.version,
  };
}

// ------------------------------------------------------------------ reducer

export interface ApplyHooks {
  /** HEAD-vs-disk hunks for an edit/write that landed (the caller owns disk + git I/O); null = none */
  diffFor?: (file: string, tool: string, s: SextantState) => { hunks: DiffHunk[]; add: number; del: number } | null;
}
interface CallInfo { tool: string; verb: string; path: string | null; add: number; del: number; cmd: string | null }

/** `now` is passed on ERROR transitions only — it stamps activity.errorAt (the pet's storm trigger) */
const setActivity = (s: SextantState, state: ActivityState, label: string, now?: number): void => {
  s.activity.state = state; s.activity.label = label;
  if (state === "ERROR" && now !== undefined) s.activity.errorAt = now;
};
const pushRow = (s: SextantState, row: MessageRow): void => { s.messages.push(row); s.stick = true; };
function finalizeAssistant(s: SextantState): void { for (const r of s.messages) if (r.kind === "assistant") r.streaming = false; }
function findRow(s: SextantState, callId: string): ToolRow | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) { const r = s.messages[i]!; if (r.kind === "tool" && r.callId === callId) return r; }
  return undefined;
}
const anyRunning = (s: SextantState): boolean => s.messages.some((r) => r.kind === "tool" && r.running);
function appendNote(detail: string | undefined, note: string): string {
  const n = note.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  const joined = detail ? `${detail} · ${n}` : n;
  const cps = [...joined];
  return cps.length > NOTE_MAX ? "…" + cps.slice(cps.length - NOTE_MAX + 1).join("") : joined;
}
function showFile(s: SextantState, path: string, hl: [number, number] | null): void {
  if (s.code.file !== path) { s.code.content = null; s.code.scroll = 0; }
  s.code.mode = "code"; s.code.file = path; s.code.hl = hl;
}

/** Build the reducer; `hooks` supply what the pure model cannot compute (real diff hunks). */
export function makeApplyEvent(hooks: ApplyHooks = {}): ApplyEvent {
  const calls = new Map<string, CallInfo>();
  let sawText = false;
  /** cumulative reasoning tokens of the turn in flight (reasoning_update); the answer side is the streaming row's text */
  let reasoning = 0;
  const liveTokens = (s: SextantState): void => {
    if (s.activity.turnAt === undefined) return;
    const last = s.messages[s.messages.length - 1];
    s.activity.tokens = reasoning + (last && last.kind === "assistant" && last.streaming ? estimateTokens(last.text) : 0);
  };
  /** the provider turn is over (a tool runs, the turn or the run ended): the live line goes with it */
  const settleTurn = (s: SextantState): void => { delete s.activity.turnAt; delete s.activity.tokens; };
  return (s, ev, now) => {
    switch (ev.type) {
      case "run_start":
        s.activity = { state: "THINKING", label: "thinking", runId: ev.runId, startedAt: now, endedAt: null };
        s.running = true; s.stick = true; sawText = false; reasoning = 0; calls.clear();
        break;
      case "turn_start":
        finalizeAssistant(s); setActivity(s, "THINKING", "thinking"); s.usage.turns += 1;
        s.activity.turnAt = now; s.activity.tokens = 0; reasoning = 0; // the live line's clock starts at the provider call, not the keystroke
        break;
      case "message_update": {
        const last = s.messages[s.messages.length - 1];
        if (last && last.kind === "assistant" && last.streaming) last.text += ev.delta;
        else { finalizeAssistant(s); pushRow(s, { kind: "assistant", text: ev.delta, streaming: true, id: ev.messageId }); }
        sawText = true; setActivity(s, "WRITING", "writing");
        liveTokens(s);
        break;
      }
      case "reasoning_update":
        reasoning = ev.tokens; liveTokens(s);
        break;
      case "tool_execution_start": {
        finalizeAssistant(s); settleTurn(s);
        const d = describeCall(ev.tool, ev.args, s.cwd);
        calls.set(ev.callId, { tool: ev.tool, verb: d.verb, path: d.path, add: d.add, del: d.del, cmd: d.cmd });
        const row: ToolRow = { kind: "tool", callId: ev.callId, tool: ev.tool, verb: d.verb, label: d.label, running: true };
        if (d.path) row.path = d.path;
        if (d.verb === "edit" || d.verb === "write") { row.add = d.add; row.del = d.del; }
        pushRow(s, row);
        setActivity(s, d.state, d.activity);
        if (d.path && d.touch) { s.files.touched.set(d.path, now + TOUCH_MS); expandTo(s, d.path); s.files.version++; }
        if (d.path && (d.verb === "read" || d.verb === "edit" || d.verb === "write")) showFile(s, d.path, d.hl);
        if (d.verb === "run") { s.code.mode = "run"; s.code.run = { cmd: d.cmd ?? d.label, lines: [], status: "running" }; }
        if (d.verb === "search") { s.code.mode = "search"; s.code.search = { query: d.label, lines: [] }; }
        break;
      }
      case "tool_execution_update": {
        const row = findRow(s, ev.callId);
        if (row) row.detail = appendNote(row.detail, ev.note);
        break;
      }
      case "tool_execution_end": {
        const info = calls.get(ev.callId); calls.delete(ev.callId);
        let row = findRow(s, ev.callId);
        if (!row) { row = { kind: "tool", callId: ev.callId, tool: info?.tool ?? "tool", verb: info?.verb ?? "other", label: info?.tool ?? ev.callId, running: true }; pushRow(s, row); }
        row.running = false; row.ok = ev.ok; row.ms = ev.durationMs;
        const end = summarizeEnd({ verb: row.verb }, row.tool, ev.ok, ev.output);
        if (end.detail) row.detail = end.detail;
        if (end.runLines && s.code.run && (!info?.cmd || s.code.run.cmd === info.cmd)) {
          s.code.run.lines = end.runLines; s.code.run.status = ev.ok ? "ok" : "fail";
          if (end.exitCode !== undefined) s.code.run.exitCode = end.exitCode;
        }
        if (end.searchLines && s.code.search) s.code.search.lines = end.searchLines;
        if (ev.ok && info?.path && (row.verb === "edit" || row.verb === "write")) {
          if (row.verb === "write") addPath(s, info.path);
          const diff = hooks.diffFor?.(info.path, row.tool, s) ?? null;
          if (diff) { row.add = diff.add; row.del = diff.del; s.code.diff = { file: info.path, ...diff }; s.code.mode = "diff"; }
        }
        if (!ev.ok) setActivity(s, "ERROR", `${row.verb} failed`, now);
        else if (!anyRunning(s)) setActivity(s, "THINKING", "thinking");
        break;
      }
      case "tool_call_failed": {
        calls.delete(ev.callId); settleTurn(s);
        const row = findRow(s, ev.callId);
        const reason = ev.reason.replace(/_/g, " ");
        if (row) { row.running = false; row.ok = false; row.detail = reason; }
        pushRow(s, { kind: "system", tone: "error", text: `${reason}: ${ev.detail}` });
        const what = ev.reason === "permission_denied" ? "denied" : reason;
        setActivity(s, "ERROR", row ? `${row.label} ${what}` : what, now);
        notify(s, row ? `${row.label} ${what}` : `tool ${what}`, now, "error", "error");
        break;
      }
      case "compaction":
        pushRow(s, { kind: "compaction", text: `compacted (${ev.strategy}${ev.trigger ? `, ${ev.trigger}` : ""}): ${fmtK(ev.tokensBefore)} → ${fmtK(ev.tokensAfter)} tokens` });
        break;
      case "steer":
        pushRow(s, { kind: "steer", text: ev.text });
        break;
      case "verify": // the verify gate (core/verify-gate.ts): the check is running / how it ended, one row each
        pushRow(s, { kind: "system", tone: ev.state === "running" || ev.state === "passed" ? "info" : "warn", text: ev.state === "running" ? `⧗ verify: ${ev.command}` : `verify ${ev.state}: ${ev.detail ?? ""}` });
        break;
      case "turn_end":
        finalizeAssistant(s); settleTurn(s);
        break;
      case "run_end": {
        finalizeAssistant(s); settleTurn(s);
        if (ev.status === "done") {
          setActivity(s, "SUCCESS", "done");
          if (!sawText && ev.summary) pushRow(s, { kind: "assistant", text: ev.summary, streaming: false });
          // "done" is the model's silence, not a verdict — one clause says what the transcript left (core/loop.ts)
          const left = ev.outstanding ? outstandingClause(ev.outstanding) : null;
          const tone = ev.outstanding ? outstandingTone(ev.outstanding) : "info";
          if (left !== null) pushRow(s, { kind: "system", tone, text: `done · ${left}` });
          notify(s, left !== null ? `run done · ${left}` : "run done", now, tone, "done");
        } else if (ev.status === "error") {
          setActivity(s, "ERROR", "error", now);
          if (ev.summary) pushRow(s, { kind: "system", tone: "error", text: ev.summary });
          notify(s, `run failed${ev.summary ? `: ${ev.summary.split("\n")[0]!.slice(0, 80)}` : ""}`, now, "error", "error");
        } else {
          setActivity(s, "IDLE", ev.status);
          pushRow(s, { kind: "system", tone: "warn", text: `run ${ev.status}: ${ev.summary}` });
          notify(s, `run ${ev.status}`, now, "warn", "done");
        }
        s.activity.endedAt = now; s.running = false;
        for (const r of s.messages) if (r.kind === "tool" && r.running) { r.running = false; r.ok = false; r.detail ??= "interrupted"; }
        { const pre = s.files.touched.size; for (const [p, until] of s.files.touched) if (until <= now) s.files.touched.delete(p); if (s.files.touched.size !== pre) s.files.version++; }
        calls.clear();
        break;
      }
    }
  };
}
/** the default reducer instance (no diff hook) */
export const applyEvent: ApplyEvent = makeApplyEvent();

// ------------------------------------------------------------------ files tree

/** deterministic, locale-independent order: case-insensitive, then raw */
export const pathCompare = (a: string, b: string): number => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};
const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\/+/, "");

/** Replace the file list + git statuses (null statuses = no git); the header count follows. */
export function setFiles(s: SextantState, paths: readonly string[], statuses: ReadonlyMap<string, FileStatus> | null): void {
  s.files.paths = [...new Set(paths.map(normPath).filter(Boolean))].sort(pathCompare);
  s.files.statuses = new Map(statuses ? [...statuses].map(([p, st]) => [normPath(p), st] as const) : []);
  s.repo.modified = s.files.statuses.size;
  s.files.version++;
}
function addPath(s: SextantState, path: string): void {
  if (s.files.paths.includes(path)) return;
  s.files.paths.push(path); s.files.paths.sort(pathCompare); s.files.version++;
}
/** open every ancestor directory of `path` */
export function expandTo(s: SextantState, path: string): void {
  const parts = path.split("/");
  let added = false;
  for (let i = 1; i < parts.length; i++) { const seg = parts.slice(0, i).join("/"); if (!s.files.expanded.has(seg)) { s.files.expanded.add(seg); added = true; } }
  if (added) s.files.version++;
}
export const repoModified = (s: SextantState): number => s.files.statuses.size;
/** files shown in the tree (tracked ∪ status-only paths, minus deleted) */
export function fileCount(s: SextantState): number {
  const all = new Set(s.files.paths);
  for (const [p, st] of s.files.statuses) if (st === "D") all.delete(p); else all.add(p);
  return all.size;
}

interface Node { name: string; path: string; kids: Map<string, Node> | null }

// keyed on the FilesState object too: two states with the same version (tests, a second surface) must not share rows
let _treeCache: { files: SextantState["files"]; version: number; expSz: number; now: number; rows: TreeRow[] } | null = null;
/** Flatten the tree (dirs first, expanded set honored); GUIDE glyphs are the drawer's job. */
export function treeRows(s: SextantState, now = -1): TreeRow[] {
  const expSz = s.files.expanded.size;
  if (_treeCache && _treeCache.files === s.files && _treeCache.version === s.files.version && _treeCache.expSz === expSz && _treeCache.now === now) return _treeCache.rows;
  const all = new Set(s.files.paths);
  for (const p of s.files.statuses.keys()) all.add(p);
  const root: Node = { name: "", path: "", kids: new Map() };
  for (const p of [...all].sort(pathCompare)) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let kid = node.kids!.get(part);
      if (!kid) { kid = { name: part, path: parts.slice(0, i + 1).join("/"), kids: leaf ? null : new Map() }; node.kids!.set(part, kid); }
      else if (!leaf && !kid.kids) kid.kids = new Map();
      node = kid;
    });
  }
  const changed = (n: Node): boolean => (n.kids ? [...n.kids.values()].some(changed) : s.files.statuses.has(n.path));
  const rows: TreeRow[] = [];
  const walk = (n: Node, depth: number): void => {
    const kids = [...n.kids!.values()].sort((x, y) => Number(!!y.kids) - Number(!!x.kids) || pathCompare(x.name, y.name));
    for (const k of kids) {
      if (k.kids) {
        const open = s.files.expanded.has(k.path);
        const row: TreeRow = { path: k.path, name: k.name, depth, dir: true, expanded: open };
        if (!open && changed(k)) row.hasChanges = true;
        rows.push(row);
        if (open) walk(k, depth + 1);
      } else {
        const row: TreeRow = { path: k.path, name: k.name, depth, dir: false };
        const st = s.files.statuses.get(k.path); if (st) row.status = st;
        const t = s.files.touched.get(k.path); if (t !== undefined) row.touchedUntil = t;
        rows.push(row);
      }
    }
  };
  walk(root, 0);
  _treeCache = { files: s.files, version: s.files.version, expSz, now, rows };
  return rows;
}

export type Guide = "bar" | "tee" | "end" | "blank";
/** Per-row connector kinds (app.js treeRows `guides`): one entry per depth level ≥ 1. */
export function treeGuides(rows: readonly TreeRow[]): Guide[][] {
  const n = rows.length;
  const last = new Array<boolean>(n).fill(true);
  const open: boolean[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = rows[i]!.depth;
    last[i] = !open[d];
    open[d] = true; open.length = d + 1;
  }
  const out: Guide[][] = [];
  const ancLast: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const d = rows[i]!.depth; ancLast[d] = last[i]!;
    const g: Guide[] = [];
    for (let k = 1; k <= d; k++) g.push(k === d ? (last[i] ? "end" : "tee") : ancLast[k] ? "blank" : "bar");
    out.push(g);
  }
  return out;
}

// ------------------------------------------------------------------ toasts · clock · usage · plan

export function pushToast(s: SextantState, text: string, now: number, tone: Toast["tone"] = "info"): void {
  s.toasts.push({ text, until: now + TOAST_MS, tone });
  if (s.toasts.length > MAX_TOASTS) s.toasts.splice(0, s.toasts.length - MAX_TOASTS);
}

/** A notification: a toast now AND a Notice in the history, so it can be read after the toast fades.
 *  Berkay's four triggers — a run finishing, a failed tool, a card waiting, plus a history — all come
 *  through here; a bare pushToast stays for the renderer-local "unknown theme" class of message that
 *  nobody needs to read back. */
export function notify(s: SextantState, text: string, now: number, tone: Toast["tone"] = "info", kind: Notice["kind"] = "info"): void {
  pushToast(s, text, now, tone);
  const id = (s.notices[s.notices.length - 1]?.id ?? 0) + 1;
  s.notices.push({ id, at: now, tone, kind, text, read: false });
  if (s.notices.length > MAX_NOTICES) s.notices.splice(0, s.notices.length - MAX_NOTICES);
}
export function unreadNotices(s: SextantState): number { return s.notices.reduce((n, x) => n + (x.read ? 0 : 1), 0); }
export function markNoticesRead(s: SextantState): void { for (const n of s.notices) n.read = true; }
export function pruneToasts(s: SextantState, now: number): void {
  if (s.toasts.some((t) => t.until <= now)) s.toasts = s.toasts.filter((t) => t.until > now);
}
/** run timer: frozen at endedAt once the run ends; 0 before any run */
export function elapsed(s: SextantState, now: number): number {
  const a = s.activity;
  return a.startedAt === null ? 0 : Math.max(0, (a.endedAt ?? now) - a.startedAt);
}
/** mm:ss.t (engine.js fmtClock) */
export function fmtClock(ms: number): string {
  const sec = Math.max(0, ms) / 1000, m = Math.floor(sec / 60), r = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}
/** 4200 → "4.2k" (engine.js fmtK) */
export const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.max(0, Math.round(n))));
/** whole seconds for the live line: "0s" · "59s" · "1m 0s" · "6m 46s" · "1h 0m" — the run clock keeps
 *  fmtClock's mm:ss.t; this one is read in prose next to a word and a count, so it drops the tenths */
export function fmtElapsed(ms: number): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec - m * 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface UsagePatch {
  provider?: string; model?: string; effort?: string; turns?: number; tokensIn?: number; tokensOut?: number;
  /** estimated tokens in the context + the model's window (undefined window → pct unknown) */
  contextTokens?: number; contextWindow?: number | undefined;
  costUsd?: number | null;
}
/** 0..100 estimated fill via core/usage.ts contextHealth; null when the window is unknown */
export function contextPercent(used: number, window: number | undefined): number | null {
  if (window === undefined) return null;
  return Math.min(100, Math.round(contextHealth(used, window).fraction * 100));
}
export function setUsage(s: SextantState, u: UsagePatch): void {
  if (u.provider !== undefined) s.usage.provider = u.provider;
  if (u.model !== undefined) s.usage.model = u.model;
  if (u.effort !== undefined) s.usage.effort = u.effort;
  if (u.turns !== undefined) s.usage.turns = u.turns;
  if (u.tokensIn !== undefined) s.usage.tokensIn = u.tokensIn;
  if (u.tokensOut !== undefined) s.usage.tokensOut = u.tokensOut;
  if ("contextTokens" in u || "contextWindow" in u) {
    s.usage.contextPct = contextPercent(u.contextTokens ?? 0, u.contextWindow);
    if (u.contextTokens !== undefined) s.usage.contextTokens = u.contextTokens;
    if (u.contextWindow !== undefined) s.usage.contextWindow = u.contextWindow; else delete s.usage.contextWindow;
  }
  if (u.costUsd !== undefined) s.usage.costUsd = u.costUsd;
}
/** loadTodos() result → plan panel (a corrupt file arrives as empty + note, never throws) */
export function setPlan(s: SextantState, loaded: { items: TodoItem[]; note?: string }): void {
  s.plan = loaded.note ? { todos: loaded.items, note: loaded.note } : { todos: loaded.items };
}
export const planCounts = (s: SextantState): TodoCounts => todoCounts(s.plan.todos);
export function setCrew(s: SextantState, tasks: readonly TaskInfo[]): void { s.crew = [...tasks]; }
