/** claude code lane adapter (#47) — agentic-clis.md §2 "claude code · claude -p", verified 2026-09-02:
 *    claude --bare -p "<goal>" --output-format stream-json --verbose --permission-mode acceptEdits
 *           --allowedTools "<list>"            (+ --resume <session_id> · + --model <m>)
 *  `--bare` loads no hooks/skills/MCP/CLAUDE.md (the CI shape) and — live-verified 2026-09-03 against
 *  claude 2.1.257 on Windows — authenticates STRICTLY with ANTHROPIC_API_KEY (`--help`: "OAuth and
 *  keychain are never read"): without a key it exits 1 in ~3 s with `apiKeySource: "none"` and a
 *  `result` whose `is_error` is true while its `subtype` still says "success" (fixture
 *  claude-live-auth-failed.jsonl). So `--bare` is emitted only when `opts.bare !== false`; the registry
 *  turns it off when the lane env carries no ANTHROPIC_API_KEY, and the lane then runs on the CLI's own
 *  login (hooks/MCP/CLAUDE.md load; `system/hook_*` events appear). `--verbose` is mandatory for
 *  stream-json. Permissions are the lane's flags: acceptEdits auto-accepts file edits in the worktree,
 *  `--allowedTools` rules (e.g. `Bash(npm test)`) grant the rest; anything else is denied in -p mode and
 *  surfaces as `permission_denials` on the result. Events (§3): system/init → log (session id, model),
 *  system/hook_* → log, assistant text → log (an `is_api_error_message` line → `api error: …`),
 *  tool_use Edit/Write → edit (issued), a tool_result WITHOUT is_error → edit wrote:true (the write
 *  confirmed, progress.ts counts it there), Bash → bash, a failed tool_result → log, result → usage (total_cost_usd +
 *  usage) then done (is_error:false) | fail. SIGINT finishes the turn, SIGTERM exits 143 → interruptFirst. */

import type { AgentAdapter, LaneCommand, LaneEvent, LaneOpts, LaneParseState, LaneTask } from "./types.ts";
import { arr, clip, contentText, isObj, obj, parseJsonLine, str, toolEvent, toolPath, toolShape, usageFrom } from "./events.ts";

/** acceptEdits already covers these; stating them keeps the card honest about what the lane may do */
export const CLAUDE_DEFAULT_ALLOW: readonly string[] = ["Read", "Edit", "Write"];

const allowOf = (opts: LaneOpts): string[] => [...(opts.allowlist ?? CLAUDE_DEFAULT_ALLOW)];

/** the card's auth word: `--bare` runs on ANTHROPIC_API_KEY alone (the token is never read under --bare);
 *  otherwise the CLI's own login — `oauth token` when the lane env carries CLAUDE_CODE_OAUTH_TOKEN, else `cli login` */
const authOf = (opts: LaneOpts): string => (opts.bare !== false ? "bare" : opts.oauthToken === true ? "oauth token" : "cli login");

function argv(prompt: string, opts: LaneOpts, resume?: string): LaneCommand {
  const allow = allowOf(opts);
  const args = [...(opts.bare === false ? [] : ["--bare"]), "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  if (allow.length > 0) args.push("--allowedTools", allow.join(","));
  if (opts.model) args.push("--model", opts.model);
  if (resume) args.push("--resume", resume);
  return { bin: "claude", args, cwd: opts.cwd };
}

/** tool_use id → what that call was, so the tool_result can be read as a confirmation. The path is kept
 *  because claude reports the write only at the CALL: without it a `tool_result` cannot say WHICH file
 *  was written, and progress.ts would have to count the call instead — which is the thing it must not do. */
type PendingCall = { name: string; path: string };
type Pending = Record<string, PendingCall>;
const pending = (st: LaneParseState): Pending => (st.scratch["tools"] ??= {}) as Pending;

function assistant(o: Record<string, unknown>, st: LaneParseState): LaneEvent[] {
  const out: LaneEvent[] = [];
  for (const b of arr(obj(o["message"])?.["content"])) {
    if (!isObj(b)) continue;
    if (b["type"] === "text") {
      const text = (str(b["text"]) ?? "").trim();
      if (text) { st.lastText = text; out.push({ kind: "log", text }); }
    } else if (b["type"] === "tool_use") {
      const name = str(b["name"]) ?? "tool", id = str(b["id"]);
      const input = obj(b["input"]);
      if (id) pending(st)[id] = { name, path: toolPath(input) };
      // the CALL: no `wrote` — claude confirms nothing until the matching tool_result arrives
      out.push(toolEvent(name, input, undefined, undefined, id ? { callId: id } : {}));
    }
  }
  return out;
}

function toolResults(o: Record<string, unknown>, st: LaneParseState): LaneEvent[] {
  const out: LaneEvent[] = [];
  for (const b of arr(obj(o["message"])?.["content"])) {
    if (!isObj(b) || b["type"] !== "tool_result") continue;
    const id = str(b["tool_use_id"]) ?? "";
    const call = pending(st)[id];
    const name = call?.name ?? "tool";
    delete pending(st)[id];
    const text = clip(contentText(b["content"]), 120);
    const failed = b["is_error"] === true;
    const shape = toolShape(name);
    // THE CONFIRMATION: a result for an edit/write call that did not carry is_error is claude saying the
    // file changed. Anthropic sets is_error only on failure, so "absent" is success (fixture: two of the
    // three results carry no is_error at all). This replaces the result LOG line for a successful write —
    // the same one line, now structured — while a failure keeps the log line and its reason.
    if (!failed && call !== undefined && (shape === "edit" || shape === "write") && call.path !== "?") {
      out.push({ kind: "edit", path: call.path, op: shape === "write" ? "write" : "edit", wrote: true, ...(id ? { callId: id } : {}) });
      continue;
    }
    out.push({ kind: "log", text: `${name} ${failed ? "error" : "result"}${text ? `: ${text}` : ""}` });
  }
  return out;
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  interruptFirst: true,
  command: (task: LaneTask, opts: LaneOpts) => argv(task.goal, opts, opts.resume),
  resume: (sessionId: string, followUp: string, opts: LaneOpts) => argv(followUp, opts, sessionId),
  permissionSummary: (opts) => `permission-mode acceptEdits · allow: ${allowOf(opts).join(",") || "none"} · ${authOf(opts)} · worktree`,
  parse(line: string, st: LaneParseState): LaneEvent[] {
    const o = parseJsonLine(line);
    const type = o ? str(o["type"]) : undefined;
    if (!o || !type) { st.garbage++; return []; }
    const sid = str(o["session_id"]);
    if (sid) st.sessionId = sid;
    switch (type) {
      case "system": {
        const sub = str(o["subtype"]) ?? "?";
        // live shape (non-bare): hook_started / hook_response carry hook_name (+ outcome on the response)
        if (sub === "hook_started" || sub === "hook_response") return [{ kind: "log", text: `hook ${str(o["hook_name"]) ?? "?"} ${sub === "hook_started" ? "started" : str(o["outcome"]) ?? "responded"}` }];
        if (sub !== "init") return [{ kind: "log", text: `system ${sub}` }];
        return [{ kind: "log", text: `init · model ${str(o["model"]) ?? "?"} · ${arr(o["tools"]).length} tools${sid ? ` · session ${sid}` : ""}` }];
      }
      case "assistant":
        // live shape: an API failure arrives as a synthetic assistant message (`model: "<synthetic>"`,
        // `error`, `is_api_error_message: true`) BEFORE the is_error result — shown as an error, never
        // kept as lastText (a done summary must not read "Not logged in")
        if (o["is_api_error_message"] === true) return [{ kind: "log", text: `api error: ${clip(contentText(obj(o["message"])?.["content"]), 160) || str(o["error"]) || "?"}${str(o["error"]) ? ` (${str(o["error"])})` : ""}` }];
        return assistant(o, st);
      case "user": return toolResults(o, st);
      case "result": {
        const out: LaneEvent[] = [];
        const usage = usageFrom(o["usage"], o);
        if (usage) out.push({ kind: "usage", usage });
        const text = str(o["result"]) ?? "";
        const ref = st.sessionId ? { sessionId: st.sessionId } : {};
        if (o["is_error"] === true) out.push({ kind: "fail", error: text || `result ${str(o["subtype"]) ?? "error"}`, ...ref });
        else out.push({ kind: "done", summary: text || st.lastText || "", ...ref });
        return out;
      }
      default: return [];
    }
  },
};
