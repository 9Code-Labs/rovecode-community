/** codex lane adapter (#47) — agentic-clis.md §2 "codex · codex exec", verified 2026-09-02:
 *    codex -a never exec --json --sandbox workspace-write -C <dir> -o <lastfile> "<goal>"
 *  `-a/--ask-for-approval never` must come BEFORE `exec` (exec falls to never anyway); stdout is the
 *  JSONL event stream under `--json`; `-o` writes the final message to a file; `--skip-git-repo-check`
 *  lets the copy-isolation fallback (a non-git root) run; `--ephemeral` is deliberately NOT passed so
 *  `exec resume <SESSION_ID>` stays possible. Permissions are granted UP FRONT by the sandbox flag —
 *  nothing can ask mid-run, which is why the card states them before start. Events (§3):
 *  thread.started → session id, item.* agent_message/reasoning → log, command_execution → bash,
 *  file_change → edit, todo_list (plan) → progress, turn.completed → usage + done, turn.failed / error
 *  → fail. No documented SIGINT-finishes-turn contract → interruptFirst false (straight tree kill). */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, LaneCommand, LaneEvent, LaneOpts, LaneParseState, LaneTask } from "./types.ts";
import { arr, clip, isObj, num, obj, parseJsonLine, str, usageFrom } from "./events.ts";

export const CODEX_DEFAULT_SANDBOX = "workspace-write";

function lastFile(opts: LaneOpts): string {
  if (opts.lastMessageFile) return opts.lastMessageFile;
  let h = 0;
  for (const c of opts.cwd) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return join(tmpdir(), `rovecode-codex-last-${h.toString(16)}.md`);
}

function argv(prompt: string, opts: LaneOpts, resume?: string): LaneCommand {
  const args = ["-a", "never", "exec"];
  if (resume) args.push("resume", resume);
  args.push("--json", "--sandbox", opts.sandbox ?? CODEX_DEFAULT_SANDBOX, "-C", opts.cwd, "-o", lastFile(opts), "--skip-git-repo-check");
  if (opts.model) args.push("-m", opts.model);
  args.push(prompt);
  return { bin: "codex", args, cwd: opts.cwd };
}

const OPS: Record<string, "edit" | "write" | "delete"> = { add: "write", create: "write", update: "edit", modify: "edit", delete: "delete", remove: "delete" };

function item(phase: string, it: Record<string, unknown>, st: LaneParseState): LaneEvent[] {
  const type = str(it["type"]) ?? "";
  const completed = phase === "item.completed";
  switch (type) {
    case "agent_message": {
      const text = (str(it["text"]) ?? "").trim();
      if (!completed || !text) return [];
      st.lastText = text;
      return [{ kind: "log", text }];
    }
    case "reasoning": {
      const text = (str(it["text"]) ?? "").trim();
      return completed && text ? [{ kind: "log", text: `thinking: ${clip(text, 160)}` }] : [];
    }
    case "command_execution": {
      const command = str(it["command"]) ?? "?";
      // ONE call reported twice (item.started, then item.completed) under one item.id — the id is what
      // stops progress.ts counting it as two (fixture codex.jsonl lines 4-5: item_1 both times)
      const callId = str(it["id"]);
      const idPart = callId !== undefined ? { callId } : {};
      if (phase === "item.started") return [{ kind: "bash", command, ...idPart }];
      if (!completed) return [];
      const ev: LaneEvent = { kind: "bash", command, ...idPart };
      const code = num(it["exit_code"]);
      if (code !== undefined) ev.exitCode = code;
      const out = clip(str(it["aggregated_output"]), 120);
      if (out) ev.output = out;
      return [ev];
    }
    case "file_change": {
      // codex reports a change only once it HAS happened (`item.completed`, status completed), so this is
      // a confirmation and every path in it counts as written
      if (!completed) return [];
      const callId = str(it["id"]);
      return arr(it["changes"]).filter(isObj).map((c) => ({
        kind: "edit" as const, path: str(c["path"]) ?? "?", op: OPS[str(c["kind"]) ?? ""] ?? "edit", wrote: true as const,
        ...(callId !== undefined ? { callId } : {}),
      }));
    }
    case "todo_list": {
      const items = arr(it["items"]).filter(isObj);
      const done = items.filter((x) => x["completed"] === true).length;
      const next = items.find((x) => x["completed"] !== true);
      return [{ kind: "progress", text: `plan ${done}/${items.length}${next ? ` · ${clip(str(next["text"]), 100)}` : " · complete"}` }];
    }
    case "mcp_tool_call":
      return completed ? [{ kind: "log", text: `mcp ${str(it["server"]) ?? "?"}.${str(it["tool"]) ?? "?"} ${str(it["status"]) ?? "completed"}` }] : [];
    case "web_search":
      return completed ? [{ kind: "log", text: `search: ${clip(str(it["query"]), 120)}` }] : [];
    default:
      return [];
  }
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  interruptFirst: false,
  command: (task: LaneTask, opts: LaneOpts) => argv(task.goal, opts, opts.resume),
  resume: (sessionId: string, followUp: string, opts: LaneOpts) => argv(followUp, opts, sessionId),
  permissionSummary: (opts) => `sandbox ${opts.sandbox ?? CODEX_DEFAULT_SANDBOX} · approval never · worktree`,
  parse(line: string, st: LaneParseState): LaneEvent[] {
    const o = parseJsonLine(line);
    const type = o ? str(o["type"]) : undefined;
    if (!o || !type) { st.garbage++; return []; }
    const sid = (): Pick<LaneEvent & { kind: "done" }, "sessionId"> => (st.sessionId ? { sessionId: st.sessionId } : {});
    switch (type) {
      case "thread.started": {
        const id = str(o["thread_id"]);
        if (id) st.sessionId = id;
        return [{ kind: "log", text: `thread ${id ?? "?"}` }];
      }
      case "item.started": case "item.updated": case "item.completed": {
        const it = obj(o["item"]);
        return it ? item(type, it, st) : [];
      }
      case "turn.completed": {
        const out: LaneEvent[] = [];
        const usage = usageFrom(o["usage"]);
        if (usage) out.push({ kind: "usage", usage });
        out.push({ kind: "done", summary: st.lastText ?? "", ...sid() });
        return out;
      }
      case "turn.failed":
        return [{ kind: "fail", error: str(obj(o["error"])?.["message"]) ?? str(o["error"]) ?? "turn failed", ...sid() }];
      case "error":
        return [{ kind: "fail", error: str(o["message"]) ?? str(obj(o["error"])?.["message"]) ?? "error", ...sid() }];
      default:
        return [];
    }
  },
};
