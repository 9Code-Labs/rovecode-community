/** antigravity (`agy`) lane adapter (#47) — agentic-clis.md §2 "antigravity · agy", verified 2026-09-02:
 *    agy -p "<goal>" --output-format stream-json --print-timeout 15m
 *        (+ --dangerously-skip-permissions ONLY on an explicit allow-all · + --conversation <id> · + --model <m>)
 *  `--print-timeout` mirrors the lane's wall-clock budget (default 15m; the CLI's own default is 5m).
 *  Permission model: without `--dangerously-skip-permissions` a tool that needs approval is SOFT-DENIED
 *  and the run still exits 0 — so a `result.status: SUCCESS` is NOT proof of work: the job layer
 *  cross-checks the worktree diff and attaches `emptyDiffNote` when nothing changed. Events (§3):
 *  init → log, step_update text_delta → log (per completed line), tool steps → bash|edit, result
 *  SUCCESS → done, ERROR|INVALID → fail, result meta → usage. No SIGINT-finishes-turn contract →
 *  interruptFirst false. */

import type { AgentAdapter, LaneCommand, LaneEvent, LaneOpts, LaneParseState, LaneTask } from "./types.ts";
import { clip, obj, parseJsonLine, str, toolEvent, usageFrom } from "./events.ts";

export const AGY_SOFT_DENY_NOTE =
  "agy reported SUCCESS but the lane's worktree has no changes — a tool that needed approval was probably soft-denied (agy exits 0); " +
  "re-run with an explicit allow-all (--dangerously-skip-permissions) or grant it in ~/.gemini/antigravity-cli/settings.json permissions.allow";

/** `--print-timeout` takes minutes; the lane budget rounds UP so the CLI never cuts before the runner */
export const printTimeout = (timeoutMs: number): string => `${Math.max(1, Math.ceil(timeoutMs / 60_000))}m`;

function argv(prompt: string, opts: LaneOpts, conversation?: string): LaneCommand {
  const args = ["-p", prompt, "--output-format", "stream-json", "--print-timeout", printTimeout(opts.timeoutMs)];
  if (opts.allowAll === true) args.push("--dangerously-skip-permissions");
  if (opts.model) args.push("--model", opts.model);
  if (conversation) args.push("--conversation", conversation);
  return { bin: "agy", args, cwd: opts.cwd };
}

/** text deltas accumulate; complete lines become log events, the remainder flushes on `result` */
function flushText(st: LaneParseState, delta: string, final: boolean): LaneEvent[] {
  let buf = (str(st.scratch["text"]) ?? "") + delta;
  const out: LaneEvent[] = [];
  const emit = (line: string): void => { const t = line.trim(); if (t) { st.lastText = t; out.push({ kind: "log", text: t }); } };
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) { emit(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  if (final) { emit(buf); buf = ""; }
  st.scratch["text"] = buf;
  return out;
}

function step(o: Record<string, unknown>, st: LaneParseState): LaneEvent[] {
  const delta = str(o["text_delta"]) ?? str(obj(o["step"])?.["text_delta"]);
  if (delta !== undefined) return flushText(st, delta, false);
  const s = obj(o["step"]) ?? o;
  const tool = obj(s["tool"]) ?? obj(s["tool_call"]);
  const name = str(tool?.["name"]) ?? str(s["tool_name"]) ?? str(s["name"]);
  const kind = str(o["step_type"]) ?? str(s["step_type"]) ?? "";
  if (!name || !/tool/.test(kind) && !tool) return [];
  const input = obj(tool?.["args"]) ?? obj(tool?.["input"]) ?? obj(s["tool_input"]) ?? obj(s["args"]) ?? obj(s["input"]);
  const output = str(tool?.["output"]) ?? str(s["tool_output"]) ?? str(s["output"]);
  // NO `wrote`, deliberately, and no callId to give: agy's step_update carries neither a result for a
  // write nor an id for the call (fixture agy.jsonl line 4 is the whole record of a write_file). Its own
  // header already says `result.status: SUCCESS` is not proof of work, so an agy lane reports 0 files
  // written while it runs; the worktree diff at the end is the only thing that can name them (job.ts).
  return [toolEvent(name, input, output ? clip(output, 120) : undefined)];
}

export const agyAdapter: AgentAdapter = {
  id: "agy",
  interruptFirst: false,
  emptyDiffNote: AGY_SOFT_DENY_NOTE,
  command: (task: LaneTask, opts: LaneOpts) => argv(task.goal, opts, opts.resume),
  resume: (sessionId: string, followUp: string, opts: LaneOpts) => argv(followUp, opts, sessionId),
  permissionSummary: (opts) => opts.allowAll === true
    ? "--dangerously-skip-permissions (every tool auto-approved) · worktree"
    : "soft-deny (tools needing approval are refused, exit 0 — diff is cross-checked) · worktree",
  parse(line: string, st: LaneParseState): LaneEvent[] {
    const o = parseJsonLine(line);
    const type = o ? str(o["type"]) : undefined;
    if (!o || !type) { st.garbage++; return []; }
    const sid = str(o["conversation_id"]) ?? str(o["session_id"]) ?? str(o["conversationId"]);
    if (sid) st.sessionId = sid;
    const ref = (): { sessionId?: string } => (st.sessionId ? { sessionId: st.sessionId } : {});
    switch (type) {
      case "init":
        return [{ kind: "log", text: `init · model ${str(o["model"]) ?? "?"}${st.sessionId ? ` · conversation ${st.sessionId}` : ""}` }];
      case "step_update":
        return step(o, st);
      case "result": {
        const out = flushText(st, "", true);
        const usage = usageFrom(o["usage"] ?? o["stats"] ?? obj(o["metadata"])?.["usage"], o);
        if (usage) out.push({ kind: "usage", usage });
        const status = str(o["status"]) ?? "?";
        const response = (str(o["response"]) ?? "").trim();
        if (status === "SUCCESS") out.push({ kind: "done", summary: response || st.lastText || "", ...ref() });
        else out.push({ kind: "fail", error: response || (str(o["error"]) ?? str(o["message"]) ?? `result ${status}`), ...ref() });
        return out;
      }
      case "error":
        return [{ kind: "fail", error: str(o["message"]) ?? str(obj(o["error"])?.["message"]) ?? "error", ...ref() }];
      default:
        return [];
    }
  },
};
