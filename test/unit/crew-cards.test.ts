/** The crew card (src/sextant/crew-cards.ts) — the card Berkay picked, tested as data rather than as paint: the
 *  grouping is the RUN (TaskInfo.batch), the chips must never claim a CLI ran when it did not, and the 32-cell
 *  drop order is asserted in the order the module's header promises. The painter gets one test over the in-memory
 *  GridScreen (#42 helper) to pin that the `›` sits at the card's right edge and nothing is painted outside. */

import { expect, test } from "bun:test";
import type { TaskInfo } from "../../src/core/tasks.ts";
import {
  cardLines, chipGlyph, chipName, chipRow, chipTone, compactAge, crewCardBlock, crewCardHeight, fitTitle,
  groupCrew, groupElapsed, landedOf, nameRow, paintCrewCards, progressRow, type CrewTask,
} from "../../src/sextant/crew-cards.ts";
import { GridScreen, THEME, untouchedOutside } from "../helpers/sextant-grid.ts";

const T0 = 1_000_000;
/** a task; `over` carries batch/kind/lane/status and the timestamps */
function task(id: string, over: Partial<CrewTask> = {}): CrewTask {
  const base: TaskInfo = {
    id: `t${id}`, label: `label ${id}`, agent: "explore", goal: `goal ${id}`, isolated: false, depth: 1,
    status: "running", createdAt: T0, startedAt: T0,
  };
  return { ...base, ...over };
}
const lane = (id: string, laneId: "claude" | "codex" | "opencode" | "agy", over: Partial<CrewTask> = {}): CrewTask =>
  task(id, { kind: "external", lane: laneId, agent: laneId, ...over });

const text = (line: { spans: { text: string }[]; right?: { text: string } }): string => line.spans.map((s) => s.text).join("");

test("groupCrew groups by the RUN (batch), keeps start order, gives a batch-less task its own card, and titles a group by its batchLabel when the surface set one", () => {
  const crew = [
    lane("1", "codex", { batch: "r1", batchLabel: "test-project-scan" }),
    lane("2", "claude", { batch: "r1", batchLabel: "test-project-scan", status: "queued", startedAt: undefined }),
    task("3", { batch: "r2", batchLabel: "auth-refactor", status: "done", finishedAt: T0 + 5_000 }),
    task("4", { label: "one-off task" }), // no batch: started outside a bound run
  ];
  const groups = groupCrew(crew);
  expect(groups.map((g) => [g.key, g.label, g.tasks.length, g.working])).toEqual([
    ["r1", "test-project-scan", 2, 2],
    ["r2", "auth-refactor", 1, 0],
    ["task:t4", "one-off task", 1, 1],
  ]);
  expect(groups[1]!.finishedAt).toBe(T0 + 5_000); // every task finished → the clock stops
  expect(groups[0]!.finishedAt).toBeUndefined();  // one still queued → it keeps running
  expect(groupCrew([])).toEqual([]);
});

test("a group with no batch fields at all is exactly today's flat list: one card per task (so the card works before core/tasks.ts carries the fields)", () => {
  const groups = groupCrew([task("1"), task("2"), task("3")]);
  expect(groups.length).toBe(3);
  expect(groups.map((g) => g.tasks.length)).toEqual([1, 1, 1]);
});

test("groupElapsed spans the WHOLE workflow and keeps running until the last task finishes; compactAge is the card's `01s / 04m / 1h02m`", () => {
  const g = groupCrew([
    task("1", { batch: "r1", startedAt: T0, finishedAt: T0 + 1_000, status: "done" }),
    task("2", { batch: "r1", startedAt: T0 + 2_000, status: "running" }),
  ])[0]!;
  expect(groupElapsed(g, T0 + 9_000)).toBe(9_000);
  const done = groupCrew([
    task("1", { batch: "r2", startedAt: T0, finishedAt: T0 + 1_000, status: "done" }),
    task("2", { batch: "r2", startedAt: T0 + 2_000, finishedAt: T0 + 4_000, status: "done" }),
  ])[0]!;
  expect(groupElapsed(done, T0 + 900_000)).toBe(4_000); // finished work does not age
  expect([0, 1_000, 59_000, 60_000, 3_540_000, 3_600_000, 3_720_000].map(compactAge)).toEqual(["00s", "01s", "59s", "01m", "59m", "1h00m", "1h02m"]);
});

test("CHIP HONESTY: queued and running never look the same, only an external lane shows a CLI name, and our own agent can never borrow one", () => {
  expect(chipGlyph("queued")).not.toBe(chipGlyph("running"));
  expect([chipGlyph("queued"), chipGlyph("running"), chipGlyph("done"), chipGlyph("failed"), chipGlyph("cancelled")]).toEqual(["▫", "▪", "◆", "×", "·"]);
  expect(chipTone("queued")).toBe("dim");
  expect(chipTone("running")).toBe("accent");
  expect(chipName(lane("1", "codex"))).toBe("codex");
  expect(chipName(lane("2", "agy", { status: "queued" }))).toBe("agy"); // named, but its chip is hollow and dim
  expect(chipName(task("3", { agent: "explore" }))).toBe("explore");
  expect(chipName(task("4", { agent: "codex" }))).toBe("agent:codex"); // an agent must not read as the codex CLI
  expect(chipName({ ...task("5"), kind: "external", lane: undefined })).toBe("cli?"); // no id recorded → no name invented
  const chips = chipRow([lane("1", "codex"), lane("2", "claude", { status: "queued" })], 8);
  expect(chips.map((c) => [c.text, c.tone, c.bold ?? false])).toEqual([["▪", "accent", true], ["▫", "dim", false]]);
});

test("nameRow collapses repeats to counts and then to a `+N` tail — a name is shown whole or not at all, never clipped", () => {
  const tasks = [lane("1", "codex"), lane("2", "codex"), lane("3", "claude"), lane("4", "opencode")];
  expect(nameRow(tasks, 40).map((s) => s.text).join("")).toBe("codex ×2 claude opencode");
  const narrow = nameRow(tasks, 14);
  const shown = narrow.map((s) => s.text).join("");
  expect(shown.length).toBeLessThanOrEqual(14);
  expect(shown).toBe("codex ×2 +2"); // `codex ×2` already accounts for two of the four agents; two are still unnamed
  for (const s of narrow) expect(["codex ×2", " ", " +2", "claude", "opencode"]).toContain(s.text); // whole names only
  expect(nameRow(tasks, 2)).toEqual([]); // nothing fits: the row is empty rather than a fragment
  expect(nameRow([], 20)).toEqual([]);
});

test("a card at the panel's 32 cells is title + `N agents · age` + chips/names, and the title keeps the `›`", () => {
  const g = groupCrew([lane("1", "codex", { batch: "r1", batchLabel: "test-project-scan" }), lane("2", "claude", { batch: "r1" }), lane("3", "codex", { batch: "r1", status: "queued" })])[0]!;
  const lines = cardLines(g, 32, T0 + 1_000);
  expect(lines.length).toBe(3);
  expect(text(lines[0]!)).toBe("test-project-scan");
  expect(lines[0]!.right?.text).toBe("›");
  expect(text(lines[1]!)).toBe("3 agents · 01s");
  expect(text(lines[2]!)).toBe("▪▪▫  codex claude codex");
  expect(text(lines[2]!).length).toBeLessThanOrEqual(32);
  expect(cardLines(groupCrew([task("9", { batch: "r9", batchLabel: "solo" })])[0]!, 32, T0)[1]!.spans[0]!.text).toBe("1 agent · 00s"); // singular
});

test("the meta row is never dropped: a width too narrow for `N agents · age` produces NO card rather than a title with no state", () => {
  const g = groupCrew([lane("1", "codex", { batch: "r1", batchLabel: "a-very-long-workflow-name" })])[0]!;
  expect(cardLines(g, 13, T0)[1]!.spans[0]!.text).toBe("1 agent · 00s");
  expect(cardLines(g, 12, T0)).toEqual([]);
  expect(cardLines(g, 0, T0)).toEqual([]);
});

test("fitTitle truncates at a word boundary when there is one late in the line, hard-cuts when there is not, and always marks the cut", () => {
  expect(fitTitle("test-project-scan", 32)).toBe("test-project-scan");
  expect(fitTitle("refactor the auth middleware layer", 20)).toBe("refactor the auth…");
  expect(fitTitle("supercalifragilisticexpialidocious", 10)).toBe("supercali…");
  expect(fitTitle("  collapse   whitespace  ", 32)).toBe("collapse whitespace");
  expect(fitTitle("anything", 1)).toBe("…");
  expect(fitTitle("anything", 0)).toBe("");
});

test("crewCardBlock: newest card first, blank separators are the FIRST thing dropped, whole cards go next behind a `+N more` footer", () => {
  const crew = [
    lane("1", "codex", { batch: "r1", batchLabel: "first-run" }),
    lane("2", "claude", { batch: "r2", batchLabel: "second-run" }),
    lane("3", "agy", { batch: "r3", batchLabel: "third-run" }),
  ];
  const groups = groupCrew(crew);
  expect(crewCardHeight(groups, 32, T0)).toBe(11); // 3 cards × 3 rows + 2 separators

  const roomy = crewCardBlock(groups, 32, 11, T0);
  expect(roomy.hidden).toBe(0);
  expect(roomy.lines.map(text)).toEqual(["third-run", "1 agent · 00s", "▪  agy", "", "second-run", "1 agent · 00s", "▪  claude", "", "first-run", "1 agent · 00s", "▪  codex"]);

  const tight = crewCardBlock(groups, 32, 9, T0); // no room for separators, all three still fit
  expect(tight.hidden).toBe(0);
  expect(tight.lines.filter((l) => l.spans.length === 0).length).toBe(0);
  expect(tight.lines.length).toBe(9);

  const cut = crewCardBlock(groups, 32, 7, T0); // 2 cards + the footer
  expect(cut.hidden).toBe(1);
  expect(cut.lines.map(text)).toEqual(["third-run", "1 agent · 00s", "▪  agy", "second-run", "1 agent · 00s", "▪  claude", "+1 more"]);

  expect(crewCardBlock(groups, 32, 2, T0)).toEqual({ lines: [], hidden: 3 }); // not even one card: nothing rather than a fragment
  expect(crewCardBlock([], 32, 10, T0)).toEqual({ lines: [], hidden: 0 });
});

test("six agents in one workflow: the chips cap with a `+N` and the names collapse, and every row still fits 32 cells", () => {
  const crew = [
    lane("1", "codex", { batch: "r1", batchLabel: "wide-fan-out" }), lane("2", "codex", { batch: "r1" }),
    lane("3", "codex", { batch: "r1" }), lane("4", "claude", { batch: "r1", status: "queued" }),
    lane("5", "claude", { batch: "r1", status: "queued" }), lane("6", "opencode", { batch: "r1", status: "done", finishedAt: T0 + 2_000 }),
  ];
  const lines = cardLines(groupCrew(crew)[0]!, 32, T0 + 3_000);
  for (const l of lines) expect(text(l).length + (l.right ? 2 : 0)).toBeLessThanOrEqual(32);
  expect(text(lines[1]!)).toBe("6 agents · 03s");
  const chipsAndNames = text(lines[2]!);
  expect(chipsAndNames.startsWith("▪▪▪▫▫◆")).toBe(true); // one chip per agent, statuses distinct
  expect(chipsAndNames).toContain("codex ×3");
});

test("the painter writes the card's rows and puts the `›` on the card's right edge, and touches nothing outside its rect", () => {
  const g = groupCrew([lane("1", "codex", { batch: "r1", batchLabel: "test-project-scan" }), lane("2", "claude", { batch: "r1", status: "queued" })])[0]!;
  const lines = cardLines(g, 30, T0 + 61_000);
  const scr = new GridScreen(40, 8);
  paintCrewCards(scr, 2, 1, 30, lines, THEME);
  expect(scr.span(2, 1, 30)).toBe("test-project-scan            ›");
  expect(scr.span(2, 2, 30)).toBe("2 agents · 01m");
  expect(scr.span(2, 3, 30)).toBe("▪▫  codex claude");
  expect(scr.cell(31, 1).ch).toBe("›");
  expect(scr.cell(2, 3).fg).toBe(THEME.accent); // running chip
  expect(scr.cell(3, 3).fg).toBe(THEME.dim);    // queued chip: a different colour, not just a different glyph
  expect(untouchedOutside(scr, { x: 2, y: 1, w: 30, h: 3 }, " ")).toBe(true);
});

// ---------- the progress row (lanes/progress.ts; nimbus-24's four rules) ----------

const row = (tasks: CrewTask[], w = 32): string => progressRow(groupCrew(tasks)[0]!, w).map((s) => s.text).join("");
const prog = (over: Partial<NonNullable<CrewTask["progress"]>> = {}) => ({ toolCalls: 0, filesWritten: [], filesWrittenTotal: 0, ...over });

test("a RUNNING lane that has confirmed nothing shows NO file segment: agy confirms nothing for minutes while it writes, and `wrote 0 files` would be a false statement", () => {
  const running = task("1", { batch: "r1", kind: "external", lane: "agy", status: "running", progress: prog({ toolCalls: 7 }) });
  expect(row([running])).toBe("7 calls"); // the calls are real; the file count is not knowable yet
  expect(row([task("2", { batch: "r2", kind: "external", lane: "agy", status: "running", progress: prog() })])).toBe("");
});

test("only a patch that LANDED is `wrote`: a cancelled or failed lane's measured files are `discarded`, a live one's are `so far`", () => {
  const landed = task("1", { batch: "r1", status: "done", patchLines: 12, files: ["a.ts", "b.ts"], progress: prog({ toolCalls: 4 }) });
  expect(row([landed])).toBe("wrote 2 files · 4 calls");
  const cancelled = task("2", { batch: "r2", status: "cancelled", progress: prog({ toolCalls: 9, filesWritten: ["a.ts", "b.ts", "c.ts"], filesWrittenTotal: 3, applied: false }) });
  expect(row([cancelled])).toBe("3 discarded · 9 calls"); // its worktree was thrown away: the person has none of it
  const live = task("3", { batch: "r3", status: "running", progress: prog({ toolCalls: 2, filesWritten: ["x.ts"], filesWrittenTotal: 1 }) });
  expect(row([live])).toBe("1 file so far · 2 calls");
  const mixed = [{ ...landed, batch: "rm" }, { ...cancelled, batch: "rm" }]; // ONE run: one card, both facts (a landed patch and a discarded worktree)
  expect(row(mixed)).toContain("wrote 2 files");
  expect(row(mixed)).toContain("3 discarded");
});

test("a settled workflow that landed nothing says so — that zero is the worktree diff's own measurement, not an unread CLI", () => {
  expect(row([task("1", { batch: "r1", status: "done", patchLines: 0, progress: prog({ toolCalls: 3 }) })])).toBe("wrote 0 files · 3 calls");
});

test("usage ABSENT contributes no token segment; explicit zeros show `0` — a lane we could not read must not look like one that burned nothing", () => {
  const unread = task("1", { batch: "r1", status: "done", patchLines: 5, files: ["a.ts"], progress: prog({ toolCalls: 1 }), usage: undefined });
  expect(row([unread])).toBe("wrote 1 file · 1 call");
  const zeroed = task("2", { batch: "r2", status: "done", patchLines: 5, files: ["a.ts"], progress: prog({ toolCalls: 1, usage: { input: 0, output: 0 } }) });
  expect(row([zeroed])).toBe("wrote 1 file · 1 call · 0");
  const used = task("3", { batch: "r3", status: "done", patchLines: 5, files: ["a.ts"], progress: prog({ toolCalls: 1, usage: { input: 3_000, output: 1_200 } }) });
  expect(row([used])).toBe("wrote 1 file · 1 call · 4.2k");
});

test("the progress row is the card's fourth line and the FIRST of its rows to go when the width is short — the chips and the CLI names are what the card is for", () => {
  const t = task("1", { batch: "r1", batchLabel: "test-project-scan", kind: "external", lane: "codex", status: "done", patchLines: 9, files: ["a.ts", "b.ts"], progress: prog({ toolCalls: 12, usage: { input: 3_000, output: 1_200 } }) });
  const wide = cardLines(groupCrew([t])[0]!, 32, T0 + 1_000);
  expect(wide.length).toBe(4);
  expect(text(wide[3]!)).toBe("wrote 2 files · 12 calls · 4.2k");
  const narrow = cardLines(groupCrew([t])[0]!, 20, T0 + 1_000);
  expect(text(narrow[3]!)).toBe("wrote 2 files"); // segments drop from the right, whole
  expect(row([t], 6)).toBe(""); // nothing fits: no row rather than a fragment
});

test("the LANDED signal is progress.applied, not the status and not patchLines: a lane that finished cleanly whose patch git refused shows `discarded`, even though it reports ok and carries a patchLines", () => {
  // the case nimbus-24 measured in lanes-job: applyPatch returns false (a concurrent task touched the same lines),
  // job.ts still returns ok, tasks.ts still reaches the done branch and stamps patchLines. Everything about the
  // lane says success; the tree has none of its files. `wrote 4 files` here would be the worst row on the card.
  const refused = task("1", { batch: "r1", kind: "external", lane: "codex", status: "done", patchLines: 40, files: ["a.ts", "b.ts", "c.ts", "d.ts"], progress: prog({ toolCalls: 18, applied: false }) });
  expect(row([refused])).toBe("4 discarded · 18 calls");
  expect(row([refused])).not.toContain("wrote");

  const landed = { ...refused, id: "t2", progress: prog({ toolCalls: 18, applied: true }) };
  expect(row([landed])).toBe("wrote 4 files · 18 calls");

  // absent applied on a RUNNING lane: nothing has been offered to the tree yet
  const live = task("3", { batch: "r3", kind: "external", lane: "claude", status: "running", progress: prog({ toolCalls: 3, filesWritten: ["x.ts"], filesWrittenTotal: 1 }) });
  expect(row([live])).toBe("1 file so far · 3 calls");

  // one of OUR isolated children carries no progress at all: patchLines stays the best signal that layer has
  const child = task("4", { batch: "r4", status: "done", patchLines: 12, files: ["a.ts"] });
  expect(row([child])).toBe("wrote 1 file");
});

test("landedOf is the one question the row asks — did this reach the person's tree — and it never guesses from status alone", () => {
  // a lane answers from progress.applied, written by the code that applies
  expect(landedOf(task("1", { status: "done", progress: prog({ applied: true }) }))).toBe(true);
  expect(landedOf(task("2", { status: "done", patchLines: 40, progress: prog({ applied: false }) }))).toBe(false); // git refused: ok, patchLines, nothing landed
  expect(landedOf(task("3", { status: "running", progress: prog() }))).toBeUndefined();
  // one of OUR children has no progress: `files` exists only for a patch that applied (core/tasks.ts gates it)
  expect(landedOf(task("4", { status: "done", patchLines: 12, files: ["a.ts"] }))).toBe(true);
  expect(landedOf(task("5", { status: "done", patchLines: 12 }))).toBe(false);  // measured a patch, no files: it did not apply
  expect(landedOf(task("6", { status: "done", patchLines: 0 }))).toBe(true);    // an EMPTY patch: nothing to apply, nothing to fail
  expect(landedOf(task("7", { status: "cancelled" }))).toBe(false);
  expect(landedOf(task("8", { status: "queued" }))).toBeUndefined();
  // patchLines is a SIZE, never a verdict: the same 12 lines mean landed or discarded depending on `files`
  expect(landedOf(task("9", { status: "done", patchLines: 12, files: ["a.ts"] }))).not.toBe(landedOf(task("10", { status: "done", patchLines: 12 })));
});
