/** Port #1 integration: full app loop (agentLoop → Renderer → pi-tui → xterm emulator).
 *  Covers: streaming render, tool cards, gated approval via overlay, steering note, exit. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui, buildCostNote } from "../../src/tui/app.ts";
import { anthropicStream, mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import type { Message, TokenUsage } from "../../src/core/types.ts";

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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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

test("slash command /status renders without starting a run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "m1" });
  term.sendInput("/status");
  term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("provider="));
  expect(screen).toContain("model=m1");
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- ports #5+#6: /cost ----------

test("/cost reports normalized tokens, cache traffic, and origin-priced USD end-to-end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  // hermetic provider resolution (#6 re-verify): a host provider key (e.g. TOGETHER_API_KEY)
  // would win resolveProvider(), stamp Message.origin with THAT provider, and price the model
  // at its catalog entry instead of the zai vendor row ($0.0490 ≠ $0.0245, or "pricing
  // unknown"). Sweep every *_API_KEY out and pin AION_BASE_URL/AION_API_KEY — the override
  // that beats all named keys — so origin.provider is "custom" (no PROVIDER_MAP entry) and
  // pricing always resolves via the zai-org/ vendor prefix, whatever the host env holds.
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined) => {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  for (const k of Object.keys(process.env)) if (k.endsWith("_API_KEY")) setEnv(k, undefined);
  setEnv("AION_BASE_URL", "http://stub.invalid/v1");
  setEnv("AION_API_KEY", "test-key");
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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
  const before = new SessionStore(join(cwd, ".aion", "sessions"), sid).turnPoints();
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

  const reopened = new SessionStore(join(cwd, ".aion", "sessions"), sid);
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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
  await until(term, (s) => s.includes("aion"));
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
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
  expect(rendered).toContain(`# aion session ${short}`);
  expect(rendered).toContain("say something");
  expect(rendered).toContain("exported answer");

  // /export --json → byte-verbatim copy of THIS session's entries.jsonl
  term.sendInput("/export --json"); term.sendInput("\r");
  await until(term, (s) => s.includes("exported jsonl"));
  const jsonlPath = join(cwd, `${short}.jsonl`);
  expect(existsSync(jsonlPath)).toBe(true);
  const src = readFileSync(join(cwd, ".aion", "sessions", sid, "entries.jsonl"));
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
