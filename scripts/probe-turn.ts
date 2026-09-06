/** What one run costs US, as opposed to the model: the real runtime in the current repo, agentLoop against an
 *  INSTANT scripted stream (read a repo file → write a small file → `echo ok` in bash → a text answer), our own
 *  wall time accounted by phase. The provider never runs, so every millisecond here is harness: boot, buildDef
 *  (system prompt: skills + memory indexes, profile, design section, repo map), the per-turn loop overhead
 *  (history token estimate, context assembly, plan reminder), the wire serialisation the Anthropic adapter
 *  would do (toAnthropicMessages, timed on the same messages), tool dispatch and the tools' own work, the
 *  session store's appends, the headless sink, and — replayed afterwards on the same events — the sextant
 *  renderer with a paint per event (an upper bound: the live loop coalesces paints to 25 fps).
 *    bun scripts/probe-turn.ts            (an empty ROVECODE_HOME keeps MCP children out of the picture)
 *    bun --cpu-prof --cpu-prof-name turn.cpuprofile scripts/probe-turn.ts && python scripts/probe-cpu.py turn.cpuprofile
 *  Leaves nothing behind: the scratch file and the session it wrote are removed. */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, StreamFn } from "../src/core/types.ts";

const now = (): number => performance.now();
const ms = (n: number): number => +n.toFixed(1);
const mb = (n: number): number => +(n / 1048576).toFixed(1);
const T: Record<string, number> = {};
const t0 = now();

const { bootRuntime } = await import("../src/cli/runtime.ts");
const { agentLoop } = await import("../src/core/loop.ts");
const { mockStream, toolTurn, textTurn } = await import("../src/providers/stream.ts");
const { toAnthropicMessages } = await import("../src/providers/wire-messages.ts");
const { buildRunDeps, createOutputSink } = await import("../src/cli/output.ts");
T.imports = now() - t0;

const cwd = process.cwd();
let t = now();
const rt = await bootRuntime({});
T.bootRuntime = now() - t;
Bun.gc(true); const rssBoot = process.memoryUsage().rss;

const model = { provider: "anthropic", model: "claude-sonnet-5" };
t = now(); const sys1 = rt.systemPrompt(); T.systemPrompt_skills_memory = now() - t;
t = now(); const def = rt.buildDef(model); T.buildDef_first = now() - t;              // + profile + design + repo map (memoised after)
t = now(); rt.buildDef(model); T.buildDef_second = now() - t;                           // what a second run in the same session pays
t = now(); const cfg = rt.buildCfg("auto"); T.buildCfg = now() - t;
const rssBuildDefPeak = process.memoryUsage().rss; Bun.gc(true); const rss0 = process.memoryUsage().rss; // the repo map's transient vs what it keeps
const promptChars = typeof def.systemPrompt === "string" ? def.systemPrompt.length : -1;
const chunkTokens = (def.contextChunks ?? []).map((c) => `${c.name}:${c.tokens}`).join(" ");

// ---- the scripted run: three tool turns and an answer
const scratch = join(cwd, ".rovecode", "cache", `probe-turn-${process.pid}.txt`);
const inner = mockStream({
  turns: [
    toolTurn([{ id: "c1", tool: "read", args: { path: "src/cli/dispatch.ts" } }]),
    toolTurn([{ id: "c2", tool: "write", args: { path: scratch, content: "probe ".repeat(400) } }]),
    toolTurn([{ id: "c3", tool: "bash", args: { command: "echo ok" } }]),
    textTurn("done: read, wrote, echoed."),
  ],
});
let wireMs = 0, wireCalls = 0, wireBytes = 0;
const stream: StreamFn = async function* (m, msgs, opts) {
  const s = now(); const body = JSON.stringify(toAnthropicMessages(msgs)); wireMs += now() - s; wireCalls++; wireBytes += body.length; // what the adapter would put on the wire
  yield* inner(m, msgs, opts);
};
let appendMs = 0, appends = 0;
const origAppend = rt.store.append.bind(rt.store);
rt.store.append = (e) => { const s = now(); origAppend(e); appendMs += now() - s; appends++; };
let dispatchMs = 0;
const origBatch = rt.registry.dispatchBatch.bind(rt.registry);
(rt.registry as { dispatchBatch: typeof origBatch }).dispatchBatch = async (...a) => { const s = now(); try { return await origBatch(...a); } finally { dispatchMs += now() - s; } };
const nul = { write: (_c: string | Uint8Array): boolean => true };
const sink = createOutputSink("text", { stdout: nul as never, stderr: nul as never, model, messages: () => rt.store.messages() });
const deps = buildRunDeps(rt, stream, sink);
let reminderMs = 0;
const origReminder = deps.planReminder;
if (origReminder) deps.planReminder = (h) => { const s = now(); try { return origReminder(h); } finally { reminderMs += now() - s; } };

const events: { at: number; ev: RunEvent }[] = [];
let sinkMs = 0;
const runStart = now();
for await (const ev of agentLoop(def, "probe: read dispatch.ts, write a scratch file, echo ok, then answer", {}, cfg, deps, rt.steering)) {
  events.push({ at: now() - runStart, ev });
  const s = now(); sink.onEvent(ev); sinkMs += now() - s;
}
const runMs = now() - runStart;
sink.finish();
const rssRunPeak = process.memoryUsage().rss; Bun.gc(true); const rss1 = process.memoryUsage().rss;

// ---- phase accounting from the event timeline
const at = (pred: (e: RunEvent) => boolean, from = 0): number => events.find((e) => e.at >= from && pred(e.ev))?.at ?? -1;
const turns: { turn: number; modelMs: number; toolMs: number; betweenMs: number }[] = [];
let cursor = 0;
for (let n = 1; ; n++) {
  const ts = at((e) => e.type === "turn_start" && e.turn === n, cursor); if (ts < 0) break;
  const te = at((e) => e.type === "turn_end" && e.turn === n, ts);
  const toolStart = at((e) => e.type === "tool_execution_start", te);
  const nextTurn = at((e) => e.type === "turn_start" && e.turn === n + 1, te);
  const end = at((e) => e.type === "run_end", te);
  const toolEnd = toolStart >= 0 ? at((e) => e.type === "tool_execution_end", toolStart) : -1;
  const stop = nextTurn >= 0 ? nextTurn : end;
  turns.push({ turn: n, modelMs: ms(te - ts), toolMs: toolStart >= 0 ? ms(toolEnd - toolStart) : 0, betweenMs: ms(stop - te - (toolStart >= 0 ? toolEnd - toolStart : 0)) });
  cursor = te;
}
// the tool's own duration comes from the event (the loop buffers events and flushes them every 5 ms, so
// arrival times on this side are not when the tool ran)
const toolCalls = events.filter((e) => e.ev.type === "tool_execution_end").map((e) => { const ev = e.ev as Extract<RunEvent, { type: "tool_execution_end" }>; return `${ev.callId}:${ms(ev.durationMs)}ms`; });

// ---- the sextant renderer, replaying the same events, with a paint after each (upper bound)
const { SextantRenderer } = await import("../src/sextant/sextant-renderer.ts");
const { MemoryIO } = await import("../src/tui/sextant-io.ts");
const io = new MemoryIO(160, 44, {});
const r = new SextantRenderer({ io, cwd, scan: false, pet: "rovecode" });
r.start({ onSubmit: () => {}, onInterrupt: () => {}, onExit: () => {} });
let rendererMs = 0, paintMs = 0;
for (const { ev } of events) {
  let s = now(); r.onEvent(ev); rendererMs += now() - s;
  s = now(); r.tick(); paintMs += now() - s;
}
r.stop(); await r.drain().catch(() => {});

console.log(JSON.stringify({
  phases_ms: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, ms(v)])),
  prompt: { chars: promptChars, contextChunks: chunkTokens, tools: deps.tools?.length ?? 0 },
  run: { totalMs: ms(runMs), turns, toolCalls, events: events.length },
  ours_ms: { wireSerialise: ms(wireMs), wireCalls, wireBytes, storeAppend: ms(appendMs), appends, dispatchBatchIncludingTools: ms(dispatchMs), planReminder: ms(reminderMs), sinkOnEvent: ms(sinkMs) },
  renderer_ms: { onEvent: ms(rendererMs), paintPerEvent_upperBound: ms(paintMs), frames: r.frames },
  rss_mb: { afterBoot: mb(rssBoot), buildDefPeak: mb(rssBuildDefPeak), afterBuildDefGc: mb(rss0), runPeak: mb(rssRunPeak), afterRunGc: mb(rss1), runRetained: mb(rss1 - rss0) },
}, null, 1));

// ---- leave nothing behind
try { if (existsSync(scratch)) rmSync(scratch); } catch { /* fine */ }
try { rmSync(join(cwd, ".rovecode", "sessions", rt.store.id), { recursive: true, force: true }); } catch { /* fine */ }
try { rmSync(join(cwd, ".rovecode", "checkpoints", rt.store.id), { recursive: true, force: true }); } catch { /* fine */ } // the shadow-git repo the mutating calls created
await rt.hooks.close().catch(() => {});
await rt.mcp?.close().catch(() => {});
process.exit(0);
