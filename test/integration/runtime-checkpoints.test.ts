/** Port #11 WIRING tests (MED-4): the shadow-git snapshot hook as createRuntime installs
 *  it (withCheckpoint over write/execute tools), driven through the real agentLoop and —
 *  for the TUI surface — the real app (headless VirtualTerminal, tui-app.test.ts pattern).
 *  runtime.ts itself is never edited or stubbed here: these tests pin its behavior. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntime, type Runtime } from "../../src/cli/runtime.ts";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { SessionStore } from "../../src/core/session.ts";
import { Checkpoints, type Checkpoint } from "../../src/coding/checkpoints.ts";
import { mockStream, textTurn, toolTurn, type MockScript } from "../../src/providers/stream.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui } from "../../src/tui/app.ts";

function tmp(): string { return mkdtempSync(join(tmpdir(), "rovecode-rtcp-")); }

/** Build the runtime exactly like main.ts/repl.ts do and drain one scripted run. */
async function drive(cwd: string, sessionId: string, turns: MockScript["turns"], goal = "go"): Promise<Runtime> {
  const rt = createRuntime({ cwd, sessionId, stream: mockStream({ turns }) });
  const deps = { stream: rt.stream!, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard };
  for await (const ev of agentLoop(rt.buildDef({ provider: "mock", model: "scripted" }), goal, {}, rt.buildCfg(true), deps, new SteeringQueue())) void ev;
  return rt;
}

function sidecarPath(cwd: string, sid: string): string { return join(cwd, ".rovecode", "checkpoints", sid, "checkpoints.jsonl"); }

function firstSnapshot(cwd: string, sid: string): Checkpoint {
  return JSON.parse(readFileSync(sidecarPath(cwd, sid), "utf8").trim().split("\n")[0]!) as Checkpoint;
}

test("wiring (a): a FAILED mutating tool never snapshots; the next successful one does", async () => {
  const cwd = tmp();
  const sid = randomUUID();
  // edit a file that does not exist → ok:false from the tool (kind "write")
  await drive(cwd, sid, [
    toolTurn([{ id: "t1", tool: "edit", args: { path: join(cwd, "missing.txt"), edits: [{ tag: "0000", anchorLine: 1, anchorHash: "00", newLines: ["x"] }] } }]),
    textTurn("gave up"),
  ]);
  // the hook must not have touched checkpoints at all — not even lazy init
  expect(existsSync(join(cwd, ".rovecode", "checkpoints", sid))).toBe(false);

  // same session, new runtime: a successful write snapshots exactly once
  await drive(cwd, sid, [
    toolTurn([{ id: "t2", tool: "write", args: { path: join(cwd, "a.txt"), content: "v1" } }]),
    textTurn("done"),
  ]);
  const cp = await Checkpoints.init({ workspace: cwd, sessionId: sid });
  expect(cp.list().map((c) => c.label)).toEqual(["write"]);
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("wiring (b): ROVECODE_NO_CHECKPOINTS=1 kills snapshots while every tool keeps working", async () => {
  const cwd = tmp();
  const sid = randomUUID();
  const saved = process.env.ROVECODE_NO_CHECKPOINTS;
  try {
    process.env.ROVECODE_NO_CHECKPOINTS = "1";
    await drive(cwd, sid, [
      toolTurn([{ id: "t1", tool: "write", args: { path: join(cwd, "kill.txt"), content: "works" } }]),
      textTurn("done"),
    ]);
    expect(readFileSync(join(cwd, "kill.txt"), "utf8")).toBe("works"); // the tool itself ran
    expect(existsSync(join(cwd, ".rovecode", "checkpoints"))).toBe(false); // zero shadow repos
  } finally {
    if (saved === undefined) delete process.env.ROVECODE_NO_CHECKPOINTS; else process.env.ROVECODE_NO_CHECKPOINTS = saved;
  }
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

// HIGH-2 wiring pin: runtime.ts anchors snapshots at anchorEntryId(activeStore.messages())
// — the last USER message — so a conversation restore never strands the tool-issuing
// assistant turn's tool_calls without replies (provider 400). Reverting the anchor to
// .at(-1)?.id turns this red.
test("wiring (c): snapshot entryId anchors the LAST USER message", async () => {
  const cwd = tmp();
  const sid = randomUUID();
  await drive(cwd, sid, [
    toolTurn([{ id: "t1", tool: "write", args: { path: join(cwd, "a.txt"), content: "v1" } }]),
    textTurn("done"),
  ]);
  const snap = firstSnapshot(cwd, sid);
  const store = new SessionStore(join(cwd, ".rovecode", "sessions"), sid);
  const lastUser = store.messages().findLast((m) => m.role === "user")!;
  expect(snap.entryId).toBe(lastUser.id); // anchorEntryId: branching here never strands tool_calls
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("wiring (c'): the recorded anchor exists in THIS session's tree and is branchable", async () => {
  const cwd = tmp();
  const sid = randomUUID();
  await drive(cwd, sid, [
    toolTurn([{ id: "t1", tool: "write", args: { path: join(cwd, "a.txt"), content: "v1" } }]),
    textTurn("done"),
  ]);
  const snap = firstSnapshot(cwd, sid);
  expect(typeof snap.entryId).toBe("string"); // captured (activeStore matched the session)
  const store = new SessionStore(join(cwd, ".rovecode", "sessions"), sid);
  expect(store.branch(snap.entryId!)).toBe(true);
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

// ---------- TUI surface (headless, tui-app.test.ts pattern) ----------

async function until(term: VirtualTerminal, pred: (screen: string) => boolean, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    text = (await term.flushAndGetViewport()).join("\n");
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  return text;
}

test("wiring (d): /checkpoints lists the snapshot and /restore rolls the workspace back", async () => {
  const cwd = tmp();
  const sid = randomUUID();
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "cp.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "snapshotted\n" } }]),
      textTurn("wrote it."),
    ],
  });
  const app = runTui({ renderer, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("write the file"); term.sendInput("\r");
  await until(term, (s) => s.includes("wrote it."));
  await new Promise((r) => setTimeout(r, 150)); // let run_end clear busy before slash commands

  const snap = firstSnapshot(cwd, sid); // the hook snapshotted before the final model turn
  term.sendInput("/checkpoints"); term.sendInput("\r");
  const listed = await until(term, (s) => s.includes("#1 write"));
  expect(listed).toContain(snap.hash.slice(0, 8));
  term.sendInput("\r"); // pick the entry → restore hint (restore is an explicit second step)
  await until(term, (s) => s.includes("restore with: /restore"));

  writeFileSync(probe, "dirty\n"); // out-of-band damage for /restore to rewind
  term.sendInput(`/restore ${snap.hash.slice(0, 8)}`); term.sendInput("\r");
  const done = await until(term, (s) => s.includes("workspace rolled back"));
  expect(done).toContain(`restored ${snap.hash.slice(0, 8)}`);
  expect(readFileSync(probe, "utf8")).toBe("snapshotted\n");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);
