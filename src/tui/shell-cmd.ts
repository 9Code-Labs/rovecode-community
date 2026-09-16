/** `!cmd` shell mode: a prompt line that starts with `!` runs in the workspace shell through the ONE bash tool
 *  dispatch — ToolRegistry.dispatch with the session's permission rules and the very approval chain a model-issued
 *  `bash` call gets (permission rules → execpolicy → the approval hook → the human's card, cli/runtime.ts buildCfg)
 *  behind the configured executor rung. Never a direct spawn, never a second policy path: the composer's `!` is a
 *  convenience over the same door, not a way around it. The caller passes ITS human approver, so the surface's own
 *  behaviour — the diff preview, the "all edits" door — applies here too rather than being reimplemented.
 *
 *  No model turn starts. The command and its output are appended to the session as a user message the model reads
 *  on its NEXT turn (shellRecord), so `!bun test` followed by "fix it" gives the model the failure without a tool
 *  round-trip. Both surfaces share this module: a renderer with `onEvent` (sextant) builds its rows from the
 *  dispatch events; one without (the classic pi-tui) gets the tool card pair plus a bounded output block.
 *
 *  Pattern source (Apache-2.0, PATTERN ONLY, no code copied): gemini-cli packages/cli/src/ui/hooks/
 *  useGeminiStream.ts (shell mode short-circuits the prompt before any model call) and atCommandProcessor.ts (a
 *  client-initiated tool call whose result is folded into the user turn).
 *
 *  Rules: `!` alone, `! x` (a space after the bang) and `!!x` are plain text for the model — the ONE classifier is
 *  sextant/overlays.ts parseInput; a busy run refuses the line (the record would fork the run's chain); staged
 *  /attach images never ride on a shell record; and a call refused BEFORE execution (a rule, execpolicy, a hook, a
 *  denied card) leaves no record at all — the model learns only what actually ran. */

import { randomUUID } from "node:crypto";
import type { Runtime } from "../cli/runtime.ts";
import type { SessionStore } from "../core/session.ts";
import type { ApprovalFn, Message, PermissionLevel, RunEvent, ToolCallPart, ToolContext, ToolOutput } from "../core/types.ts";
import { parseInput } from "../sextant/overlays.ts";
import type { Renderer } from "./renderer.ts";

/** the classic block shows this many output lines; the session record keeps the tool's full (≤10k) text */
export const OUTPUT_BLOCK_LINES = 40;
const OPEN = "<user_shell_command>", CLOSE = "</user_shell_command>", OUT_OPEN = "<user_shell_output", OUT_CLOSE = "</user_shell_output>";

/** The command of a `!cmd` line, or null when the line is plain text (sextant/overlays.ts parseInput). */
export function shellLine(text: string): string | null {
  const p = parseInput(text);
  return p.kind === "shell" && p.cmd ? p.cmd : null;
}

export interface ShellCtx {
  renderer: Renderer;
  rt: Pick<Runtime, "registry" | "hooks" | "buildCfg" | "cwd">;
  /** the ACTIVE store, read live */
  store(): SessionStore;
  /** the session's permission level, exactly as a model turn would run under */
  level(): PermissionLevel;
  /** the surface's own human approver (undefined under `auto`, where nothing is asked) */
  approve(): ApprovalFn | undefined;
  /** the app's busy flag (a live run, or another `!cmd`) */
  busy(): boolean;
  /** flip the app's busy flag (+ status) around the command */
  setBusy(b: boolean): void;
  /** the app's interrupt target — Esc / ⌃c / quit abort it; bound for the command's lifetime, then cleared */
  bindAbort(ac: AbortController | null): void;
}

const head = (cmd: string): string => { const one = cmd.replace(/\s+/g, " ").trim(); return one.length > 40 ? one.slice(0, 39) + "…" : one; };

type FailedEvent = Extract<RunEvent, { type: "tool_call_failed" }>;
export const REFUSED_DETAIL = "refused by a permission rule, exec policy or an approval hook (no approval prompt)";

/** the event BOTH surfaces get for a call refused before execution. `asked` = the human saw the card and denied —
 *  the raw event stands, its "user denied" is true; otherwise the chain settled it alone (a forbidden argv, a hook
 *  deny) and dispatch's generic "user denied" would misreport a policy stop as the person's choice. */
function refusal(ev: FailedEvent, asked: boolean): FailedEvent {
  return !asked && ev.detail === "user denied" ? { ...ev, detail: REFUSED_DETAIL } : ev;
}

/** Run one `!cmd` line. Echoes the typed line, dispatches the bash tool with the session's rules and approval
 *  chain, records what ran, settles the surface — and never starts a model turn. */
export async function runShellLine(ctx: ShellCtx, line: string): Promise<void> {
  const cmd = shellLine(line);
  if (cmd === null) return;
  const { renderer } = ctx;
  if (ctx.busy()) { renderer.addSystemNote("finish or interrupt the run first (Esc) — `!cmd` runs only while the agent is idle", "warn"); return; }
  renderer.addUser(line.trim());
  const ac = new AbortController();
  ctx.setBusy(true);
  ctx.bindAbort(ac);
  renderer.setBusy(true, `running ${head(cmd)}…`);
  const call: ToolCallPart = { kind: "tool_call", id: `shell-${randomUUID().slice(0, 8)}`, tool: "bash", args: { command: cmd } };
  let asked = false, executed = false;
  // the SAME chain a model-issued bash call gets: buildCfg wraps the surface's approver in the rules, execpolicy
  // and the hooks. The wrapper only records that the human was reached, so the refusal text can tell the truth.
  const human = ctx.approve();
  const cfg = ctx.rt.buildCfg(ctx.level(), human === undefined ? undefined : async (req) => { asked = true; return human(req); });
  const toolCtx: ToolContext = { sessionId: ctx.store().id, cwd: ctx.rt.cwd, signal: ac.signal, permissions: { effect: "allow" } };
  // onEvent FIRST — a renderer that has it owns the rows and ignores the card calls below; the classic surface
  // paints its `→ bash` / `← ok|FAIL` pair from them. Both are built from the ONE corrected event.
  const emit = (raw: RunEvent): void => {
    const ev = raw.type === "tool_call_failed" ? refusal(raw, asked) : raw;
    renderer.onEvent?.(ev);
    if (ev.type === "tool_execution_start") renderer.toolStart(ev.callId, ev.tool, JSON.stringify(ev.args).slice(0, 120));
    else if (ev.type === "tool_execution_update") renderer.toolUpdate(ev.callId, ev.note);
    else if (ev.type === "tool_execution_end") { executed = true; renderer.toolEnd(ev.callId, ev.ok, ev.output.slice(0, 160).replace(/\n/g, " ⏎ "), ev.durationMs); }
    else if (ev.type === "tool_call_failed") renderer.toolEnd(ev.callId, false, `${ev.reason}: ${ev.detail}`.slice(0, 160), 0);
  };
  let out: ToolOutput = { ok: false, output: "" };
  try {
    // no loop guard: the person's own repeats are not a model loop and must not count toward its streak
    out = await ctx.rt.registry.dispatch(call, toolCtx, ctx.rt.hooks, cfg.permissionRules, cfg.approval, emit, undefined);
    if (executed) {
      const store = ctx.store();
      const staged = store.stagedAttachments; // /attach images ride on the next TYPED message, never on a shell record
      store.stageAttachments([]);
      store.append(shellRecord(cmd, out, store.messages().at(-1)?.id ?? null));
      store.stageAttachments(staged);
      if (!renderer.onEvent) renderer.addSystemNote(outputBlock(out.output), out.ok ? "info" : "warn");
    } else {
      const why = ac.signal.aborted ? "was interrupted before it ran" : asked ? "was denied at the approval card" : "was refused before any approval prompt (a permission rule, exec policy or a hook)";
      renderer.addSystemNote(`\`${head(cmd)}\` ${why} — nothing ran, nothing recorded`, "warn");
    }
  } finally {
    ctx.bindAbort(null);
    renderer.setBusy(false, executed && out.ok ? "done" : "error");
    ctx.setBusy(false);
  }
}

/** The session record the model reads next turn: a role:"user" message —
 *  `<user_shell_command>\n$ <cmd>\n</user_shell_command>\n<user_shell_output exit="N">\n<output>\n</user_shell_output>`
 *  — exit = the bash tool's `exit=N` header (`?` when the output carries none), output = the rest. */
export function shellRecord(cmd: string, out: ToolOutput, parentId: string | null): Message {
  const m = /^exit=(-?\d+)\r?\n?/.exec(out.output);
  const exit = m ? m[1]! : "?";
  const body = (m ? out.output.slice(m[0].length) : out.output).replace(/\r?\n$/, "");
  const text = [OPEN, `$ ${cmd}`, CLOSE, `${OUT_OPEN} exit="${exit}">`, ...(body ? [body] : []), OUT_CLOSE].join("\n");
  return { id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() };
}

const RECORD_RE = /^<user_shell_command>\n\$ ([\s\S]*?)\n<\/user_shell_command>\n<user_shell_output exit="(-?\d+|\?)">\n(?:([\s\S]*?)\n)?<\/user_shell_output>$/;

/** the inverse of shellRecord for transcript replay; null for any other user text */
export function parseShellRecord(text: string): { cmd: string; exit: string; output: string } | null {
  const m = RECORD_RE.exec(text);
  return m ? { cmd: m[1]!, exit: m[2]!, output: m[3] ?? "" } : null;
}

/** the classic surface's output block: the tool's text (its `exit=N` header first), at most OUTPUT_BLOCK_LINES lines */
export function outputBlock(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, OUTPUT_BLOCK_LINES);
  const more = lines.length - shown.length;
  return shown.join("\n") + (more > 0 ? `\n… ${more} more line${more === 1 ? "" : "s"} (the session record keeps the full output)` : "");
}

let replaySeq = 0;
/** Transcript replay of a stored shell record: the typed `!cmd` line, then the bash tool card pair the live run
 *  showed. false = not a record. */
export function replayShellRecord(renderer: Renderer, text: string): boolean {
  const r = parseShellRecord(text);
  if (!r) return false;
  const id = `shell-replay-${++replaySeq}`;
  renderer.addUser(`!${r.cmd}`);
  renderer.toolStart(id, "bash", JSON.stringify({ command: r.cmd }).slice(0, 120));
  // the record's exact text as the preview: an empty output is `exit=N` alone, never a dangling line break
  renderer.toolEnd(id, r.exit === "0", [`exit=${r.exit}`, ...(r.output ? [r.output] : [])].join("\n").slice(0, 160).replace(/\n/g, " ⏎ "), 0);
  return true;
}
