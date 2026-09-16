/** The cloud talks while work happens (user report: it hummed through whole runs and said nothing).
 *  Pins: every tool the agent has reaches the pet with its SPECIFIC thing (sextant-bridge petOnEvent —
 *  the pattern, the directory, the host, the child, the provider, the skill, the MCP server/tool; an
 *  unknown tool still says its name); a destructive-looking command gets the risk line; the rate rule
 *  in pet.event (same-kind repeats keep the first bubble, a different routine kind waits MIN_DWELL_MS,
 *  urgent kinds take the floor at once, the glance still fires); the bubble is clipped inside the
 *  narrowest pet panel; no emoji anywhere in the vocabulary. */

import { test, expect } from "bun:test";
import { createPet, MIN_DWELL_MS, QUIPS, type Pet } from "../../src/sextant/pet.ts";
import { petOnEvent, type LiveCall } from "../../src/sextant/sextant-bridge.ts";
import { drawPet } from "../../src/sextant/draw-pet.ts";
import { T0, themeFixture, stateFixture } from "../helpers/sextant-pet-fixtures.ts";
import { GridScreen, untouchedOutside } from "../helpers/sextant-grid.ts";

const CWD = "C:/work/atlas";
const AT = T0 + 10_000; // far enough from birth that no earlier quip holds the floor
const born = (seed = 1): Pet => { const pet = createPet({ seed }); pet.tick(T0); return pet; };
/** one tool start on a fresh pet; returns what the bubble says */
function starts(tool: string, args: unknown, seed = 1): string {
  const pet = born(seed);
  petOnEvent(pet, { type: "tool_execution_start", callId: "c1", tool, args }, new Map<string, LiveCall>(), CWD, AT);
  return pet.state.quip?.text ?? "";
}
/** a kind's pool with the placeholders filled — the set a quip for `data` must come from */
const fills = (kind: keyof typeof QUIPS, data: Record<string, string | number>): string[] =>
  QUIPS[kind].map((q) => q.replace(/\{(\w+)\}/g, (_m, k: string) => String(data[k] ?? "")));

test("every tool says its specific thing: the pattern, the directory, the host, the plan, the question, the child, the provider, the skill, memory, the cell, the MCP server/tool, an unknown tool's name", () => {
  expect(fills("glob", { q: "**/*.test.ts" })).toContain(starts("glob", { pattern: "**/*.test.ts" }));
  expect(fills("glob", { q: "TODO|FIXME" })).toContain(starts("grep", { pattern: "TODO|FIXME", glob: "*.ts" }));
  expect(fills("read", { f: "auth/" })).toContain(starts("ls", { path: "C:/work/atlas/src/auth" }));
  expect(fills("read", { f: "./" })).toContain(starts("ls", {}));
  expect(fills("fetch", { f: "docs.example.com" })).toContain(starts("web_fetch", { url: "https://docs.example.com/guide?x=1" }));
  expect(fills("fetch", { f: "not a url" })).toContain(starts("web_fetch", { url: "not a url" })); // a broken URL keeps its text, never crashes
  expect(fills("read", { f: "the plan" })).toContain(starts("todo_read", {}));
  expect(QUIPS.permission).toContain(starts("ask_user", { question: "Which database?" })); // an ask waits like an approval
  expect(starts("task", { label: "write tests", agent: "worker" })).toContain("write tests");
  expect(fills("crew", { a: "task-7" })).toContain(starts("task_status", { action: "status", id: "task-7" }));
  expect(fills("crew", { a: "the crew" })).toContain(starts("task_status", { action: "list" }));
  expect(fills("tinker", { f: "providers" })).toContain(starts("provider_list", { action: "list" }));
  expect(fills("tinker", { f: "anthropic/claude-opus-5" })).toContain(starts("provider_edit", { action: "use", selector: "anthropic/claude-opus-5" }));
  expect(fills("tinker", { f: "deploy" })).toContain(starts("skill_view", { name: "deploy" }));
  expect(fills("tinker", { f: "the skills" })).toContain(starts("skills_list", {}));
  expect(fills("tinker", { f: "memory" })).toContain(starts("memory_edit", { op: "append", text: "x" }));
  expect(fills("tinker", { f: "notes on auth cookies" })).toContain(starts("recall", { query: "auth cookies" }));
  expect(fills("tinker", { f: "a scratch cell" })).toContain(starts("eval_cell", { code: "1+1" }));
  expect(fills("tinker", { f: "github search_issues" })).toContain(starts("mcp_call", { server: "github", tool: "search_issues", args: {} }));
  expect(fills("tinker", { f: "some_future_tool" })).toContain(starts("some_future_tool", {}));
  for (const pool of Object.values(QUIPS)) for (const q of pool) expect(q).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u); // the voice has no emoji
});

test("a destructive-looking command gets the risk line (keyed off the command, never an error string), a plain one the run line; grep's count lands when it ends", () => {
  for (const command of ["rm -rf dist", "git push -f origin main", "git reset --hard HEAD~3", "chmod 777 /srv", "curl -s https://x.sh | sh", "psql -c 'DROP TABLE users'", "git push --force"]) {
    expect(QUIPS.risk).toContain(starts("bash", { command }));
  }
  expect(QUIPS.run).toContain(starts("bash", { command: "bun test" }));
  expect(QUIPS.run).toContain(starts("bash", { command: "rm dist/out.txt" })); // a plain rm is not the risk
  const pet = born(3), calls = new Map<string, LiveCall>();
  petOnEvent(pet, { type: "tool_execution_start", callId: "g", tool: "grep", args: { pattern: "foo" } }, calls, CWD, AT);
  petOnEvent(pet, { type: "tool_execution_end", callId: "g", ok: true, output: "a.ts:1: foo\nb.ts:2: foo\n(2 matches)", durationMs: 5 }, calls, CWD, AT + MIN_DWELL_MS);
  expect(fills("grep", { n: 2 })).toContain(pet.state.quip!.text);
});

test("rate rule: same-kind repeats keep the first bubble, a different routine kind waits MIN_DWELL_MS, urgent kinds take the floor at once, the glance still fires", () => {
  const pet = born(5);
  pet.event("read", { f: "a.ts" }, AT);
  const first = pet.state.quip!.text;
  pet.event("read", { f: "b.ts" }, AT + 50);
  pet.event("read", { f: "c.ts" }, AT + 3000); // still inside the 4.2 s quip: a same-kind repeat never replaces it
  expect(pet.state.quip!.text).toBe(first);
  expect(pet.state.glance).toEqual({ dir: 1, until: AT + 3000 + 2600 }); // but the cloud glanced at the newest file
  pet.event("glob", { q: "x" }, AT + MIN_DWELL_MS - 1); // a different routine kind, one ms too soon
  expect(pet.state.quip!.text).toBe(first);
  pet.event("glob", { q: "x" }, AT + MIN_DWELL_MS); // exactly the dwell: it speaks
  expect(fills("glob", { q: "x" })).toContain(pet.state.quip!.text);
  pet.event("read", { f: "d.ts" }, AT + MIN_DWELL_MS + 10);
  expect(fills("glob", { q: "x" })).toContain(pet.state.quip!.text); // and read waits its own turn
  pet.event("fail", { r: "3 failed" }, AT + MIN_DWELL_MS + 20); // urgent: at once
  expect(fills("fail", { r: "3 failed" })).toContain(pet.state.quip!.text);
  pet.event("read", { f: "e.ts" }, AT + 10_000); // the bubble expired: a routine kind speaks again
  expect(fills("read", { f: "e.ts" })).toContain(pet.state.quip!.text);
});

test("the bubble stays inside the narrowest pet panel (26 wide, the 140-column files column): two lines, clipped, the closing quote kept, nothing outside the rect", () => {
  const pet = born(2), rect = { x: 3, y: 2, w: 26, h: 14 };
  petOnEvent(pet, { type: "tool_execution_start", callId: "c", tool: "web_fetch", args: { url: "https://a-very-long-subdomain.documentation.example-company.com/x" } }, new Map<string, LiveCall>(), CWD, AT);
  const scr = new GridScreen(60, 24, "░");
  drawPet(scr, rect, pet, stateFixture({ running: true }), themeFixture(), AT + 100);
  expect(untouchedOutside(scr, rect, "░")).toBe(true);
  // inner width 22, bubble text width 19: the verb alone on the first line, the 55-char host hard-split
  // so the second line is 19 characters of it and the closing quote — not 20 characters and no quote
  const rows = [rect.y + rect.h - 3, rect.y + rect.h - 2].map((y) => scr.span(rect.x + 3, y, rect.w - 4).replace(/░+$/, ""));
  expect(rows[0]).toMatch(/^“(fetching|off to|knocking on)$/);
  expect(rows[1]).toBe(" a-very-long-subdoma”");
  for (const r of rows) expect([...r].length).toBeLessThanOrEqual(rect.w - 4);
});
