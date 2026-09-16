/** The CREW CARD (Berkay's pick, 2026-09-07): the plan panel's crew section as titled cards — one card per
 *  WORKFLOW rather than one row per task, with a chip per agent showing which CLI opened.
 *
 *      crew  3 working
 *      test-project-scan            ›
 *      3 agents · 01s
 *      ▪▪▫  codex claude codex
 *
 *  WHAT A WORKFLOW IS HERE. rovecode has no workflow concept and this file does not invent one: `s.crew` is a flat
 *  TaskInfo[], and the only grouping that exists in the data is "tasks started under the same run" — TaskManager
 *  stamps `batch` / `batchLabel` from bindRun (core/tasks.ts, nimbus-5f's slice), which every surface already calls
 *  once per run. No heuristic: no time buckets, no label-prefix matching. A task with no batch (started outside a
 *  bound run) gets its own single-task card titled by its own label, which is exactly what the flat list showed.
 *
 *  THE CHIP RULE — a chip must never claim a CLI ran when it did not:
 *   - queued is a HOLLOW chip and a dim name; only running/done chips are filled. "codex is queued" and "codex is
 *     working" cannot look the same, because the difference is whether a process exists.
 *   - only an EXTERNAL lane (TaskInfo.kind "external") shows a CLI name, from its `lane` adapter id. One of our own
 *     subagents shows its AGENT name; if such a task were ever named after an adapter (the ids are reserved in
 *     tasks.ts, so this is a defence rather than a case) it renders as `agent:<name>` and never as a bare CLI name.
 *
 *  WHAT GOES FIRST WHEN IT DOES NOT FIT (the panel is 32 cells; stated rather than discovered by clipping):
 *   1. the blank row between cards — spacing carries no information;
 *   2. the names row collapses: repeats become counts (`codex ×2`), then a `+N` tail. Whole names are dropped, never
 *      clipped mid-word — half a CLI's name is a different CLI's name;
 *   3. the title is truncated with an ellipsis, at a word boundary when there is one;
 *   4. the chips cap at what fits and the rest become `+N`;
 *   5. whole cards go, newest kept, with a `+N more` footer.
 *  NEVER dropped: the agent count and the clock. A card that cannot show those two is not drawn at all — a title
 *  alone would say a workflow exists without saying whether anything is running.
 *
 *  PURE: `now` is a parameter (the clock and the card's age), no timers, no process access, no state writes. The
 *  painter at the bottom is the only part that touches a screen. */

import type { TaskInfo } from "../core/tasks.ts";
import { isAdapterId } from "../lanes/types.ts";
import { laneElapsed } from "./draw-agents.ts";
import { fmtK } from "./model.ts";
import { st } from "./theme.ts";
import { ATTR, type ScreenLike, type Seg, type Theme } from "./types.ts";

/** TaskInfo as the card reads it. `batch` / `batchLabel` / `progress` / `files` are all on TaskInfo now (core/tasks.ts);
 *  the alias stays as this module's own name for what it consumes. */
export type CrewTask = TaskInfo;

export type CardTone = "fg" | "fg2" | "muted" | "dim" | "ok" | "err" | "accent" | "warn";
export interface CardSpan { text: string; tone: CardTone; bold?: boolean }
/** one painted row; `right` is anchored to the card's right edge (the `›` affordance) */
export interface CardLine { spans: CardSpan[]; right?: CardSpan }

export interface CrewGroup {
  /** the batch id, or `task:<id>` for a task that has none */
  key: string;
  label: string;
  tasks: CrewTask[];
  /** min(startedAt ?? createdAt) over the group */
  startedAt: number;
  /** max(finishedAt) when EVERY task has finished; undefined while any is live (the clock still runs) */
  finishedAt?: number;
  working: number;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cps = (s: string): string[] => [...s];
const width = (s: string): number => cps(s).length;

// ------------------------------------------------------------------ grouping

/** Group by `batch`, first-seen order kept (the crew list is already in start order). A task without a batch is its
 *  own group. The label is the batch label when the surface set one, else the first task's label — never invented. */
export function groupCrew(crew: readonly CrewTask[]): CrewGroup[] {
  const out: CrewGroup[] = [];
  const byKey = new Map<string, CrewGroup>();
  for (const t of crew) {
    const key = t.batch ?? `task:${t.id}`;
    let g = byKey.get(key);
    if (g === undefined) {
      g = { key, label: oneLine(t.batchLabel ?? t.label) || "(no label)", tasks: [], startedAt: t.startedAt ?? t.createdAt, working: 0 };
      byKey.set(key, g);
      out.push(g);
    }
    g.tasks.push(t);
    g.startedAt = Math.min(g.startedAt, t.startedAt ?? t.createdAt);
  }
  for (const g of out) {
    g.working = g.tasks.filter((t) => t.status === "queued" || t.status === "running").length;
    const ends = g.tasks.map((t) => t.finishedAt);
    if (ends.every((e): e is number => e !== undefined)) g.finishedAt = Math.max(...ends);
  }
  return out;
}

/** the card's age: the WHOLE workflow's span, live until every task in it has finished */
export function groupElapsed(g: CrewGroup, now: number): number {
  if (g.finishedAt !== undefined) return Math.max(0, g.finishedAt - g.startedAt);
  return Math.max(0, now - g.startedAt, ...g.tasks.map((t) => laneElapsed(t, now)));
}

/** `01s` · `04m` · `1h02m` — the compact age from the card Berkay picked; mm:ss (laneClock) is the per-task form */
export function compactAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s).padStart(2, "0")}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m).padStart(2, "0")}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// ------------------------------------------------------------------ chips

/** ▫ queued (nothing has run) · ▪ running · ◆ done · × failed · · cancelled */
export function chipGlyph(status: TaskInfo["status"]): string {
  switch (status) {
    case "queued": return "▫";
    case "running": return "▪";
    case "done": return "◆";
    case "failed": return "×";
    default: return "·";
  }
}
export function chipTone(status: TaskInfo["status"]): CardTone {
  switch (status) {
    case "queued": return "dim";
    case "running": return "accent";
    case "done": return "ok";
    case "failed": return "err";
    default: return "muted";
  }
}

/** the name under a chip: a CLI id ONLY for an external lane; our own agents show their agent name. An external
 *  lane with no adapter id recorded says `cli?` rather than borrowing a name we do not have. */
export function chipName(t: CrewTask): string {
  if (t.kind === "external") return t.lane ?? "cli?";
  return isAdapterId(t.agent) ? `agent:${t.agent}` : t.agent;
}

/** the chip row's glyphs, one per task in order; `+N` when more tasks than fit in `w` cells */
export function chipRow(tasks: readonly CrewTask[], w: number): CardSpan[] {
  if (w <= 0 || tasks.length === 0) return [];
  const spans: CardSpan[] = [];
  let used = 0;
  for (let i = 0; i < tasks.length; i++) {
    const rest = tasks.length - i;
    const tail = rest > 1 ? `+${rest}` : "";
    if (used + 1 + width(tail) > w && i > 0) { spans.push({ text: `+${rest}`, tone: "dim" }); return spans; }
    if (used + 1 > w) return spans;
    const t = tasks[i]!;
    spans.push({ text: chipGlyph(t.status), tone: chipTone(t.status), bold: t.status === "running" });
    used += 1;
  }
  return spans;
}

/** The names, collapsed to fit: `codex claude codex` → `codex ×2 claude` when repeats cost less, then a `+N` tail.
 *  Whole names only — a clipped name is a lie about which CLI ran. Empty when nothing fits. */
export function nameRow(tasks: readonly CrewTask[], w: number): CardSpan[] {
  if (w <= 0 || tasks.length === 0) return [];
  const runs: { name: string; count: number; tone: CardTone }[] = [];
  for (const t of tasks) {
    const name = chipName(t), tone = chipTone(t.status);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.name === name && last.tone === tone) last.count++;
    else runs.push({ name, count: 1, tone });
  }
  const label = (r: { name: string; count: number }): string => (r.count > 1 ? `${r.name} ×${r.count}` : r.name);
  const spans: CardSpan[] = [];
  let used = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const text = label(r);
    // the tail counts the AGENTS still unnamed, not the runs: "+2" when three agents are hidden would be a wrong number
    const left = runs.slice(i).reduce((n, x) => n + x.count, 0);
    const tail = ` +${left}`;
    const sep = spans.length > 0 ? 1 : 0;
    const more = i < runs.length - 1 ? width(` +${left - r.count}`) : 0;
    if (used + sep + width(text) + more > w) {
      if (spans.length > 0 && used + width(tail) <= w) spans.push({ text: tail, tone: "dim" });
      return spans;
    }
    if (sep) { spans.push({ text: " ", tone: "dim" }); used += 1; }
    spans.push({ text, tone: r.tone });
    used += width(text);
  }
  return spans;
}

// ------------------------------------------------------------------ card rows

/** ellipsis truncation at a word boundary when there is one in the last third of the space */
export function fitTitle(title: string, w: number): string {
  const c = cps(oneLine(title));
  if (w <= 0) return "";
  if (c.length <= w) return c.join("");
  if (w === 1) return "…";
  const head = c.slice(0, w - 1).join("");
  const cut = head.lastIndexOf(" ");
  return (cut >= Math.floor((w - 1) * 0.67) ? head.slice(0, cut) : head) + "…";
}

/** the card: title (+ `›`), `N agents · age`, then the chips and the names on one row. The meta row is the
 *  honesty core — it is never dropped, so a card is only produced when `w` can hold it. */
export function cardLines(g: CrewGroup, w: number, now: number): CardLine[] {
  const count = `${g.tasks.length} agent${g.tasks.length === 1 ? "" : "s"}`;
  const meta = `${count} · ${compactAge(groupElapsed(g, now))}`;
  if (w < width(meta)) return [];
  const lines: CardLine[] = [];
  const arrow = w >= width(meta) + 2 ? { text: "›", tone: "dim" as CardTone } : undefined;
  lines.push({ spans: [{ text: fitTitle(g.label, w - (arrow ? 2 : 0)), tone: g.working > 0 ? "fg" : "fg2", bold: g.working > 0 }], ...(arrow ? { right: arrow } : {}) });
  lines.push({ spans: [{ text: meta, tone: "dim" }] });
  const chips = chipRow(g.tasks, Math.max(0, Math.min(g.tasks.length + 2, Math.floor(w / 2))));
  const chipW = chips.reduce((n, s) => n + width(s.text), 0);
  const names = nameRow(g.tasks, w - chipW - 2);
  if (chips.length > 0) lines.push({ spans: names.length > 0 ? [...chips, { text: "  ", tone: "dim" }, ...names] : chips });
  const progress = progressRow(g, w);
  if (progress.length > 0) lines.push({ spans: progress });
  return lines;
}

/** THE PROGRESS ROW — `wrote 4 files · 12 calls · 4.2k`, summed over a workflow's tasks, and it is the second thing
 *  dropped at a narrow width (after the blank separator): the chips and the CLI names are what the card exists for.
 *  Four rules, all of them about not overstating what a CLI did (lanes/progress.ts, nimbus-24's measurements):
 *   - a RUNNING lane with nothing confirmed shows no file segment at all. `filesWritten` is what the CLI has
 *     confirmed so far, and one of the four (agy) confirms nothing until it ends — it sits at zero for minutes and
 *     then jumps to the measured count. "wrote 0 files" for a lane that is writing would be a wrong statement, and
 *     treating that zero as a stall would be wrong about exactly one CLI.
 *   - a FINISHED task's list is the worktree diff, so there zero is a measurement and is worth printing.
 *   - a task whose patch never reached the tree did not WRITE anything the person has: its count is reported as
 *     `discarded` / `so far`, never as `wrote`. The signal is `progress.applied` (tri-state, written by the code
 *     that does the applying): absent = nothing offered to the tree yet, true = merged back, false = the writes
 *     stayed in a worktree that was deleted. NOT `patchLines`, and not the status either: a lane that finishes
 *     cleanly whose patch git refuses — a concurrent task touched the same lines — still reports ok AND gets a
 *     patchLines, so both of those would print `wrote 4 files` about a tree that has none of them (nimbus-24's
 *     lanes-job tests cover the case). One of OUR isolated children has no progress object, and orchestrator.ts
 *     has the same hole — so the signal there is `files`, which tasks.ts sets only for a patch that applied
 *     (5f gated it on progress.applied, else the runner's own "patch-apply-failed" marker). `patchLines` is a
 *     SIZE and never a verdict; the one thing it still settles is the empty patch, where 0 lines means there was
 *     nothing to apply and nothing that could fail.
 *   - `usage` ABSENT is not zero. A lane we could not read reports nothing; a lane that burned nothing reports
 *     zeros. Absent contributes no token segment; explicit zeros show `0`.
 *  `calls` counts every tool the CLI reported, reads included, so the word stays `calls`. Only lanes report them,
 *  so a mixed workflow's row says what its lanes did without implying the native agents did nothing. */
/** Did this task's work reach the person's tree? `true` landed · `false` written and thrown away · `undefined`
 *  nothing offered yet. A lane answers from `progress.applied` (the code that applies, not the code beside it); one
 *  of our own children answers from `files`, which exists only for a patch that applied — except for the empty
 *  patch, where `patchLines === 0` means there was nothing to apply, and that counts as landed. */
export function landedOf(t: CrewTask): boolean | undefined {
  if (t.progress !== undefined && "applied" in t.progress) return t.progress.applied;
  if (t.status === "running" || t.status === "queued") return undefined;
  if (t.files !== undefined) return true;
  return t.status === "done" && t.patchLines === 0;
}

export function progressRow(g: CrewGroup, w: number): CardSpan[] {
  let calls = 0, applied = 0, pending = 0, discarded = 0, tokens = 0, sawUsage = false;
  for (const t of g.tasks) {
    calls += t.progress?.toolCalls ?? 0;
    const n = t.files?.length ?? t.progress?.filesWrittenTotal ?? 0;
    const landed = landedOf(t);
    if (landed === true) applied += n;
    else if (landed === undefined) pending += n;
    else discarded += n;
    const u = t.progress?.usage ?? t.usage;
    if (u !== undefined) { sawUsage = true; tokens += u.input + u.output; }
  }
  const parts: { text: string; tone: CardTone }[] = [];
  if (applied > 0) parts.push({ text: `wrote ${applied} file${applied === 1 ? "" : "s"}`, tone: "ok" });
  if (pending > 0) parts.push({ text: `${pending} file${pending === 1 ? "" : "s"} so far`, tone: "dim" });
  if (discarded > 0) parts.push({ text: `${discarded} discarded`, tone: "muted" });
  // every task settled and nothing landed: that zero IS the measurement, and saying so beats an empty row
  const merged = g.tasks.some((t) => landedOf(t) === true);
  if (parts.length === 0 && g.working === 0 && merged) parts.push({ text: "wrote 0 files", tone: "dim" });
  if (calls > 0) parts.push({ text: `${calls} call${calls === 1 ? "" : "s"}`, tone: "dim" });
  if (sawUsage) parts.push({ text: fmtK(tokens), tone: "dim" });
  if (parts.length === 0) return [];
  const spans: CardSpan[] = [];
  let used = 0;
  for (const part of parts) {
    const sep = spans.length > 0 ? 3 : 0; // " · "
    if (used + sep + width(part.text) > w) break;
    if (sep) { spans.push({ text: " · ", tone: "dim" }); used += 3; }
    spans.push(part);
    used += width(part.text);
  }
  return spans;
}

export interface CrewCardBlock {
  lines: CardLine[];
  /** cards that did not fit — the `+N more` footer is already the last line when this is > 0 */
  hidden: number;
}

/** The card order: WORKING workflows first, newest of them at the top, then the settled ones newest first. The
 *  section's header says "2 working"; a panel that then shows two finished cards and hides the running one is
 *  answering a different question from the one it just asked. Within each half the newest card is first because
 *  the crew list is start-ordered, so its tail is the live work. */
export function crewCardOrder(groups: readonly CrewGroup[]): CrewGroup[] {
  const newestFirst = [...groups].reverse();
  return [...newestFirst.filter((g) => g.working > 0), ...newestFirst.filter((g) => g.working === 0)];
}

/** Pack the cards into `rows` rows in crewCardOrder. Blank separators are dropped before any card is. */
export function crewCardBlock(groups: readonly CrewGroup[], w: number, rows: number, now: number): CrewCardBlock {
  if (rows <= 0 || w <= 0 || groups.length === 0) return { lines: [], hidden: groups.length };
  const order = crewCardOrder(groups);
  const cards = order.map((g) => cardLines(g, w, now)).filter((c) => c.length > 0);
  const pack = (gap: boolean): CrewCardBlock & { shown: number } => {
    const lines: CardLine[] = [];
    let used = 0, shown = 0;
    for (const card of cards) {
      const need = card.length + (gap && shown > 0 ? 1 : 0);
      const footer = cards.length - shown - 1 > 0 ? 1 : 0;
      if (used + need + footer > rows) break;
      if (gap && shown > 0) { lines.push({ spans: [] }); used++; }
      lines.push(...card);
      used += card.length;
      shown++;
    }
    const hidden = groups.length - shown;
    if (hidden > 0 && shown > 0 && used < rows) lines.push({ spans: [{ text: `+${hidden} more`, tone: "dim" }] });
    return { lines: shown > 0 ? lines : [], hidden: shown > 0 ? hidden : groups.length, shown };
  };
  // separators are spacing; a card is information. Take the spaced packing only when it costs no card.
  const spaced = pack(true), dense = pack(false);
  return dense.shown > spaced.shown ? { lines: dense.lines, hidden: dense.hidden } : { lines: spaced.lines, hidden: spaced.hidden };
}

/** rows a full render of these groups would take (cards + separators), for a panel deciding its budget */
export function crewCardHeight(groups: readonly CrewGroup[], w: number, now: number): number {
  const cards = groups.map((g) => cardLines(g, w, now)).filter((c) => c.length > 0);
  return cards.reduce((n, c) => n + c.length, 0) + Math.max(0, cards.length - 1);
}

// ------------------------------------------------------------------ painter

const TONE: Record<CardTone, keyof Theme> = { fg: "fg", fg2: "fg2", muted: "muted", dim: "dim", ok: "ok", err: "err", accent: "accent", warn: "warn" };

/** paint `lines` at (x, y) in `w` cells — the only impure part, and it writes nothing but those rows */
export function paintCrewCards(scr: ScreenLike, x: number, y: number, w: number, lines: readonly CardLine[], theme: Theme): void {
  lines.forEach((line, i) => {
    const row = y + i;
    if (line.right !== undefined) {
      const r = line.right;
      scr.put(x + w - width(r.text), row, r.text, st(theme[TONE[r.tone]] as number), width(r.text));
    }
    if (line.spans.length === 0) return;
    const segs: Seg[] = line.spans.map((s) => [s.text, st(theme[TONE[s.tone]] as number, -1, s.bold ? ATTR.BOLD : 0)]);
    scr.text(x, row, segs, w - (line.right ? width(line.right.text) + 1 : 0));
  });
}
