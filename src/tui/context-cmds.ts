/** TUI context commands (port #53): /compact [focus] · /clear · /init · /copy [n]. Split out of
 *  app.ts for the ADR-002 cap; app.ts adds the four palette entries (CONTEXT_COMMANDS) and the
 *  dispatch cases. The CALLER owns the swappable store, the mode manager and the session-switch
 *  routine, so everything runs through the injected ctx (session-cmd.ts shape).
 *
 *  /compact  ADR-007: the ONE strategy set. compactSession calls core/compaction.ts planCompaction +
 *            applyCompaction with the run's own RunConfig (rt.buildCfg) and the loop's CompactionCtx
 *            shape (trigger "manual"; tokenText = partsTokenText). PORT NOTE — this tree has no
 *            summarizer wired anywhere (rovecode's runtime builds none; grep `.summarize` finds only
 *            memory/recall's own), and its `Summarizer` is `(texts) => Promise<string>` with no signal
 *            argument (aion's #68 one takes the signal and returns usage/origin). So on THIS tree
 *            head-summarize falls back to keep-window at PLAN time and the note says "no summarizer
 *            wired on this surface" — that note is the feature working, not a degradation, and it is
 *            the user-visible text until #68 lands (owned by nimbus-2d as a core piece). The signal
 *            still matters: loop.ts:215 threads ctx.signal, and when #68 lands the abort path is
 *            already here — cmdCompact OWNS an AbortController bound through ctx.bindAbort (the app's
 *            Esc / ⌃c target, ShellCtx.bindAbort shape; the --plain REPL binds Ctrl-C the same way).
 *            A manual compaction must be DURABLE or the next run would see the full history again
 *            (the automatic one is per-run and transient — loop.ts rebuilds history from
 *            store.messages() every run): the outcome history becomes a new branch of the append-only
 *            tree (fresh-id copies chained under the summary/marker message as a new root; ADR-004 —
 *            nothing deleted, the earlier turns stay in the file on the previous branch), the leaf
 *            moves there (meta.json, like /new), and the compaction marker is persisted with
 *            store.appendEvent — the same event shape and call the loop uses (loop.ts:216-217) — so
 *            replay and `rovecode export` show it. A focus hint is accepted but NOT applied: none of
 *            the strategies takes instructions (the summarizer signature is texts only); the note says
 *            so.
 *  /clear    a fresh session in place through the app's switchSession: same cwd/renderer, the live
 *            mode and the model slots survive, the transcript is emptied, the previous session is
 *            untouched and resumable.
 *  /init     submits the built-in AGENTS.md prompt (builtin-prompts.ts, ported alongside) as a plain
 *            user turn — the write/edit goes through the approval seam like any tool call.
 *  /copy     the last (or n-th from the end) assistant message's text → the clipboard (clipboard.ts).
 *  All four are busy-gated with the shared "finish or interrupt the run first" note.
 *
 *  Pattern reference only, no code ported: gemini-cli @ 0bd1d43 packages/cli/src/ui/commands/
 *  {compressCommand,clearCommand,initCommand,copyCommand}.ts — force-compress shows original→new
 *  token counts (:49-61); /clear ends the recording, mints a new session id and clears the UI
 *  (:41-76); /copy takes the last model message's text parts (:24-41). */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { applyCompaction, planCompaction, DEFAULT_COMPACTION_STRATEGY, type CompactionCtx, type CompactionStrategy } from "../core/compaction.ts";
import { estimateTokens } from "../core/context.ts";
import { partsText, partsTokenText } from "../core/loop.ts";
import { buildModeChangeEntry, modeFromEntries, type AgentMode, type ModeManager } from "../core/modes.ts";
import type { SessionStore } from "../core/session.ts";
import { ATTACHMENTS_DIR } from "../core/session-images.ts";
import type { Message, MessagePart, RunConfig } from "../core/types.ts";
import { expandBuiltinSlash, INIT_TARGET } from "./builtin-prompts.ts";
import { copyToClipboard, type ClipboardOptions } from "./clipboard.ts";
import type { ModeStateSlice } from "./modes-cmd.ts";
import type { Renderer, SlashCommand } from "./renderer.ts";
import { compactionNote, type CompactionEvent } from "./replay-marker.ts";

/** palette + /help entries, appended to TUI_COMMANDS (reserved against custom commands like the rest).
 *  rovecode's SlashCommand carries a `group` — the /help topic (info-cmd.ts). /compact and /copy are
 *  session-scope facts (what the context holds, what to copy out of it); /init writes a project file,
 *  /clear starts over, so they sit with files & history and session. */
export const CONTEXT_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compact the context now: /compact [focus] — the automatic strategy set, marker persisted", group: "session" },
  { name: "clear", description: "Fresh session in place (transcript emptied; the previous session is kept — /resume <id>)", group: "session" },
  { name: "init", description: "Analyse the repo and write AGENTS.md (an existing one gets targeted improvements)", group: "files & history" },
  { name: "copy", description: "Copy the last assistant message to the clipboard: /copy [n] (n-th from the end)", group: "session" },
];

/** a session below this many messages on the active path is "short": one note, no plan, no model call */
export const MIN_COMPACT_MESSAGES = 6;
const BUSY_WARN = "finish or interrupt the run first (Esc)";

export interface ContextCmdCtx {
  renderer: Renderer;
  cwd: string;
  busy(): boolean;
  /** the ACTIVE session store, read live */
  store(): SessionStore;
  modes: ModeManager;
  /** the app's status slice (mode/model/provider/busy) — mutated in place like modes-cmd does */
  state: ModeStateSlice;
  /** the modes config's defaultMode ?? "act": what a session with no mode entry resumes to */
  defaultMode: AgentMode;
  /** the RunConfig a run would start with right now (rt.buildCfg) — the compaction strategy/budget source */
  buildCfg(): RunConfig;
  /** THIS TREE: no summarizer is wired anywhere (see the header), so this stays undefined in the TUI;
   *  the field exists so #68's runtime wiring has a seam to land in and the tests can inject one.
   *  rovecode's Summarizer shape: (texts: string[]) => Promise<string> */
  summarize?: CompactionCtx["summarize"];
  /** the app's interrupt target (Esc / ⌃c / quit abort it) — bound for /compact's lifetime, then
   *  cleared with null (ShellCtx.bindAbort shape) */
  bindAbort?(ac: AbortController | null): void;
  /** rebind the app to session id (store, memory, mode) and replay it (app.ts switchSession) */
  switchSession(id: string, announce?: boolean): void;
  replayHistory(): void;
  refreshUsage(): void;
  pushStatus(): void;
  /** the plain user-turn path (app.ts submit) */
  submit(text: string): Promise<void>;
  /** test seam: platform + spawner for /copy; default = the real chain */
  clipboard?: ClipboardOptions;
}

// ---------- /compact ----------

export type CompactOutcome =
  | { kind: "compacted"; event: CompactionEvent; fallbackFrom?: CompactionStrategy; dropped: number; kept: number }
  | { kind: "nothing"; reason: string };

/** the surface's half of the loop's CompactionCtx (loop.ts:215) — what it wires for automatic compaction */
export interface CompactDeps { model?: CompactionCtx["model"]; summarize?: CompactionCtx["summarize"]; native?: CompactionCtx["native"]; signal?: AbortSignal }

/** The on-disk form of copied parts: a hydrated sidecar path (absolute, under <session>/attachments)
 *  goes back to the canonical `attachments/<file>` — a persisted absolute path is dropped at load
 *  (session-images.ts F3), so re-appending the in-memory form would silently lose the image. */
function persistableParts(parts: readonly MessagePart[]): MessagePart[] {
  return parts.map((p) => p.kind === "image" && p.path !== undefined && isAbsolute(p.path) ? { ...p, path: `${ATTACHMENTS_DIR}/${basename(p.path)}` } : p);
}

/** Compact the store's active path NOW through the ONE strategy set and make the result durable
 *  (header). Pure over (store, cfg, deps): no renderer, so the --plain REPL shares it. */
export async function compactSession(store: SessionStore, cfg: RunConfig, deps: CompactDeps = {}): Promise<CompactOutcome> {
  const history = store.messages();
  const n = history.length;
  if (n < MIN_COMPACT_MESSAGES) return { kind: "nothing", reason: `nothing to compact — ${n} message${n === 1 ? "" : "s"} on the active path (compaction needs at least ${MIN_COMPACT_MESSAGES})` };
  const tokenText = (m: Message): string => partsTokenText(m.parts);
  const tokensOf = (ms: readonly Message[]): number => ms.reduce((t, m) => t + estimateTokens(tokenText(m)), 0);
  // PORT NOTE: aion passes trigger "manual"; rovecode's CompactionTrigger is "speculative" |
  // "emergency" (aion's "manual" arrives with #68's core work, owned by 2d). "speculative" is the
  // honest stand-in: a threshold-triggered plan — and the marker this writes says strategy + token
  // counts only (compactionNote), so no surface reads the trigger word.
  const cctx: CompactionCtx = { trigger: "speculative", tokenText, summarize: deps.summarize, native: deps.native, model: deps.model, signal: deps.signal };
  const plan = planCompaction(history, cfg, cctx);
  const out = plan ? await applyCompaction(history, plan, cfg, cctx) : null;
  if (!out) return { kind: "nothing", reason: `nothing to compact — ${cfg.compactionStrategy ?? DEFAULT_COMPACTION_STRATEGY} found nothing droppable (${tokensOf(history)} tokens)` };
  const tokensBefore = tokensOf(history);
  const tokensAfter = tokensOf(out.history);
  // durable branch: fresh-id copies (the same ids would be duplicate-id corruption) chained under a
  // new root; the stage is parked meanwhile — append() folds staged attachments into ANY user message
  const staged = store.stagedAttachments;
  store.stageAttachments([]);
  const prevLeaf = history.at(-1)?.id;
  let parentId: string | null = null;
  try {
    for (const m of out.history) {
      const copy: Message = { ...m, id: randomUUID(), parentId, parts: persistableParts(m.parts) };
      store.append(copy);
      parentId = copy.id;
    }
    if (parentId !== null) store.branch(parentId); // durable leaf (meta.json), like /new — a resume lands on the compacted branch
  } catch (e) {
    if (prevLeaf !== undefined) store.branch(prevLeaf); // a half-written branch is abandoned, the old path stays active
    throw e;
  } finally {
    store.stageAttachments(staged);
  }
  // the marker, exactly as loop.ts persists the automatic one (rovecode's CompactionEvent has no
  // fallback tag/usage fields — those arrive with #68; the marker already shows before → after tokens)
  // the marker, exactly as loop.ts persists the automatic one (loop.ts:216-217). trigger is omitted:
  // rovecode's RunEvent types it "speculative" | "emergency" only, and a manual compaction has no
  // honest word in that union yet (#68) — absent beats a false one, and compactionNote renders
  // strategy + counts, never the trigger.
  const event: CompactionEvent = { type: "compaction", strategy: out.strategy, tokensBefore, tokensAfter };
  store.appendEvent(event);
  const original = new Set(history.map((m) => m.id));
  const kept = out.history.filter((m) => original.has(m.id)).length;
  return { kind: "compacted", event, dropped: n - kept, kept, ...(out.fallbackFrom ? { fallbackFrom: out.fallbackFrom } : {}) };
}

/** The detail line after the marker's before/after line. rovecode's plan-time fallback carries
 *  `fallbackFrom` ("head-summarize" when no summarizer is wired — THIS TREE'S normal case) but no
 *  reason text; the wording names the wiring, which is the thing missing here (aion #68 adds the
 *  apply-time reason with the fenced summarizer). */
export function compactDetails(res: Extract<CompactOutcome, { kind: "compacted" }>, focus: string): string {
  const s = (k: number): string => (k === 1 ? "" : "s");
  return `${res.dropped} message${s(res.dropped)} dropped, ${res.kept} kept — the earlier turns stay in the session file on the previous branch` +
    (res.fallbackFrom ? ` · ${res.fallbackFrom} could not run on this surface (no summarizer wired) — ${res.event.strategy} ran instead` : "") +
    (focus ? ` · focus "${focus}" not applied — the compaction strategies take no instructions` : "");
}

/** Both lines for a surface without replay (the --plain REPL): the marker wording, then the details. */
export function compactNoteLines(res: CompactOutcome, focus: string): string[] {
  return res.kind === "nothing" ? [res.reason] : [compactionNote(res.event), compactDetails(res, focus)];
}

/** /compact [focus] — busy-gated, and it HOLDS the busy flag while it runs (a concurrent submit queues
 *  as steering instead of starting a run — a future summarizer would be a model call) without a
 *  renderer spinner: there is no run for the surface to settle (the sextant would mark one "stopped").
 *  The transcript is replayed from the compacted path, so what the user sees is what the model gets:
 *  the summary/marker note, the kept turns, then the persisted marker line (before → after tokens). */
export async function cmdCompact(ctx: ContextCmdCtx, focus: string): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote(BUSY_WARN, "warn"); return; }
  const store = ctx.store();
  ctx.state.busy = true;
  const ac = new AbortController(); // Esc / ⌃c abort the in-flight summarize call — bound like `!cmd` (shell-cmd.ts), cleared after
  ctx.bindAbort?.(ac);
  let res: CompactOutcome;
  try {
    res = await compactSession(store, ctx.buildCfg(), { model: ctx.modes.modelFor(), summarize: ctx.summarize, signal: ac.signal }); // the runtime's summarizer, the command's signal
  } catch (e) {
    res = { kind: "nothing", reason: `compaction failed: ${e instanceof Error ? e.message : String(e)} — the session is unchanged` };
  } finally {
    ctx.bindAbort?.(null);
    ctx.state.busy = false;
  }
  if (res.kind === "nothing") { ctx.renderer.addSystemNote(res.reason, res.reason.startsWith("compaction failed") ? "error" : "info"); ctx.pushStatus(); return; }
  // a mode entry that lived in the dropped head would make a resume land in the default mode:
  // re-record the live mode on the new branch (durable entry, same shape flushModeSwitch writes)
  const resumesAs = modeFromEntries(store.messages()) ?? ctx.defaultMode;
  if (resumesAs !== ctx.modes.mode) store.append(buildModeChangeEntry({ from: resumesAs, to: ctx.modes.mode }, store.messages().at(-1)?.id ?? null));
  ctx.replayHistory(); ctx.refreshUsage(); ctx.pushStatus();
  ctx.renderer.addSystemNote(compactDetails(res, focus));
}

// ---------- /clear ----------

/** /clear — a fresh session in place. switchSession restores the CONFIG default mode for a session
 *  with no entries; a clear keeps the LIVE mode, recorded the way /plan records it (a pending notice
 *  the next submit — or quit — flushes as a durable entry), and the in-memory model slots carry over. */
export function cmdClear(ctx: ContextCmdCtx): void {
  if (ctx.busy()) { ctx.renderer.addSystemNote(BUSY_WARN, "warn"); return; }
  const old = ctx.store().id;
  const mode = ctx.modes.mode;
  const id = randomUUID();
  ctx.switchSession(id, false);
  if (ctx.modes.mode !== mode) {
    ctx.modes.toggle(mode);
    const cur = ctx.modes.modelFor();
    ctx.state.mode = mode; ctx.state.model = cur.model; ctx.state.provider = cur.provider;
    ctx.pushStatus();
  }
  ctx.renderer.addSystemNote(`cleared — fresh session ${id.slice(0, 8)} in the same directory; session ${old.slice(0, 8)} kept (/resume ${old.slice(0, 8)})`);
}

// ---------- /init ----------

/** /init — the built-in AGENTS.md prompt through the plain user-turn path. Busy-gated like a custom
 *  command (runCustomCommand): a built-in prompt is never queued as steering. */
export async function cmdInit(ctx: ContextCmdCtx): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote(BUSY_WARN, "warn"); return; }
  const prompt = expandBuiltinSlash("/init", ctx.cwd);
  if (prompt === undefined) return; // unreachable: "init" is in BUILTIN_PROMPTS
  ctx.renderer.addSystemNote(existsSync(join(ctx.cwd, INIT_TARGET))
    ? `${INIT_TARGET} exists — asking the agent for targeted improvements (edits go through the usual approval)`
    : `analysing the repository to write ${INIT_TARGET} (the write goes through the usual approval)`);
  await ctx.submit(prompt);
}

// ---------- /copy ----------

/** The n-th-from-the-end assistant message WITH text (tool-call-only turns do not count) → the
 *  clipboard; one note either way, never a throw. Shared with the --plain REPL. */
export async function copyAssistantMessage(messages: readonly Message[], n: number, opts: ClipboardOptions = {}): Promise<{ text: string; tone: "info" | "warn" }> {
  const texts = messages.filter((m) => m.role === "assistant").map((m) => partsText(m.parts)).filter((t) => t.trim() !== "");
  if (texts.length === 0) return { text: "nothing to copy — no assistant message with text yet", tone: "warn" };
  const pick = texts[texts.length - n];
  if (pick === undefined) return { text: `nothing to copy — only ${texts.length} assistant message${texts.length === 1 ? "" : "s"} with text (asked for number ${n} from the end)`, tone: "warn" };
  const res = await copyToClipboard(pick, opts);
  if (res.ok) return { text: `copied ${n === 1 ? "the last assistant message" : `assistant message ${n} from the end`} (${pick.length} chars) to the clipboard via ${res.tool}`, tone: "info" };
  return { text: `clipboard unavailable — tried ${res.tried.join(", ") || "nothing"}${res.detail ? ` (${res.detail})` : ""}; the text stays in the transcript`, tone: "warn" };
}

/** /copy [n] — n defaults to 1 (the last); any other argument is a usage note. */
export async function cmdCopy(ctx: ContextCmdCtx, arg: string): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote(BUSY_WARN, "warn"); return; }
  const n = arg === "" ? 1 : /^[1-9]\d*$/.test(arg) ? Number(arg) : NaN;
  if (Number.isNaN(n)) { ctx.renderer.addSystemNote("usage: /copy [n] — copies the last assistant message; n counts back from the latest (2 = the one before)", "warn"); return; }
  const line = await copyAssistantMessage(ctx.store().messages(), n, ctx.clipboard ?? {});
  ctx.renderer.addSystemNote(line.text, line.tone);
}

// ---------- dispatch ----------

/** handleSlash hook for the four names (CONTEXT_COMMANDS); fire-and-forget like the other async slash commands. */
export async function runContextCommand(ctx: ContextCmdCtx, cmd: string, arg: string): Promise<void> {
  switch (cmd) {
    case "compact": return cmdCompact(ctx, arg);
    case "clear": return cmdClear(ctx);
    case "init": return cmdInit(ctx);
    case "copy": return cmdCopy(ctx, arg);
    default: return;
  }
}
