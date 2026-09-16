/** TUI info commands, extracted from app.ts for the ADR-002 cap (wiring pass): /help /status
 *  /cost /skills /memory /export read state and print a note; /todos (port #32) and /tasks
 *  (port #26) surface the agent-maintained lists. Nothing here moves the session leaf — the
 *  CALLER owns the swappable store/blocks and the status slice, so every read runs through
 *  the injected ctx (same shape as session-cmd / checkpoints-cmd). */

import type { Runtime } from "../cli/runtime.ts";
import { exportSession } from "../cli/export.ts";
import { describeSandbox } from "../core/sandbox-config.ts";
import type { SessionStore } from "../core/session.ts";
import { formatTaskList, isTerminal } from "../core/tasks.ts";
import type { BlockStore } from "../memory/blocks.ts";
import type { ModelCatalog } from "../providers/catalog.ts";
import { loadTodos, renderTodos, todoStatusLabel } from "../tools/todo.ts";
import { helpForCommands, type CustomCommand } from "./commands.ts";
import { memoryCommand } from "./memory-note.ts";
import { buildCostNote } from "./cost.ts";
import type { Renderer, SlashCommand } from "./renderer.ts";
import { join } from "node:path";

export interface InfoStateSlice { provider: string; model: string; turns: number; tokensIn: number; tokensOut: number }

export interface InfoCmdCtx {
  renderer: Renderer;
  /** the runtime slices the info commands read: cwd, config provenance, sandbox rung, skills, tasks */
  rt: Pick<Runtime, "cwd" | "projectContext" | "sandbox" | "skillStore" | "tasks">;
  /** <cwd>/.rovecode/sessions — todos.json lives under <sessionsDir>/<session id> */
  sessionsDir: string;
  /** the ACTIVE session store, read live (/sessions and a root /rewind swap it) */
  store(): SessionStore;
  /** the ACTIVE memory block store, read live (swapped with the session) */
  blocks(): BlockStore;
  /** provider/model/turns/tokens exactly as the status line shows them */
  state: InfoStateSlice;
  commands: { builtin: readonly SlashCommand[]; custom: readonly CustomCommand[] };
  /** /cost pricing + context window (offline snapshot; `/cost refresh` is the TUI's one fetch) */
  catalog: ModelCatalog;
}

/** /help topics in display order; a command with an unknown or missing group lands under "more" at the end */
export const HELP_GROUP_ORDER: readonly string[] = ["start here", "session", "model & provider", "modes & safety", "files & history", "info"];

/** /help — the built-ins grouped by topic (SlashCommand.group), one plain line each, then the "custom:" tail (port #30). */
export function cmdHelp(ctx: InfoCmdCtx): void {
  ctx.renderer.addSystemNote(groupedHelp(ctx.commands.builtin) + helpForCommands(ctx.commands.custom));
}

/** pure: the grouped body /help prints (tests read it without a renderer) */
export function groupedHelp(builtin: readonly SlashCommand[]): string {
  const groups = new Map<string, SlashCommand[]>();
  for (const c of builtin) { const g = c.group !== undefined && HELP_GROUP_ORDER.includes(c.group) ? c.group : "more"; const l = groups.get(g) ?? []; l.push(c); groups.set(g, l); }
  const order = [...HELP_GROUP_ORDER, "more"].filter((g) => groups.has(g));
  return order.map((g) => `${g}\n` + groups.get(g)!.map((c) => `  /${c.name} — ${c.description}`).join("\n")).join("\n");
}

/** /status — provider/model/turns/tokens, the active executor rung + its origin (port #27), and
 *  config provenance (port #8 HIGH-2: dropped/truncated sources must be visible). */
export function cmdStatus(ctx: InfoCmdCtx): void {
  const pc = ctx.rt.projectContext;
  const cfgBits = pc.sources.map((s) => s.chars === 0 ? `${s.path} (dropped)` : s.truncated ? `${s.path} (truncated)` : s.path);
  if (pc.skippedFiles > 0) cfgBits.push(`+${pc.skippedFiles} skipped (file cap)`);
  const s = ctx.state;
  ctx.renderer.addSystemNote(
    `provider=${s.provider} model=${s.model} turns=${s.turns} tokens=${s.tokensIn}in/${s.tokensOut}out` +
    `\nsandbox: ${describeSandbox(ctx.rt.sandbox)}` +
    `\nconfig: ${cfgBits.length > 0 ? cfgBits.join(", ") : "(none)"}`,
  );
}

/** /cost [refresh] — ports #5+#6: normalized usage (incl. cache traffic) priced per message at its
 *  origin model; `refresh` re-fetches models.dev pricing (24h disk cache) — the live half is
 *  user-invoked only, so the TUI stays network-free unless asked. */
export function cmdCost(ctx: InfoCmdCtx, arg: string): void {
  if (arg === "refresh") {
    void ctx.catalog.refresh().then((ok) => ctx.renderer.addSystemNote(
      ok ? "model catalog refreshed from models.dev" : "catalog refresh failed — using the offline snapshot",
      ok ? "info" : "warn",
    ));
    return;
  }
  ctx.renderer.addSystemNote(buildCostNote(ctx.store().messages(), ctx.catalog, { provider: ctx.state.provider, model: ctx.state.model }));
}

/** /skills — installed skills, one `name — description` row each. */
export function cmdSkills(ctx: InfoCmdCtx): void {
  const rows = ctx.rt.skillStore.list().map((s) => `${s.name} — ${s.description}`);
  ctx.renderer.addSystemNote(rows.length ? rows.join("\n") : "(no skills installed)");
}

/** `/memory` — both blocks as the store holds them NOW, each with the file it lives in; `/memory --user` the USER
 *  block alone; `/memory <text>` appends to MEMORY and `/memory --user <text>` to USER (tui/memory-note.ts, the
 *  same append path as `#<text>` and the memory_edit tool). It shows the live text rather than renderForPrompt()
 *  so an edit made this run is visible immediately, with a hint that the prompt picks it up next run — and it
 *  names the paths, because the bug this replaced was a note landing somewhere the person did not mean. */
export function cmdMemory(ctx: InfoCmdCtx, arg = ""): void {
  const r = memoryCommand(ctx.blocks(), arg);
  ctx.renderer.addSystemNote(r.text, r.tone);
}

/** /export [--json] [path] [--force] — port #38: write THIS session as markdown (raw JSONL with
 *  --json), local only. Read-only over the store (exportSession re-reads from disk), so no busy
 *  gate; a spaced path stays whole (every non-flag word joins the path). */
export function cmdExport(ctx: InfoCmdCtx, arg: string): void {
  try {
    const words = arg.split(/\s+/).filter(Boolean);
    const res = exportSession(ctx.sessionsDir, ctx.store().id, {
      json: words.includes("--json"), force: words.includes("--force"),
      out: words.filter((w) => !w.startsWith("-")).join(" ") || undefined, cwd: ctx.rt.cwd,
    });
    ctx.renderer.addSystemNote(`exported ${res.format} → ${res.path}`);
  } catch (e) {
    ctx.renderer.addSystemNote(e instanceof Error ? e.message : String(e), "error");
  }
}

/** /todos — port #32: the agent-maintained list at <session>/todos.json as checkbox rows. A
 *  corrupt file is a warning above the (empty) list, never a throw (loadTodos contract). */
export function cmdTodos(ctx: InfoCmdCtx): void {
  const { items, note } = loadTodos(join(ctx.sessionsDir, ctx.store().id));
  if (note) ctx.renderer.addSystemNote(note, "warn");
  ctx.renderer.addSystemNote(items.length > 0 ? renderTodos(items) : "(no todos — the agent maintains the list with todo_write)");
}

/** Status-bar label for the session's list ("todos 1/3"); undefined when empty, so the app omits
 *  the key and plain surfaces never see a blank segment. */
export function todoLabel(sessionDir: string): string | undefined {
  return todoStatusLabel(loadTodos(sessionDir).items) || undefined;
}

/** /tasks [cancel <id>|cancel all] — port #26: the runtime TaskManager's snapshot (the same rows
 *  as the tool's `list` action). Cancel acknowledges the REQUEST here; the "cancelled" line itself
 *  arrives through the app's task subscription when the child run has actually settled (a queued
 *  task settles at once, a running one when its aborted run returns) — one terminal note per task. */
export function cmdTasks(ctx: InfoCmdCtx, arg: string): void {
  const words = arg.split(/\s+/).filter(Boolean);
  const tasks = ctx.rt.tasks;
  if (words.length === 0) { ctx.renderer.addSystemNote(formatTaskList(tasks.list())); return; }
  if (words[0] !== "cancel" || words.length !== 2) { ctx.renderer.addSystemNote("usage: /tasks [cancel <id>|cancel all]", "warn"); return; }
  const id = words[1]!;
  if (id === "all") {
    const n = tasks.cancelAll();
    ctx.renderer.addSystemNote(n === 0 ? "no queued or running tasks to cancel" : `cancelling ${n} task${n === 1 ? "" : "s"}`);
    return;
  }
  const before = tasks.status(id);
  if (!before) { ctx.renderer.addSystemNote(`unknown task '${id}' — list with /tasks`, "warn"); return; }
  if (isTerminal(before.status)) { ctx.renderer.addSystemNote(`task ${id} already ${before.status}`); return; }
  tasks.cancel(id);
  ctx.renderer.addSystemNote(`cancelling task ${id} (${before.label})`);
}
