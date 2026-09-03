/** Reflection loop (port #28) WIRING tests: a REAL createRuntime (the built-in "reflection" hook set
 *  attached at construction) driving agentLoop with scripted model streams against the real hashline
 *  edit tool. Fixable: a stale anchor fails with the actionable message, the nudge is the next
 *  request's user message, and the mock heals the edit FROM THAT MESSAGE in one retry. Unfixable:
 *  different failures stop nudging at the cap; the identical failure is deduped and the loop guard's
 *  stub ends the run; a nudge left undrained at run end is swept and never opens the next run.
 *  ROVECODE_HOME is pinned to a temp dir (no real ~/.rovecode hooks); every run has a deadline. */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../../src/cli/runtime.ts";
import { agentLoop } from "../../src/core/loop.ts";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";
import { GUARDRAIL_DEFAULTS } from "../../src/core/guardrails.ts";
import { REFLECTION_PREFIX } from "../../src/core/reflection.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { AssistantTurn, Message, RunEvent, StreamEvent, StreamFn } from "../../src/core/types.ts";

const CONTENT = "alpha\nbeta\ngamma\n";
const RETRY = "Re-read the file, fix the anchors/content, and retry; if it cannot be fixed, say why and stop.";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const text = (m: Message): string => m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
const lastToolOutput = (messages: Message[]): string => {
  const m = [...messages].reverse().find((x) => x.role === "tool");
  const p = m?.parts.find((x) => x.kind === "tool_result");
  return p && p.kind === "tool_result" ? p.output : "";
};
const turn = (t: AssistantTurn): StreamEvent => ({ type: "turn", turn: t });
const editCall = (id: string, path: string, tag: string, anchorHash: string, newLines = ["BETA"]): AssistantTurn =>
  toolTurn([{ id, tool: "edit", args: { path, edits: [{ tag, anchorLine: 2, anchorHash, newLines }] } }]);
type ToolEnd = Extract<RunEvent, { type: "tool_execution_end" }>;
const toolEnds = (events: RunEvent[]): ToolEnd[] => events.filter((e): e is ToolEnd => e.type === "tool_execution_end");
const reflections = (events: RunEvent[]): string[] =>
  events.flatMap((e) => (e.type === "steer" && e.text.startsWith(REFLECTION_PREFIX) ? [e.text] : []));
/** is the LAST message of a model request the reflection user message? */
const endsWithReflection = (messages: Message[]): boolean => {
  const last = messages.at(-1);
  return last !== undefined && last.role === "user" && text(last).startsWith(REFLECTION_PREFIX);
};

const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_NO_CHECKPOINTS", "ROVECODE_NO_REPOMAP", "ROVECODE_REFLECTION", "ROVECODE_REFLECTION_MAX"] as const;
interface Rig { cwd: string; file: string; tag: string; done: () => void }
function rig(): Rig {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-refl-w-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-refl-whome-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ROVECODE_HOME = home; // hermetic user scope: the developer's real ~/.rovecode/hooks.* must not load
  process.env.ROVECODE_NO_CHECKPOINTS = "1"; // no shadow-git spawns in the temp workspace
  process.env.ROVECODE_NO_REPOMAP = "1";
  delete process.env.ROVECODE_REFLECTION;
  delete process.env.ROVECODE_REFLECTION_MAX;
  const file = join(cwd, "notes.txt"); // .txt: the LSP gate short-circuits (no server probe)
  writeFileSync(file, CONTENT);
  return {
    cwd, file, tag: fileTag(CONTENT),
    done: () => {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** cmdRun's LoopDeps shape (src/cli/main.ts:92): rt.hooks + rt.guard + rt.cwd threaded, rt.steering as the queue */
async function drive(rt: Runtime, stream: StreamFn, goal: string, maxTurns: number, deadlineMs = 15_000): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const def = rt.buildDef({ provider: "mock", model: "default" });
  const cfg = { ...rt.buildCfg(true), maxTurns };
  const run = (async () => {
    for await (const ev of agentLoop(def, goal, {}, cfg, {
      stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema),
      guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
    }, rt.steering)) events.push(ev);
  })();
  const outcome = await Promise.race([run.then(() => "ran" as const), sleep(deadlineMs).then(() => "DEADLINE" as const)]);
  if (outcome === "DEADLINE") throw new Error(`run did not settle within ${deadlineMs}ms; events so far: ${events.map((e) => e.type).join(",")}`);
  return events;
}

test("fixable: a stale anchor fails with the actionable message, the nudge is the next request's user message, and the mock heals the edit FROM that message in one retry", async () => {
  const r = rig();
  const rt = createRuntime({ cwd: r.cwd, stream: null });
  try {
    const requests: Message[][] = [];
    const stream: StreamFn = async function* (_m, messages) {
      requests.push(messages.map((m) => ({ ...m, parts: [...m.parts] })));
      const last = messages.at(-1)!;
      if (endsWithReflection(messages)) {
        // the model "reads" the nudge: the anchor line's CURRENT hash is right there in the actionable text
        const hash = /\(hash ([0-9a-z]{3})\)/.exec(text(last))?.[1];
        yield turn(hash ? editCall("c2", r.file, r.tag, hash) : textTurn("NO-HASH-IN-NUDGE"));
        return;
      }
      if (last.role === "tool") { yield turn(textTurn(lastToolOutput(messages).startsWith("applied 1 edit(s)") ? "HEALED" : "STUCK")); return; }
      yield turn(editCall("c1", r.file, r.tag, "zzz")); // stale anchor: line 2 is "beta", its hash is not zzz
    };
    const events = await drive(rt, stream, "change line 2", 8);
    // 1. the tool failed with the actionable text (the whole message, pinned at the wiring level)
    const c1 = toolEnds(events).find((e) => e.callId === "c1")!;
    expect(c1.ok).toBe(false);
    expect(c1.output).toBe(`Edit rejected: anchor mismatch at ${r.file}:2 — line 2 now reads "beta" (hash ${lineHash("beta")}), your anchor expected hash zzz. No line in the file has that hash now — the content changed since your read. Remedy: re-read the file with \`read\` to get fresh line hashes, then retry the edit.`);
    // 2. exactly one nudge, carrying the error (its first 300 chars — the temp path decides whether the
    //    tail is clipped; the exact bound is pinned in test/unit/reflection.test.ts), drained as a steer…
    const steers = reflections(events);
    expect(steers.length).toBe(1);
    expect(steers[0]!.startsWith(`${REFLECTION_PREFIX}the edit call failed — Edit rejected: anchor mismatch at ${r.file}:2 — line 2 now reads "beta" (hash ${lineHash("beta")}), your anchor expected hash zzz. No line in the file has that hash now`)).toBe(true);
    expect(steers[0]!.endsWith(`. ${RETRY}`)).toBe(true);
    // …and it IS the last message of the second model request, right after the failed tool_result
    expect(requests.length).toBe(3);
    const second = requests[1]!;
    expect(second.at(-1)!.role).toBe("user");
    expect(text(second.at(-1)!)).toBe(steers[0]!);
    expect(second.at(-2)!.role).toBe("tool");
    expect(endsWithReflection(requests[0]!)).toBe(false);
    expect(endsWithReflection(requests[2]!)).toBe(false);
    // 3. healed in one retry; the run is done; nothing left in the queue, no hook warnings
    expect(readFileSync(r.file, "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(toolEnds(events).find((e) => e.callId === "c2")!.ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "HEALED" });
    expect(rt.steering.size).toBe(0);
    expect(rt.hooks.warnings).toEqual([]);
  } finally {
    await rt.hooks.close();
    await rt.mcp?.close();
    r.done();
  }
});

test("unfixable (different failures): nudges stop at the cap (2) — only turns 2 and 3 open with a reflection message; the run ends at maxTurns, bounded", async () => {
  const r = rig();
  const rt = createRuntime({ cwd: r.cwd, stream: null });
  try {
    let n = 0;
    const requests: Message[][] = [];
    const stream: StreamFn = async function* (_m, messages) {
      requests.push([...messages]);
      yield turn(editCall(`f${n}`, r.file, r.tag, `h${n++}`)); // a fresh wrong anchor every turn: every failure text differs
    };
    const events = await drive(rt, stream, "flail", 6);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "budget" });
    const ends = toolEnds(events);
    expect(ends.length).toBe(6);
    expect(ends.every((e) => !e.ok && e.output.startsWith("Edit rejected: anchor mismatch"))).toBe(true);
    expect(reflections(events).length).toBe(2); // the cap: failures 3-6 get nothing
    expect(requests.map(endsWithReflection)).toEqual([false, true, true, false, false, false]);
    expect(readFileSync(r.file, "utf8")).toBe(CONTENT); // nothing applied
    expect(rt.steering.size).toBe(0);
    expect(rt.hooks.warnings).toEqual([]);
  } finally {
    await rt.hooks.close();
    await rt.mcp?.close();
    r.done();
  }
});

test("unfixable (identical failure): ONE nudge (identical repeats are deduped); the loop guard still fires — warns ride from the 3rd call, the 6th is stubbed — and the run ends when the model reacts to the stub", async () => {
  const r = rig();
  const rt = createRuntime({ cwd: r.cwd, stream: null });
  try {
    let n = 0;
    const stream: StreamFn = async function* (_m, messages) {
      if (lastToolOutput(messages).includes("loop guard: blocked")) { yield turn(textTurn("GAVE-UP")); return; }
      yield turn(editCall(`s${n++}`, r.file, r.tag, "zzz")); // the same broken edit, forever
    };
    const events = await drive(rt, stream, "same broken edit forever", 12);
    const ends = toolEnds(events);
    expect(ends.length).toBe(GUARDRAIL_DEFAULTS.stubAfterRepeats + 1); // 5 executed + the stubbed 6th
    for (const e of ends.slice(0, 5)) { expect(e.ok).toBe(false); expect(e.output.startsWith("Edit rejected: anchor mismatch")).toBe(true); }
    expect(ends[1]!.output).not.toContain("[loop-guard]");
    expect(ends[2]!.output).toContain("[loop-guard]"); // the guard's warn still lands on the 3rd identical call
    expect(ends[5]!.ok).toBe(false);
    expect(ends[5]!.output).toContain("loop guard: blocked");
    expect(reflections(events).length).toBe(1); // dedupe: the warn suffix does not make the repeat "different"
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "GAVE-UP" });
    expect(readFileSync(r.file, "utf8")).toBe(CONTENT);
    expect(rt.steering.size).toBe(0);
  } finally {
    await rt.hooks.close();
    await rt.mcp?.close();
    r.done();
  }
});

test("consumer-closed run (#39 MED-1 seam): the consumer .return()s the generator right after the failing edit (TUI Esc / ACP cancel / serve disconnect shape) — the undrained nudge is swept by the teardown's post_run; the next run's first turn is clean", async () => {
  const r = rig();
  const rt = createRuntime({ cwd: r.cwd, stream: null });
  try {
    await rt.hooks.ready;
    const stream: StreamFn = async function* () { yield turn(editCall("x1", r.file, r.tag, "zzz")); };
    const def = rt.buildDef({ provider: "mock", model: "default" });
    const deps = { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks };
    const gen = agentLoop(def, "close me", {}, { ...rt.buildCfg(true), maxTurns: 4 }, deps, rt.steering);
    let sawEnd = false;
    for await (const ev of gen) {
      if (ev.type === "run_end") sawEnd = true;
      if (ev.type === "tool_execution_end") { expect(ev.ok).toBe(false); expect(rt.steering.size).toBe(1); break; } // the nudge is queued; the consumer leaves
    }
    expect(sawEnd).toBe(false); // no run_end was ever yielded — the boundary reached the hooks through the teardown alone
    expect(rt.steering.size).toBe(0); // MUTATION TARGET: drop `await obs.close()` in agentLoop's finally → 1 (a nudge for a run that is gone)
    const requests: Message[][] = [];
    const quiet: StreamFn = async function* (_m, messages) { requests.push([...messages]); yield turn(textTurn("fresh start")); };
    const next = await drive(rt, quiet, "next prompt", 2);
    expect(next.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "fresh start" });
    expect(reflections(next)).toEqual([]);
    expect(requests[0]!.some((m) => m.role === "user" && text(m).startsWith(REFLECTION_PREFIX))).toBe(false);
    expect(rt.hooks.warnings).toEqual([]);
  } finally {
    await rt.hooks.close();
    await rt.mcp?.close();
    r.done();
  }
});

test("a nudge the loop never drained (maxTurns hit right after the failing edit) is swept at run end and does not open the next run on the same runtime", async () => {
  const r = rig();
  const rt = createRuntime({ cwd: r.cwd, stream: null });
  try {
    const stream: StreamFn = async function* () { yield turn(editCall("x1", r.file, r.tag, "zzz")); };
    const events = await drive(rt, stream, "one shot", 1);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "budget" });
    expect(toolEnds(events).length).toBe(1);
    expect(reflections(events)).toEqual([]); // there was no turn 2 to drain it
    expect(rt.steering.size).toBe(0); // swept by post_run (mutation target: drop the sweep → 1)
    const requests: Message[][] = [];
    const quiet: StreamFn = async function* (_m, messages) { requests.push([...messages]); yield turn(textTurn("fresh start")); };
    const next = await drive(rt, quiet, "next prompt", 2);
    expect(next.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "fresh start" });
    expect(reflections(next)).toEqual([]);
    expect(requests[0]!.some((m) => m.role === "user" && text(m).startsWith(REFLECTION_PREFIX))).toBe(false);
  } finally {
    await rt.hooks.close();
    await rt.mcp?.close();
    r.done();
  }
});
