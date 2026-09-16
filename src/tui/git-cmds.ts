/** `/commit` and `/undo` (port #65). Pattern sources, no code copied: aider `cmd_commit` / `cmd_undo`
 *  (Apache-2.0 — research/source_snapshots/Aider-AI-aider/aider/commands.py:337-350 dirty-check → model-drafted
 *  message unless one is given; :553-640 undo = restore the files the last change touched and say what moved) and
 *  opencode `messages_undo` / session revert (MIT — packages/opencode/src/session/revert.ts: files go back to a
 *  snapshot; deviation here: the conversation is left untouched).
 *
 *  /commit — the staged diff (the working-tree diff of tracked files when nothing is staged, with a note; `commit -a`
 *  then) is collected, the COMMIT router role drafts a conventional message (`rt.router.resolve("commit")` —
 *  ROVECODE_MODEL_COMMIT, else the default chain; ONE stream invocation, no agent loop), the message rides in the
 *  approval card's detail, and `git commit -m <message>` runs through the ONE bash tool dispatch — ToolRegistry.dispatch
 *  under the session's permission rules and buildCfg's approval chain (lane → execpolicy → approval hook → the human
 *  card), exactly like a model-issued or `!cmd` bash call (ADR-005; shell-cmd.ts idiom). `/commit <message>` skips the
 *  draft (no model call). The argv never carries --amend or --no-verify. EVERY git invocation here — the diffs too — goes
 *  through that dispatch: this module owns no spawn path (pinned by a source grep in its test); read-only git argv is
 *  allow-listed by execpolicy, so the diffs never prompt. A denied card commits nothing and puts `/commit <draft>` in
 *  the prompt so the message can be edited and resubmitted.
 *
 *  /undo — steps the workspace back ONE snapshot through the existing Checkpoints.restore(hash, "files") after a
 *  confirmation card listing what will change; the transcript is untouched (a conversation rewind stays /restore's job).
 *  Snapshots land AFTER each mutating tool call, so the last one IS the agent's latest change: when the workspace still
 *  matches a snapshot (Checkpoints.position) the target is that snapshot's nearest differing ancestor — the pre-edit
 *  state — and a second /undo walks one more back (or notes that nothing older differs); a workspace that drifted from
 *  the last snapshot (your own edits, an interrupted run's partial writes) goes back to the last snapshot first,
 *  discarding the drift. No checkpoint → a note. */

import { randomUUID } from "node:crypto";
import type { Runtime } from "../cli/runtime.ts";
import type { Checkpoint } from "../coding/checkpoints.ts";
import { OUTPUT_CAP_CHARS } from "../core/executor.ts"; // the bash tool's output cap — a constant, not a spawn path
import { partsText } from "../core/loop.ts";
import type { SessionStore } from "../core/session.ts";
import type { AssistantTurn, Message, ModelRef, RunEvent, ToolCallPart, ToolContext } from "../core/types.ts";
import type { Renderer } from "./renderer.ts";
import type { ApprovalFn } from "../core/types.ts";
import { REFUSED_DETAIL } from "./shell-cmd.ts";

export interface GitCmdCtx {
  renderer: Renderer;
  rt: Pick<Runtime, "registry" | "hooks" | "buildCfg" | "cwd" | "stream" | "router" | "checkpointsFor">;
  /** the surface's own human approver — undefined under `auto`/yolo, where nothing is asked. /commit's
   *  card, like a model-issued bash call's, only exists when the session has an approver at all. */
  approve(): ApprovalFn | undefined;
  /** the ACTIVE store, read live */
  store(): SessionStore;
  yolo(): boolean;
  /** the app's busy flag (a live run, a `!cmd`, or another git command) */
  busy(): boolean;
  setBusy(b: boolean): void;
  /** the app's interrupt target — Esc / ⌃c abort the command; bound for its lifetime, then cleared */
  bindAbort(ac: AbortController | null): void;
}

const BUSY_NOTE = "finish or interrupt the run first (Esc) — /commit and /undo run only while the agent is idle";
/** the bash tool caps its output (OUTPUT_CAP_CHARS): a capped diff is flagged to the model and on the card */
const CAP_NOTE = "(diff truncated at the 10k output cap for the model)";
/** a dash-led message word would reach git as a flag (the quoting keeps bare dash-led words) — refused before any git call */
const DASH_NOTE = "a commit message cannot start with -; quote it or begin with a word — git would read a dash-led message as a flag, so nothing was committed";

export const COMMIT_SYSTEM =
  "You write git commit messages. Reply with the commit message only: a first line `type(scope): summary` in the imperative mood, " +
  "at most 72 characters, type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style; then, only when the change needs it, " +
  "one blank line and a short body. No quotes, no code fences, no commentary.";

// ------------------------------------------------------------------ shell quoting + git through the seam

/** POSIX single-quoting for one argv word (the executor runs the line through bash); safe words pass bare */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** the exact bash line a git argv becomes — exported so tests can pin the emitted command */
export function gitCommand(args: readonly string[]): string {
  return ["git", ...args.map(shellQuote)].join(" ");
}

export interface GitResult {
  /** the bash tool ran (a refusal — policy, hook, a denied card — leaves it false) */
  executed: boolean;
  /** the human saw the approval card */
  asked: boolean;
  /** the tool's `exit=N` header; -1 when absent */
  exit: number;
  /** the output minus that header */
  body: string;
  /** the body filled the bash tool's output cap — a diff this long is a prefix, not the whole change */
  capped: boolean;
  command: string;
}

/** One git invocation through the ONE bash tool dispatch — the session's rules + buildCfg's approval chain; `detail`
 *  is what the approval card shows above the verdicts (the drafted commit message). Never spawns anything itself. */
export async function runGit(ctx: GitCmdCtx, args: readonly string[], signal: AbortSignal, detail?: string): Promise<GitResult> {
  const command = gitCommand(args);
  const call: ToolCallPart = { kind: "tool_call", id: `git-${randomUUID().slice(0, 8)}`, tool: "bash", args: { command } };
  let asked = false, executed = false;
  // the SAME chain a model-issued bash call gets: buildCfg wraps the surface's approver in the rules,
  // execpolicy and the hooks. The wrapper IS the card: /commit's detail (the drafted message) is what
  // the card shows above the verdicts, and `asked` records that the human was reached so a policy
  // refusal is never misreported as their denial.
  const human = ctx.approve();
  const cfg = ctx.rt.buildCfg(ctx.yolo(), human === undefined ? undefined : async (req) => {
    asked = true;
    return (await ctx.renderer.askApproval(req.tool, JSON.stringify(req.revisedArgs).slice(0, 140), detail)) === "deny" ? "deny" : "once";
  });
  const toolCtx: ToolContext = { sessionId: ctx.store().id, cwd: ctx.rt.cwd, signal, permissions: { effect: "allow" } };
  const { renderer } = ctx;
  // the app's per-event Renderer calls (shell-cmd.ts idiom): onEvent FIRST for a renderer that owns its rows (sextant);
  // a policy refusal (no card) is corrected to the honest detail so neither surface says "user denied" for it
  const emit = (raw: RunEvent): void => {
    const ev = raw.type === "tool_call_failed" && !asked && raw.detail === "user denied" ? { ...raw, detail: REFUSED_DETAIL } : raw;
    renderer.onEvent?.(ev);
    if (ev.type === "tool_execution_start") renderer.toolStart(ev.callId, ev.tool, JSON.stringify(ev.args).slice(0, 120));
    else if (ev.type === "tool_execution_update") renderer.toolUpdate(ev.callId, ev.note);
    else if (ev.type === "tool_execution_end") { executed = true; renderer.toolEnd(ev.callId, ev.ok, ev.output.slice(0, 160).replace(/\n/g, " ⏎ "), ev.durationMs); }
    else if (ev.type === "tool_call_failed") renderer.toolEnd(ev.callId, false, `${ev.reason}: ${ev.detail}`.slice(0, 160), 0);
  };
  // no loop guard: the user's own commands are not a model loop
  const out = await ctx.rt.registry.dispatch(call, toolCtx, ctx.rt.hooks, cfg.permissionRules, cfg.approval, emit, undefined);
  const m = /^exit=(-?\d+)\r?\n?/.exec(out.output);
  const raw = m ? out.output.slice(m[0].length) : out.output;
  return { executed, asked, exit: m ? Number(m[1]) : -1, body: raw.replace(/\r\n/g, "\n"), capped: raw.length >= OUTPUT_CAP_CHARS, command };
}

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";
const refusalNote = (r: GitResult, signal: AbortSignal): string =>
  signal.aborted ? "was interrupted before it ran" : r.asked ? "was denied at the approval card" : "was refused before any approval prompt (exec policy, a permission rule or a hook)";
/** a failed git call as one honest line: the first real output line (the executor's `stderr:` label skipped); outside a
 *  repository `git diff` degrades to `--no-index` usage (exit 129) or says "not a git repository" (128) — name the cwd then */
export function gitFailure(r: GitResult, cwd: string): string {
  const line = r.body.split("\n").map((l) => l.trim()).find((l) => l !== "" && l !== "stderr:") ?? "no output";
  const notRepo = /not a git repository|--no-index/.test(r.body);
  return `${r.command.split(" ").slice(0, 2).join(" ")} failed (exit ${r.exit}): ${line}${notRepo ? ` — ${cwd} is not inside a git repository` : ""}`;
}

// ------------------------------------------------------------------ the commit message

/** strip the wrappers models add around a message: code fences, surrounding quotes, a `commit message:` label */
export function cleanMessage(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n").trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  t = t.replace(/^commit message:\s*/i, "");
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t.split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** ONE stream invocation on the COMMIT role's model (router: ROVECODE_MODEL_COMMIT, else the default chain) — a system
 *  message + the diff; the terminal turn's text is the draft. Errors come back structured, never thrown. */
export async function draftMessage(ctx: GitCmdCtx, diff: string, model: ModelRef, signal: AbortSignal): Promise<{ text: string } | { error: string }> {
  const stream = ctx.rt.stream;
  if (!stream) return { error: "no provider configured — nothing can draft a message" };
  const now = Date.now();
  const sys: Message = { id: randomUUID(), role: "system", parts: [{ kind: "text", text: COMMIT_SYSTEM }], parentId: null, createdAt: now };
  const user: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: `Write the commit message for this diff:\n\n${diff}` }], parentId: sys.id, createdAt: now };
  let turn: AssistantTurn | null = null;
  try { for await (const ev of stream(model, [sys, user], { signal })) if (ev.type === "turn") turn = ev.turn; }
  catch (e) { return { error: `commit model failed: ${e instanceof Error ? e.message : String(e)}` }; }
  if (signal.aborted) return { error: "interrupted while drafting the message" };
  if (!turn) return { error: "commit model returned no turn" };
  if (turn.stopReason === "error") return { error: `commit model failed: ${turn.error ?? "error"}` };
  const text = cleanMessage(partsText(turn.parts));
  return text ? { text } : { error: "the commit model returned an empty message" };
}

/** file paths named by a unified diff's `diff --git a/x b/x` headers — the card's file list without a second git call */
export function diffFiles(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.push(m[2]!);
  return out;
}

// ------------------------------------------------------------------ /commit

/** /commit [message] — see the header. `rawArg` is the raw remainder of the typed line (newlines intact: a body). */
export async function cmdCommit(ctx: GitCmdCtx, rawArg = ""): Promise<void> {
  const { renderer } = ctx;
  if (ctx.busy()) { renderer.addSystemNote(BUSY_NOTE, "warn"); return; }
  const given = rawArg.replace(/\r\n/g, "\n").trim();
  if (given.startsWith("-")) { renderer.addSystemNote(DASH_NOTE, "warn"); return; }
  const ac = new AbortController();
  ctx.setBusy(true);
  ctx.bindAbort(ac);
  renderer.setBusy(true, "collecting the diff…");
  let outcome: "done" | "error" = "error";
  try {
    // 1. the staged diff (allow-listed argv → no card under gated rules); nothing staged → the working-tree diff of tracked files
    const staged = await runGit(ctx, ["diff", "--cached"], ac.signal);
    if (!staged.executed) { renderer.addSystemNote(`\`${staged.command}\` ${refusalNote(staged, ac.signal)} — nothing committed`, "warn"); return; }
    if (staged.exit !== 0) { renderer.addSystemNote(gitFailure(staged, ctx.rt.cwd), "error"); return; }
    let scope: "staged" | "working" = "staged", diff = staged.body, capped = staged.capped;
    if (!diff.trim()) {
      const work = await runGit(ctx, ["diff"], ac.signal);
      if (!work.executed) { renderer.addSystemNote(`\`${work.command}\` ${refusalNote(work, ac.signal)} — nothing committed`, "warn"); return; }
      if (work.exit !== 0) { renderer.addSystemNote(gitFailure(work, ctx.rt.cwd), "error"); return; }
      if (!work.body.trim()) { renderer.addSystemNote("nothing to commit — the index and the tracked working tree are clean (untracked files need `git add` first)"); outcome = "done"; return; }
      scope = "working"; diff = work.body; capped = work.capped;
      renderer.addSystemNote("nothing staged — committing the working-tree changes to tracked files instead (`git commit -a`)");
    }
    // a complete diff names every file in its headers; a capped one is a prefix, so the card's list comes from git itself
    // (`--name-only`, the same allow-listed reader through the seam) and both the model and the human are told it was cut
    let files = diffFiles(diff);
    if (capped) {
      const named = await runGit(ctx, scope === "working" ? ["diff", "--name-only"] : ["diff", "--cached", "--name-only"], ac.signal);
      if (named.executed && named.exit === 0) files = named.body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    }
    // 2. the message: given → no model call; else ONE stream invocation on the COMMIT role's model
    let message = given, drafted = "";
    if (!message) {
      const model = ctx.rt.router.resolve("commit");
      renderer.setBusy(true, `drafting the commit message (${model.model})…`);
      const d = await draftMessage(ctx, capped ? `${diff}\n… ${CAP_NOTE}` : diff, model, ac.signal);
      if ("error" in d) { renderer.addSystemNote(`${d.error} — pass the message yourself: /commit <message>`, "error"); return; }
      message = d.text; drafted = `${model.provider}/${model.model}`;
      if (message.startsWith("-")) { renderer.addSystemNote(`the drafted message starts with - (${firstLine(message)}); ${DASH_NOTE}`, "error"); return; }
    }
    // 3. the commit through the seam — the card shows the message; never --amend, never --no-verify
    renderer.setBusy(true, "committing…");
    const detail = [
      `commit message${drafted ? ` (drafted by ${drafted}${given ? "" : " — deny to edit it in the prompt"})` : ""}:`,
      ...message.split("\n").map((l) => `  ${l}`),
      "",
      scope === "working" ? "scope: working-tree changes to tracked files (git commit -a)" : "scope: the staged changes",
      `files (${files.length}): ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}`,
      ...(capped ? [CAP_NOTE] : []),
    ].join("\n");
    const r = await runGit(ctx, scope === "working" ? ["commit", "-a", "-m", message] : ["commit", "-m", message], ac.signal, detail);
    if (!r.executed) {
      renderer.addSystemNote(`commit ${refusalNote(r, ac.signal)} — nothing committed`, "warn");
      if (r.asked && !ac.signal.aborted) { renderer.prefillEditor(`/commit ${message}`); renderer.addSystemNote("the message is in the prompt — edit it and press Enter to commit"); }
      return;
    }
    if (r.exit !== 0) { renderer.addSystemNote(`${gitFailure(r, ctx.rt.cwd)}\n${r.body.trim().split("\n").slice(-8).join("\n")}`, "error"); return; }
    outcome = "done";
    renderer.addSystemNote(`committed ${firstLine(r.body) || firstLine(message)}${drafted ? ` · message by ${drafted}` : ""}`);
  } finally {
    ctx.bindAbort(null);
    renderer.setBusy(false, outcome);
    ctx.setBusy(false);
  }
}

// ------------------------------------------------------------------ /undo

const when = (c: Checkpoint): string => new Date(c.createdAt).toLocaleTimeString();
const ident = (c: Checkpoint): string => `${c.hash.slice(0, 8)} (${c.label}, ${when(c)})`;
const STATUS_WORD: Record<string, string> = { M: "rewritten", D: "recreated", A: "removed (added since that checkpoint)", "?": "removed (created after the checkpoint)" };

/** /undo — step the workspace back one snapshot (see the header): confirmation card first, conversation untouched. */
export async function cmdUndo(ctx: GitCmdCtx): Promise<void> {
  const { renderer } = ctx;
  if (ctx.busy()) { renderer.addSystemNote(BUSY_NOTE, "warn"); return; }
  const cp = await ctx.rt.checkpointsFor(ctx.store().id);
  if (!cp) { renderer.addSystemNote("checkpoints unavailable (git missing or ROVECODE_NO_CHECKPOINTS=1) — nothing to undo", "warn"); return; }
  const last = cp.list().at(-1);
  if (!last) { renderer.addSystemNote("no checkpoint to undo to — snapshots land after each mutating tool call (edit, write, bash)"); return; }
  // where the workspace sits: AT a snapshot → its pre-edit ancestor is the target (the agent's last change); drifted → the last snapshot
  const pos = await cp.position();
  const target = pos.at ? pos.previous : last;
  if (!target) { renderer.addSystemNote(`nothing to undo — the workspace matches checkpoint ${ident(pos.at!)} and no older snapshot differs from it (/checkpoints lists them; /restore <ref> reaches any)`); return; }
  const id = ident(target);
  const changes = await cp.changedSince(target.hash);
  if (changes !== null && changes.length === 0) { renderer.addSystemNote(`nothing to undo — the workspace already matches the last checkpoint ${id}`); return; }
  const head = pos.at ? `undo the agent's last change (checkpoint ${pos.at.hash.slice(0, 8)}, ${pos.at.label}): restore ${id}` : `restore the workspace to checkpoint ${id}`;
  const detail = changes === null
    ? `${head}: every file goes back to that snapshot (the change list could not be computed)`
    : [`${head} — ${changes.length} path${changes.length === 1 ? "" : "s"}:`, ...changes.slice(0, 40).map((c) => `  ${c.status} ${c.path} — ${STATUS_WORD[c.status] ?? c.status}`), ...(changes.length > 40 ? [`  … ${changes.length - 40} more`] : []), "", "the conversation is untouched; /restore <ref> conversation branches it too"].join("\n");
  const answer = await renderer.askApproval("undo", `restore checkpoint ${target.hash.slice(0, 8)} · files only`, detail);
  if (answer === "deny") { renderer.addSystemNote("undo cancelled — nothing changed", "warn"); return; }
  const res = await cp.restore(target.hash, "files");
  if (!res.ok) { renderer.addSystemNote(`undo failed: ${res.error}`, "error"); return; }
  const what = changes === null ? "the workspace" : `${changes.length} path${changes.length === 1 ? "" : "s"}: ${changes.slice(0, 8).map((c) => c.path).join(", ")}${changes.length > 8 ? ", …" : ""}`;
  renderer.addSystemNote(`undo: restored ${what} to checkpoint ${id} — files only; the conversation is untouched (snapshots keep history: /checkpoints)`);
}
