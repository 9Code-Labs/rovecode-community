/** Port #1 integration: full app loop (agentLoop → Renderer → pi-tui → xterm emulator).
 *  Covers: streaming render, tool cards, gated approval via overlay, steering note, exit. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import { partsText } from "../../src/core/loop.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui, buildCostNote } from "../../src/tui/app.ts";
import { anthropicStream, mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";
import type { Message, ModelRef, StreamEvent, StreamFn, TokenUsage } from "../../src/core/types.ts";

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

test("yolo run renders markdown + tool card end-to-end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "e2e.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "e2e\n" } }]),
      textTurn("# Done\n\nwrote the file."),
    ],
  });
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("do the thing");
  term.sendInput("\r");

  const screen = await until(term, (s) => s.includes("Done") && s.includes("write"));
  expect(screen).toContain("Done");
  expect(screen).toContain("write");          // tool card
  expect(screen).toContain("do the thing");   // user echo
  expect(existsSync(probe)).toBe(true);
  expect(readFileSync(probe, "utf8")).toBe("e2e\n");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("gated run: write tool requires approval; Enter approves once and the write lands", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "gated.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "approved\n" } }]),
      textTurn("finished."),
    ],
  });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("write it");
  term.sendInput("\r");

  const asked = await until(term, (s) => s.toLowerCase().includes("approval"));
  expect(asked.toLowerCase()).toContain("approval");
  expect(existsSync(probe)).toBe(false);       // nothing written before consent

  term.sendInput("\r");                        // select first option: allow once
  const done = await until(term, (s) => s.includes("finished"));
  expect(done).toContain("finished");
  expect(existsSync(probe)).toBe(true);
  expect(readFileSync(probe, "utf8")).toBe("approved\n");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("closing mid-run is clean: the run's finally after renderer.stop() must not reject", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const rejections: unknown[] = [];
  const collect = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", collect);
  try {
    // busy long enough for Ctrl+C to land mid-run, but SHORT enough that the run's
    // finally executes inside this test — that finally is the crash under test
    const slow = async function* () {
      await new Promise((r) => setTimeout(r, 400));
      yield { type: "turn" as const, turn: textTurn("late") };
    };
    const app = runTui({ renderer, stream: slow, cwd, yolo: true, exitOnClose: false, model: "scripted" });
    term.sendInput("go");
    term.sendInput("\r");
    await until(term, (s) => s.includes("> go"));
    term.sendInput("\x03"); // exit while the run is in flight
    await app;              // must resolve
    await new Promise((r) => setTimeout(r, 700)); // let the run's finally fire post-stop
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", collect);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("slash command /status renders without starting a run — incl. the active sandbox rung + origin (port #27 LOW-1)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  // hermetic rung: a host ROVECODE_SANDBOX would change the line; createRuntime reads env synchronously inside runTui()
  const savedSandbox = process.env.ROVECODE_SANDBOX;
  delete process.env.ROVECODE_SANDBOX;
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "m1" });
  if (savedSandbox !== undefined) process.env.ROVECODE_SANDBOX = savedSandbox;
  term.sendInput("/status");
  term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("provider="));
  expect(screen).toContain("model=m1");
  expect(screen).toContain("sandbox: direct (default)"); // describeSandbox: rung + where it came from
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- ports #5+#6: /cost ----------

test("/cost reports normalized tokens, cache traffic, and origin-priced USD end-to-end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  // hermetic provider resolution (#6 re-verify): a host provider key (e.g. TOGETHER_API_KEY)
  // would win resolveProvider(), stamp Message.origin with THAT provider, and price the model
  // at its catalog entry instead of the zai vendor row ($0.0490 ≠ $0.0245, or "pricing
  // unknown"). Sweep every *_API_KEY out and pin ROVECODE_BASE_URL/ROVECODE_API_KEY — the override
  // that beats all named keys — so origin.provider is "custom" (no PROVIDER_MAP entry) and
  // pricing always resolves via the zai-org/ vendor prefix, whatever the host env holds.
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined) => {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  for (const k of Object.keys(process.env)) if (k.endsWith("_API_KEY")) setEnv(k, undefined);
  setEnv("ROVECODE_BASE_URL", "http://stub.invalid/v1");
  setEnv("ROVECODE_API_KEY", "test-key");
  // the REAL Anthropic adapter against a stubbed wire, so usage flows
  // fetch → parseAnthropicResponse → normalizeUsage → Message.usage → /cost
  // (a mock stream would bypass the parsers and leave their cache fields untested)
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    content: [{ type: "text", text: "answered." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100000, output_tokens: 50000, cache_read_input_tokens: 300000, cache_creation_input_tokens: 20000 },
  }), { status: 200 })) as unknown as typeof fetch;
  try {
    const stream = anthropicStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "zai-org/glm-5.3-flash" });
    term.sendInput("how much did that cost"); term.sendInput("\r");
    await until(term, (s) => s.includes("answered."));

    term.sendInput("/cost"); term.sendInput("\r");
    const screen = await until(term, (s) => s.includes("estimated cost"));
    // normalized usage summed off the assistant message the loop stored
    expect(screen).toContain("100000 in / 50000 out");
    expect(screen).toContain("300000 read / 20000 written");
    // priced at the message's ORIGIN model, resolved via the zai-org/ vendor prefix
    // (independent of whatever provider the host env resolves):
    // 0.1M×$0.075 + 0.05M×$0.25 + 0.3M×$0.015 + 0.02M×$0.00 = $0.0245
    expect(screen).toContain("$0.0245");

    term.sendInput("\x03");
    await app;
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("buildCostNote prices per message at its ORIGIN model, with explicit caveats", () => {
  const catalog = new ModelCatalog();
  const mk = (usage: TokenUsage, origin?: { provider: string; model: string }): Message => ({
    id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: "x" }],
    parentId: null, createdAt: 0, usage, ...(origin ? { origin } : {}),
  });
  const messages: Message[] = [
    mk({ input: 1_000_000, output: 0 }, { provider: "anthropic", model: "claude-haiku-4-5" }),   // $1.000
    mk({ input: 1_000_000, output: 0 }, { provider: "kaesra", model: "zai-org/glm-5.3-flash" }), // $0.075
    mk({ input: 1_000_000, output: 0 }),                                       // no origin → current model
    mk({ input: 5, output: 5 }, { provider: "kaesra", model: "no-such-model" }), // unpriceable
  ];
  const note = buildCostNote(messages, catalog, { provider: "anthropic", model: "claude-haiku-4-5" });
  // $1.00 (haiku) + $0.075 (glm via its origin — whole-session pricing at haiku would say $1.00)
  // + $1.00 (origin-less fallback to the current model) = $2.0750
  expect(note).toContain("estimated cost: $2.0750");
  expect(note).toContain("1 message unpriced (lower bound)");
  expect(note).toContain("1 without origin priced at the current model");
  expect(note).toContain("tokens: 3000005 in / 5 out");
});

test("/status surfaces harvested config sources incl. truncation state (port #8 HIGH-2)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  writeFileSync(join(cwd, "AGENTS.md"), "y\n".repeat(5000), "utf8"); // 10,000 chars > 8,000 per-file cap
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "m1" });
  term.sendInput("/status");
  term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("config:"));
  expect(screen).toContain("AGENTS.md (truncated)");
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- port #2: rewind + resume ----------

test("rewind: pick an earlier turn, transcript truncates, editor prefills, resubmit forks the tree", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const sid = randomUUID();
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const stream = mockStream({
    turns: [textTurn("first answer"), textTurn("second answer"), textTurn("branch answer")],
  });
  const app = runTui({ renderer, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });

  term.sendInput("question one"); term.sendInput("\r");
  await until(term, (s) => s.includes("first answer"));
  // >80 chars so the overlay label truncates but the prefill must NOT (critic HIGH-1)
  const q2text = `question two ${"x".repeat(70)} END-MARKER`;
  term.sendInput(q2text); term.sendInput("\r");
  await until(term, (s) => s.includes("second answer"));

  // capture the pre-rewind tree: [q1, q2]; q2's parent is what the leaf must move to
  const before = new SessionStore(join(cwd, ".rovecode", "sessions"), sid).turnPoints();
  expect(before.length).toBe(2);
  const q2 = before[1]!;

  term.sendInput("/rewind"); term.sendInput("\r");
  await until(term, (s) => s.includes("#2"));   // overlay: recent turn first
  term.sendInput("\r");                          // pick #2 "question two"

  const afterRewind = await until(term, (s) => !s.includes("second answer") && s.includes("first answer"));
  expect(afterRewind).toContain("first answer");        // history up to the rewind point
  expect(afterRewind).not.toContain("second answer");   // truncated from view (kept on disk)
  expect(afterRewind).toContain("question two");        // prefilled in the editor
  expect(afterRewind).toContain("END-MARKER");          // FULL text prefilled, not the ≤80 label

  term.sendInput(" edited"); term.sendInput("\r");       // edit-and-resubmit → new branch
  await until(term, (s) => s.includes("branch answer"));

  const reopened = new SessionStore(join(cwd, ".rovecode", "sessions"), sid);
  const points = reopened.turnPoints();
  expect(points.length).toBe(2);                         // [q1, q2-edited] — NOT 3
  const last = points[points.length - 1]!;
  expect(last.fullText).toBe(`${q2text} edited`);        // untruncated round-trip
  expect(last.branches).toBe(1);                         // the abandoned "question two" sibling
  // pi sessions.md:106: the leaf moved to the TURN'S PARENT, so the resubmission is a
  // SIBLING of the old turn (same parent) — branching to the turn itself would fail this
  expect(last.parentId).toBe(q2.parentId);
  expect(last.entryId).not.toBe(q2.entryId);

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("resume: /resume <id-prefix> swaps sessions and replays the old transcript", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const oldId = randomUUID();

  // session 1: one exchange, then close
  {
    const term = new VirtualTerminal(80, 24);
    const renderer = new PiTuiRenderer({ terminal: term, cwd });
    const stream = mockStream({ turns: [textTurn("noted forever")] });
    const app = runTui({ renderer, stream, cwd, sessionId: oldId, yolo: true, exitOnClose: false, model: "scripted" });
    term.sendInput("remember me"); term.sendInput("\r");
    await until(term, (s) => s.includes("noted forever"));
    term.sendInput("\x03");
    await app;
  }

  // session 2 (fresh): resume the old one headlessly by id prefix
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  await until(term, (s) => s.includes("rovecode"));
  term.sendInput(`/resume ${oldId.slice(0, 8)}`); term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("noted forever"));
  expect(screen).toContain("remember me");
  expect(screen).toContain("noted forever");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

// ---------- port #38: /export ----------

test("/export writes <short>.md, --json copies the JSONL byte-verbatim, a spaced path stays whole, no silent overwrite", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const sid = randomUUID();
  const short = sid.slice(0, 8);
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const stream = mockStream({ turns: [textTurn("exported answer")] });
  const app = runTui({ renderer, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("say something"); term.sendInput("\r");
  // wait for the run's finally (busy loader gone) so the store is settled before exporting
  await until(term, (s) => s.includes("exported answer") && !s.includes("thinking"));

  // /export → <cwd>/<short>.md (markdown over the active path)
  term.sendInput("/export"); term.sendInput("\r");
  const noted = await until(term, (s) => s.includes("exported markdown"));
  expect(noted).toContain("exported markdown");
  const mdPath = join(cwd, `${short}.md`);
  expect(existsSync(mdPath)).toBe(true);
  const rendered = readFileSync(mdPath, "utf8");
  expect(rendered).toContain(`# rovecode session ${short}`);
  expect(rendered).toContain("say something");
  expect(rendered).toContain("exported answer");

  // /export --json → byte-verbatim copy of THIS session's entries.jsonl
  term.sendInput("/export --json"); term.sendInput("\r");
  await until(term, (s) => s.includes("exported jsonl"));
  const jsonlPath = join(cwd, `${short}.jsonl`);
  expect(existsSync(jsonlPath)).toBe(true);
  const src = readFileSync(join(cwd, ".rovecode", "sessions", sid, "entries.jsonl"));
  expect(Buffer.compare(readFileSync(jsonlPath), src)).toBe(0);

  // /export <path with spaces> → ONE path, not the first word (LOW-3 wrote a file named "my")
  const spaced = join(cwd, "my file.md");
  term.sendInput("/export my file.md"); term.sendInput("\r");
  await until(term, () => existsSync(spaced));
  expect(existsSync(spaced)).toBe(true);
  expect(existsSync(join(cwd, "my"))).toBe(false);

  // a second /export without --force refuses — and the TUI survives the error note
  term.sendInput("/export"); term.sendInput("\r");
  const refused = await until(term, (s) => s.includes("refusing to overwrite"));
  expect(refused).toContain("refusing to overwrite");
  term.sendInput("/status"); term.sendInput("\r");
  const alive = await until(term, (s) => s.includes("provider="));
  expect(alive).toContain("model=scripted");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

// ---------- port #24: diff preview in the approval overlay ----------

/** gated TUI whose first scripted turn is an anchored edit of notes.txt (old-line → new-line).
 *  Absolute tool path, like the other scripted calls in this file; the RELATIVE-path case
 *  (LoopDeps.cwd threaded, so tools resolve against rt.cwd like the preview) is covered below. */
function gatedEditApp(cwd: string, term: VirtualTerminal, finalText: string) {
  const target = join(cwd, "notes.txt");
  const content = "keep-1\nold-line\nkeep-2\n";
  writeFileSync(target, content);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const edit = { path: target, edits: [{ tag: fileTag(content), anchorLine: 2, anchorHash: lineHash("old-line"), newLines: ["new-line"] }] };
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "edit", args: edit }]), textTurn(finalText)] });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("edit it"); term.sendInput("\r");
  return { app, target, content };
}

test("gated edit: the overlay shows the unified diff before consent; Escape denies and the file is untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const { app, target, content } = gatedEditApp(cwd, term, "after denial.");

  const card = await until(term, (s) => s.includes("+new-line"));
  expect(card).toContain("approval needed: edit");
  expect(card).toContain("--- a/notes.txt");            // file headers
  expect(card).toContain("+++ b/notes.txt");
  expect(card).toContain("@@ -1,3 +1,3 @@");            // hunk header
  expect(card).toContain("-old-line");
  expect(card).toContain("+new-line");
  expect(card).toContain(" keep-1");                    // context line
  expect(card).toContain("allow once");                 // verdict list sits below the diff
  expect(card).toContain("deny");
  expect(readFileSync(target, "utf8")).toBe(content);   // nothing applied before consent

  term.sendInput("\x1b");                               // Escape → deny (deny path unchanged)
  const after = await until(term, (s) => s.includes("after denial."));
  expect(after).not.toContain("+new-line");             // overlay gone
  expect(after).not.toContain("allow once");
  expect(readFileSync(target, "utf8")).toBe(content);   // denied → file unchanged

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("gated edit: allow once applies exactly the previewed change", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const { app, target } = gatedEditApp(cwd, term, "applied.");
  const card = await until(term, (s) => s.includes("+new-line"));
  expect(card).toContain("+new-line");                  // the diff card was ON SCREEN before consent (port #24 LOW: assert, not just wait)
  expect(card).toContain("-old-line");
  expect(card).toContain("allow once");
  term.sendInput("\r");                                 // first item: allow once
  const done = await until(term, (s) => s.includes("applied."));
  expect(done).toContain("applied.");
  expect(readFileSync(target, "utf8")).toBe("keep-1\nnew-line\nkeep-2\n");
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("gated write of a new file: the overlay shows an all-adds diff against /dev/null", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "fresh.txt");
  const stream = mockStream({
    turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "alpha\nbeta\n" } }]), textTurn("created.")],
  });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("make it"); term.sendInput("\r");

  const card = await until(term, (s) => s.includes("+beta"));
  expect(card).toContain("--- /dev/null");
  expect(card).toContain("+++ b/fresh.txt");
  expect(card).toContain("@@ -0,0 +1,2 @@");
  expect(card).toContain("+alpha");
  expect(card).toContain("+beta");
  expect(card).not.toContain("-alpha");                 // create = adds only
  expect(existsSync(probe)).toBe(false);                // not written before consent

  term.sendInput("\r");                                 // allow once
  await until(term, (s) => s.includes("created."));
  expect(readFileSync(probe, "utf8")).toBe("alpha\nbeta\n");
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- LoopDeps.cwd threading: relative tool paths resolve against the TUI's cwd ----------

test("relative tool paths resolve against runTui({cwd}), not process.cwd(): the write lands under cwd and the follow-up edit applies", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  mkdirSync(join(cwd, "out"));                            // write does not mkdir -p: out/ exists ONLY under the TUI's cwd
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const content = "alpha\nbeta\n";
  const edit = { path: "out/rel.txt", edits: [{ tag: fileTag(content), anchorLine: 1, anchorHash: lineHash("alpha"), newLines: ["ALPHA"] }] };
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: "out/rel.txt", content } }]),
      toolTurn([{ id: "t2", tool: "edit", args: edit }]),
      textTurn("relative done."),
    ],
  });
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("use relative paths"); term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("relative done."));

  const target = join(cwd, "out", "rel.txt");
  expect(existsSync(target)).toBe(true);                                 // landed under the TUI's cwd …
  expect(existsSync(join(process.cwd(), "out", "rel.txt"))).toBe(false); // … not under the process dir
  expect(readFileSync(target, "utf8")).toBe("ALPHA\nbeta\n");            // the anchored edit found the file the write created
  expect(screen).not.toContain("Edit rejected");                         // without cwd: "line 0 out of range (file has 0 lines)"

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- port #33: ask_user question overlay ----------

/** Provider script for the ask_user e2e: turn 1 issues the question; once the tool answered (last
 *  message role tool) the NEXT turn echoes the tool result — proving the answer reached the model. */
function askStream(args: unknown): StreamFn {
  return async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const last = messages[messages.length - 1];
    if (last?.role === "tool") {
      const out = last.parts.map((p) => (p.kind === "tool_result" ? p.output : "")).join("");
      yield { type: "turn", turn: textTurn(`MODEL-SAW ${out}`) };
      return;
    }
    yield { type: "turn", turn: toolTurn([{ id: "ask-1", tool: "ask_user", args }]) };
  };
}

const DB_ARGS = { question: "Which database?", options: ["postgres", "sqlite"] };

test("ask_user e2e (gated): the overlay shows the options with NO approval prompt; Down+Enter answers and the next model turn sees `answer: sqlite`", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: askStream(DB_ARGS), cwd, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("pick a db"); term.sendInput("\r");

  const card = await until(term, (s) => s.includes("type an answer…"));
  expect(card).toContain("Which database?");
  expect(card).toContain("→ postgres");                     // options rendered, first selected (mutation: renderer ignores options → fails)
  expect(card).toContain("sqlite");
  expect(card).toContain("Esc stop the run");               // busy hint: Escape interrupts the run
  expect(card.toLowerCase()).not.toContain("approval");     // kind read: asking never needs approval under gated rules

  term.sendInput("\x1b[B");                                  // down → sqlite
  term.sendInput("\r");
  const done = await until(term, (s) => s.includes("MODEL-SAW"));
  expect(done).toContain("MODEL-SAW answer: sqlite");        // the chosen label rode the tool result into the next turn (mutation: getter always undefined → fails)
  expect(done).toContain("← ok ask_user");                   // tool card closed green
  expect(done).not.toContain("type an answer…");             // overlay gone

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);
// ---------- port #30: custom slash commands (.rovecode/commands/*.md) ----------

test("custom commands e2e: palette + /help list /hello, dispatch submits the rendered $ARGUMENTS prompt as the user turn, mode: plan flips the indicator, model: overrides per run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-home-"));
  const savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home; // hermetic user scope: the host's real ~/.rovecode/commands must not leak in
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "commands", "hello.md"), "---\ndescription: Say hello to someone\n---\nSay hi to $ARGUMENTS\n", "utf8");
  writeFileSync(join(cwd, ".rovecode", "commands", "plan-it.md"), "---\ndescription: Plan a change\nmode: plan\nmodel: fast-model\n---\nPlan: $ARGUMENTS\n", "utf8");
  writeFileSync(join(cwd, ".rovecode", "commands", "help.md"), "must lose to the built-in\n", "utf8");
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  // capture what the loop actually sends: the ModelRef and the latest user message text
  const seen: { model: string; user: string }[] = [];
  const inner = mockStream({ turns: [textTurn("hello-answer"), textTurn("plan-answer")] });
  const stream: StreamFn = (model, messages, options) => {
    const last = [...messages].reverse().find((m) => m.role === "user");
    seen.push({ model: model.model, user: last ? partsText(last.parts) : "" });
    return inner(model, messages, options);
  };
  try {
    const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
    // boot: the built-in collision is reported, the built-in kept
    const booted = await until(term, (s) => s.includes("built-in kept"));
    expect(booted).toContain("/help is a built-in command");

    // autocomplete palette: the custom command sits next to the built-ins
    term.sendInput("/hel");
    const palette = await until(term, (s) => s.includes("Say hello to someone"));
    expect(palette).toContain("hello");
    // finish the line; the space ends command matching (no argument completions) so the popup
    // closes, then Enter submits "/hello world" through onSubmit → handleSlash → default
    term.sendInput("lo world");
    await until(term, (s) => !s.includes("Say hello to someone"));
    term.sendInput("\r");
    const answered = await until(term, (s) => s.includes("hello-answer"));
    expect(answered).toContain("> Say hi to world");   // the rendered prompt IS the echoed user turn
    expect(seen).toEqual([{ model: "scripted", user: "Say hi to world" }]); // the model saw the rendered text, not "/hello world"

    // /help lists it under the custom header, with its placeholder hint and scope
    term.sendInput("/help"); term.sendInput("\r");
    const help = await until(term, (s) => s.includes("custom:"));
    expect(help).toContain("/hello $ARGUMENTS — Say hello to someone (project)");

    // mode: plan switches the indicator (and stays); model: fast-model is used for THIS run only
    term.sendInput("/plan-it the thing"); term.sendInput("\r");
    const planned = await until(term, (s) => s.includes("plan-answer") && s.includes("/scripted ·") && !s.includes("thinking"));
    expect(planned).toContain("plan · ");               // status line carries the switched mode
    expect(planned).toContain("read-only tools");        // switched through the /plan path (its note)
    expect(planned).toContain("> Plan: the thing");
    expect(seen[1]).toEqual({ model: "fast-model", user: "Plan: the thing" }); // the run used the command's model…
    expect(planned).toContain("/scripted ·");            // …and the status line is back on the session model

    term.sendInput("\x03");
    await app;
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("ask_user e2e: free text — pick 'type an answer…', type, Enter → the model sees the typed text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: askStream(DB_ARGS), cwd, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("pick a db"); term.sendInput("\r");
  await until(term, (s) => s.includes("type an answer…"));

  term.sendInput("\x1b[B"); term.sendInput("\x1b[B"); term.sendInput("\r"); // third entry: type an answer…
  const input = await until(term, (s) => s.includes("Enter sends"));
  expect(input).toContain("Enter sends · Esc back to the options");
  term.sendInput("use mysql"); term.sendInput("\r");
  const done = await until(term, (s) => s.includes("MODEL-SAW"));
  expect(done).toContain("MODEL-SAW answer: use mysql");
  expect(done).not.toContain("Enter sends");                 // input overlay gone

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("ask_user e2e: Esc while the question is open interrupts the run — overlay gone, run aborted (failed result stored), TUI alive", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiapp-"));
  const sid = randomUUID();
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: askStream(DB_ARGS), cwd, sessionId: sid, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("pick a db"); term.sendInput("\r");
  await until(term, (s) => s.includes("type an answer…"));

  term.sendInput("\x1b");                                    // Esc → onInterrupt → runAbort.abort() → the signal dismisses the card
  const after = await until(term, (s) => s.includes("run interrupted") && !s.includes("type an answer…") && !s.includes("thinking…"));
  expect(after).toContain("run interrupted");
  expect(after).not.toContain("type an answer…");            // overlay dismissed via the signal (mutation: signal not honored → stays)
  expect(after).not.toContain("MODEL-SAW");                  // the run did NOT continue to another model turn
  expect(after).not.toContain("thinking…");                  // busy cleared: the run settled

  term.sendInput("/status"); term.sendInput("\r");            // TUI alive
  const alive = await until(term, (s) => s.includes("provider="));
  expect(alive).toContain("model=scripted");
  // wire-well-formed store: the issued call has a FAILED result mentioning the abort
  const toolMsgs = new SessionStore(join(cwd, ".rovecode", "sessions"), sid).messages().filter((m) => m.role === "tool");
  expect(toolMsgs.length).toBe(1);
  const part = toolMsgs[0]!.parts[0]!;
  if (part.kind !== "tool_result") throw new Error("expected tool_result part");
  expect(part.callId).toBe("ask-1");
  expect(part.ok).toBe(false);
  expect(part.output.toLowerCase()).toContain("aborted");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);
