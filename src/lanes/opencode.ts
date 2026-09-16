/** opencode lane adapter (#47) — agentic-clis.md §2 "opencode · opencode run", flags verified 2026-09-02:
 *    opencode run "<goal>" --format json --dir <dir>     (+ -s <session> · + --attach <url> · + -m <model>)
 *  LIVE-VERIFIED 2026-09-03 against opencode 1.18.23 on Windows (fixture opencode-live-run.jsonl): `--format
 *  json` prints FLAT lines `{type, timestamp, sessionID, part}` where `type` is the part kind — `step_start`,
 *  `text`, `tool_use`, `step_finish` (reasoning parts: same shape, not yet seen live) — and `part` is the SDK
 *  part object (`part.type` step-start | text | tool | step-finish). Text parts arrive once, complete
 *  (`time.end`); a tool part carries `tool`, `state.{status,input,output,metadata}`; a step-finish part
 *  carries `reason` ("tool-calls" = more steps follow, "stop" = the turn is over — the process then exits 0,
 *  there is NO idle event) plus `tokens{input,output,cache{read,write}}` and `cost` (per step: summed by the
 *  runner). A provider that cannot be reached prints NOTHING (opencode retries it in its own log file) —
 *  the job's silent-lane note and the wall-clock cutter are the only signals. The `{type:"message.part.*",
 *  properties:{part}}` / `session.idle` / `permission.*` shapes below are the SDK `client.event.subscribe()`
 *  stream (synthetic fixture opencode.jsonl, the future `opencode serve` port) — kept, not live-verified.
 *  Permissions live in opencode's own config (`permission: "allow"` on the verified box auto-approved the
 *  write; an ask under `--format json` was not observed). SIGINT ends the turn → interruptFirst. */

import type { AgentAdapter, LaneCommand, LaneEvent, LaneOpts, LaneParseState, LaneTask } from "./types.ts";
import { clip, num, obj, parseJsonLine, str, toolEvent, usageFrom } from "./events.ts";

function argv(prompt: string, opts: LaneOpts, session?: string): LaneCommand {
  const args = ["run", prompt, "--format", "json", "--dir", opts.cwd];
  if (session) args.push("-s", session);
  if (opts.attach) args.push("--attach", opts.attach);
  if (opts.model) args.push("-m", opts.model);
  return { bin: "opencode", args, cwd: opts.cwd };
}

/** the flat `run --format json` line types (1.18.23) — each carries the part under `part` */
const FLAT: ReadonlySet<string> = new Set(["step_start", "step-start", "text", "reasoning", "tool_use", "tool", "step_finish", "step-finish"]);

type Seen = Record<string, string>;
const seen = (st: LaneParseState): Seen => (st.scratch["parts"] ??= {}) as Seen;
const ref = (st: LaneParseState): { sessionId?: string } => (st.sessionId ? { sessionId: st.sessionId } : {});

function part(p: Record<string, unknown>, st: LaneParseState): LaneEvent[] {
  const sid = str(p["sessionID"]) ?? str(p["sessionId"]);
  if (sid) st.sessionId = sid;
  const type = str(p["type"]);
  switch (type) {
    case "text": case "reasoning": {
      // parts are re-sent as they grow: emit a text part once, when it is finished (time.end) or
      // carries no timing at all, and never the same text twice for one part id
      const text = (str(p["text"]) ?? "").trim();
      const time = obj(p["time"]);
      if (!text || (time && time["end"] === undefined)) return [];
      const id = str(p["id"]) ?? text;
      if (seen(st)[id] === text) return [];
      seen(st)[id] = text;
      if (type === "reasoning") return [{ kind: "log", text: `thinking: ${clip(text, 160)}` }];
      st.lastText = text;
      return [{ kind: "log", text }];
    }
    case "tool": {
      const state = obj(p["state"]);
      const status = str(state?.["status"]);
      const name = str(p["tool"]) ?? "tool";
      if (status === "error") return [{ kind: "log", text: `tool ${name} error: ${clip(str(state?.["error"]) ?? str(state?.["output"]), 120)}` }];
      if (status !== "completed") return [];
      const exit = num(obj(state?.["metadata"])?.["exit"]);
      // one tool part is updated repeatedly (running → completed, fixture opencode.jsonl lines 2-3 share
      // callID call_1): the CLI's own callID is the dedupe key, and `completed` is what makes a write real
      const callId = str(p["callID"]) ?? str(p["id"]);
      return [toolEvent(name, obj(state?.["input"]), clip(str(state?.["output"]), 120) || undefined, exit, { wrote: true, ...(callId !== undefined ? { callId } : {}) })];
    }
    case "step-finish": case "step_finish": {
      const usage = usageFrom(p["tokens"], p);
      const out: LaneEvent[] = usage ? [{ kind: "usage", usage }] : [];
      // live: "tool-calls" → another step follows; "stop" → the turn is complete (the CLI exits right after)
      const reason = str(p["reason"]);
      if (reason === "stop") out.push({ kind: "done", summary: st.lastText ?? "", ...ref(st) });
      else if (reason === "error" || reason === "length" || reason === "content-filter") out.push({ kind: "fail", error: `step finished: ${reason}`, ...ref(st) });
      return out;
    }
    default:
      return [];
  }
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  interruptFirst: true,
  command: (task: LaneTask, opts: LaneOpts) => argv(task.goal, opts, opts.resume),
  resume: (sessionId: string, followUp: string, opts: LaneOpts) => argv(followUp, opts, sessionId),
  permissionSummary: (opts) => `permissions per opencode config (asks surface as lane events)${opts.attach ? ` · attach ${opts.attach}` : ""} · worktree`,
  parse(line: string, st: LaneParseState): LaneEvent[] {
    const o = parseJsonLine(line);
    const type = o ? str(o["type"]) : undefined;
    if (!o || !type) { st.garbage++; return []; }
    const props = obj(o["properties"]) ?? o;
    const sid = str(props["sessionID"]) ?? str(props["sessionId"]) ?? str(obj(props["info"])?.["sessionID"]);
    if (sid) st.sessionId = sid;
    // the CLI's flat shape (verified): the part rides at the top level
    if (FLAT.has(type)) {
      const p = obj(o["part"]);
      return p ? part(p, st) : [];
    }
    if (type.startsWith("message.part.")) {
      const p = obj(props["part"]) ?? obj(o["part"]);
      return p ? part(p, st) : [];
    }
    if (type.startsWith("permission.")) {
      const title = str(props["title"]) ?? str(obj(props["permission"])?.["title"]) ?? str(props["type"]) ?? "permission";
      return [{ kind: "ask", text: title }];
    }
    switch (type) {
      case "message.updated": {
        const info = obj(props["info"]);
        const usage = usageFrom(info?.["tokens"], info);
        return usage && str(info?.["role"]) !== "user" ? [{ kind: "usage", usage }] : [];
      }
      case "session.idle":
        return [{ kind: "done", summary: st.lastText ?? "", ...ref(st) }];
      case "session.error": case "error": {
        const e = obj(props["error"]) ?? obj(o["error"]);
        const message = str(obj(e?.["data"])?.["message"]) ?? str(e?.["message"]) ?? str(props["message"]) ?? str(e?.["name"]) ?? "error";
        return [{ kind: "fail", error: message, ...ref(st) }];
      }
      default:
        return [];
    }
  },
};
