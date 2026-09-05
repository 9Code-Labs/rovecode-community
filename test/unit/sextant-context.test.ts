/** The /context overlay: what it says, and the three things it must not quietly get wrong.
 *
 *  1. A corrected number presented as a measurement. The panel shows the scaled figure, because that is
 *     what the window and the bill are computed from, and says beside it what o200k actually counted and
 *     by how much it was scaled. Someone comparing this against a provider dashboard has to be able to
 *     tell which of the two numbers they are reading.
 *  2. A complete-looking total that is not complete. MCP tool schemas do not exist until a server is
 *     connected, so they are never counted — the panel says so rather than letting the silence imply the
 *     count covers everything.
 *  3. Drift measured against a different prompt. The estimate must include the same fixed rows the
 *     provider's number includes, or every session shows invented drift. */

import { expect, test } from "bun:test";
import { contextLines, driftRow, openContext, type ContextState } from "../../src/sextant/draw-context.ts";
import { fixedFrom, loadContext, type LiveRuntime } from "../../src/sextant/context-source.ts";
import { openOverlays } from "../../src/sextant/overlays.ts";
import { baseState } from "../helpers/sextant-grid.ts";

const REF = { provider: "anthropic", model: "claude-opus-5" };

/** a report shaped like core/context-report.ts's, so the adapter can be driven without counting anything */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: REF, window: 200_000,
    estimated: 10_000,          // o200k
    corrected: 12_100,          // × 1.21
    scale: { factor: 1.21, measured: true, note: "measured on Claude 4.5" },
    slices: [{ label: "system prompt", tokens: 6_000, share: 0.6 }, { label: "your messages", tokens: 4_000, share: 0.4 }],
    remaining: 187_900, fraction: 0.0605, nearLimit: false,
    totals: { inputTokens: 9_000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 20 },
    costUsd: 0.12, unpricedTurns: 0, images: 0,
    ...over,
  };
}

const load = (over: Record<string, unknown> = {}, fixed: { system?: string; toolSchemas?: string } = { system: "you are rovecode", toolSchemas: "[]" }) =>
  loadContext({ messages: [], current: REF, lookup: () => undefined, fixed, report: (() => report(over)) as never });

// ---------------------------------------------------------------- the two numbers

test("the panel shows the corrected number and says what was counted and by how much it was scaled", async () => {
  const s = await load();
  expect(s.estimated).toBe(12_100);   // what the window and the bill use
  expect(s.raw).toBe(10_000);         // what o200k counted

  const text = contextLines({ ...s, scroll: 0 }, 80).map((l) => l.text).join("\n");
  expect(text).toContain("o200k counted 10,000");
  expect(text).toContain("scaled 1.21×");
  expect(text).toContain("measured on Claude 4.5");
  // the meter reads the corrected figure, so the two must not be confused in the same panel
  expect(text).toContain("~12,100 of 200,000");
});

test("an unmeasured model is never given a neighbour's factor, and the note says so in its place", async () => {
  const s = await load({ corrected: 10_000, scale: { factor: 1, measured: false, note: "nobody has measured this model; the count is unscaled" } });
  expect(s.estimated).toBe(s.raw);
  const text = contextLines({ ...s, scroll: 0 }, 80).map((l) => l.text).join("\n");
  expect(text).toContain("o200k counted 10,000 — nobody has measured this model");
  // not "not.toContain('scaled')" — the note itself ends "the count is unscaled". What must be absent is
  // the correction sentence, which is the thing that would imply a factor nobody measured.
  expect(text).not.toContain("× for this model");
});

// ---------------------------------------------------------------- what is and is not counted

test("with a live runtime the total is complete except for MCP, and the panel says which", async () => {
  const s = await load();
  expect(s.live).toBe(true);
  const text = contextLines({ ...s, scroll: 0 }, 80).map((l) => l.text).join("\n");
  expect(text).toContain("MCP tools are not counted");
  expect(text).not.toContain("this total is a floor");
});

test("without one the total is called a floor rather than quietly under-reporting", async () => {
  const s = await load({}, {});
  expect(s.live).toBe(false);
  const text = contextLines({ ...s, scroll: 0 }, 80).map((l) => l.text).join("\n");
  expect(text).toContain("this total is a floor");
});

test("fixedFrom reads a running runtime and never builds one — and survives a runtime that cannot answer", () => {
  const rt: LiveRuntime = {
    registry: { list: () => [{ schema: { name: "read" } }, { schema: { name: "edit" } }] },
    buildDef: (ref) => { expect(ref.effort).toBe("auto"); return { systemPrompt: `prompt for ${ref.model}` } },
  };
  const fixed = fixedFrom(rt, REF);
  expect(fixed.system).toBe("prompt for claude-opus-5");
  expect(JSON.parse(fixed.toolSchemas!)).toHaveLength(2);

  // buildDef may also hand back a function of its own vars; both shapes are the runtime's business
  const fn: LiveRuntime = { registry: { list: () => [] }, buildDef: () => ({ systemPrompt: () => "built" }) };
  expect(fixedFrom(fn, REF).system).toBe("built");

  // a runtime mid-rebuild, or none at all: no system prompt, and therefore `live: false` downstream
  const broken: LiveRuntime = { registry: { list: () => { throw new Error("registry is being rebuilt") } }, buildDef: () => ({ systemPrompt: "x" }) };
  expect(fixedFrom(broken, REF)).toEqual({});
  expect(fixedFrom(null, REF)).toEqual({});
});

test("a report that throws opens the panel anyway — reporting on a session must not end it", async () => {
  const s = await loadContext({
    messages: [], current: REF, lookup: () => undefined, fixed: {},
    report: (() => { throw new Error("counting exploded") }) as never,
  });
  expect(s.model).toBe("anthropic/claude-opus-5");
  expect(s.live).toBe(false);
  expect(contextLines({ ...s, scroll: 0 }, 80).map((l) => l.text).join("\n")).toContain("could not be built");
});

// ---------------------------------------------------------------- drift

test("drift names the turn it measured, so the two numbers are known to describe one prompt", async () => {
  const s = await load({ drift: { estimated: 12_000, reported: 12_400, delta: 400, fraction: 0.032, beyondTolerance: false } });
  const text = contextLines({ ...s, scroll: 0 }, 80).map((l) => l.text).join("\n");
  expect(text).toContain("for the last turn's prompt");
  expect(text).toContain("provider counted 12,400");
  expect(text).toContain("we estimated 12,000");
});

test("past the tolerance the panel says WHICH WAY the meter is wrong, and prints the tolerance", async () => {
  const s = await load({ drift: { estimated: 10_000, reported: 15_000, delta: 5_000, fraction: 0.333, beyondTolerance: true } });
  const lines = contextLines({ ...s, scroll: 0 }, 100);
  const text = lines.map((l) => l.text).join("\n");
  expect(text).toContain("the meter reads LOW here");   // the real prompt is bigger than we think
  expect(text).toContain("5.0%");                        // the tolerance, printed rather than assumed
  expect(lines.some((l) => l.tone === "warn" && l.text.includes("beyond"))).toBe(true);
});

test("the cockpit's one-line version is silent when there is nothing honest to say", () => {
  expect(driftRow(undefined, 0.05)).toBeUndefined();
  expect(driftRow({ estimated: 100, reported: 102, delta: 2, fraction: 0.02, beyondTolerance: false }, 0.05))
    .toMatchObject({ warn: false });
  expect(driftRow({ estimated: 100, reported: 150, delta: 50, fraction: 0.33, beyondTolerance: true }, 0.05))
    .toMatchObject({ warn: true, text: expect.stringContaining("LOW") });
  // the other direction reads HIGH: our meter is over-counting and compaction would fire early
  expect(driftRow({ estimated: 150, reported: 100, delta: -50, fraction: 0.5, beyondTolerance: true }, 0.05))
    .toMatchObject({ warn: true, text: expect.stringContaining("HIGH") });
});

// ---------------------------------------------------------------- it is an overlay like the others

test("opening it closes whatever else was open — the one transition, not a fourth closer", async () => {
  const s = baseState();
  const state = await load();
  s.help = true;
  openContext(s, state);
  expect(openOverlays(s)).toEqual(["context"]);
  expect(s.help).toBe(false);
});

test("an empty session opens and says it is empty, rather than drawing a meter over nothing", async () => {
  const s: ContextState = {
    ...(await load({ estimated: 0, corrected: 0, slices: [], window: undefined, remaining: undefined, fraction: undefined,
      totals: {}, costUsd: undefined, scale: { factor: 1, measured: false, note: "unscaled" } })),
    scroll: 0,
  };
  const text = contextLines(s, 80).map((l) => l.text).join("\n");
  expect(text).toContain("nothing in the window yet");
  expect(text).toContain("no turn reported usage yet");
});
