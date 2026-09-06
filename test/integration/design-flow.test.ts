/** The design protocol end to end, through the REAL pipeline: runTui → createRuntime (which registers
 *  design_audit/design_direction and appends designPromptSection to the system prompt) → agentLoop →
 *  SextantRenderer → an in-memory TerminalIO. Nothing is stubbed but the model.
 *
 *  The claim under test is Berkay's, in his words: "projede bir kez sorsun" — ask once per PROJECT, not
 *  once per task. That is one property spanning two runs, so a unit test cannot hold it: run 1 must find
 *  no direction, ask a real question through the real card, take a real keypress, and write the file;
 *  run 2 must find the answer already in its system prompt and have nothing left to ask. Each half alone
 *  passes while the feature is broken — a tool that records nothing still renders a card, and a prompt
 *  that never asks still says "Chosen direction" once the file exists by other means.
 *
 *  The scripted model plays a well-behaved agent: get → propose → ask_user → set. It does NOT get to
 *  decide whether run 2 re-asks; that is read off the system prompt the runtime actually built, so the
 *  assertion survives a model that would have asked anyway. */

import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetExecutor } from "../../src/core/executor.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";
import type { Message, ModelRef, StreamEvent, StreamFn } from "../../src/core/types.ts";

afterEach(() => resetExecutor());

// ---------- harness (mirrors tui-sextant.test.ts) ----------

async function until(r: SextantRenderer, pred: (frame: string) => boolean, ms = 12_000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    r.tick();
    text = r.frameText();
    if (pred(text)) return text;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`frame never matched within ${ms}ms. last frame:\n${text}`);
}
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
function surface(cwd: string) {
  const io = new MemoryIO(160, 44, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  return { io, renderer };
}
async function quit(io: MemoryIO, renderer: SextantRenderer, app: Promise<void>): Promise<void> {
  io.feed("\x03");
  await deadline(app, 12_000, "runTui after ⌃c");
  await renderer.drain();
}
const lastTool = (messages: Message[]): { name: string; out: string } | null => {
  const m = messages[messages.length - 1];
  if (m?.role !== "tool") return null;
  return { name: "", out: m.parts.map((p) => (p.kind === "tool_result" ? p.output : "")).join("") };
};
const systemText = (messages: Message[]): string =>
  messages.filter((m) => m.role === "system").flatMap((m) => m.parts.map((p) => (p.kind === "text" ? p.text : ""))).join("\n");

// ---------- the three directions, as the prompt demands them ----------

/** Three anchors that disagree on all four axes, with labels short enough for the card. The 60-char
 *  cap is a rule in DESIGN_RULES because ask_user truncates a long option — the test asserts the
 *  labels obey it, so a future rewrite of the worked examples cannot quietly reintroduce the overflow. */
const OPTIONS = [
  "A. Its own output — a real transcript as the first screen",
  "B. The manual — a spec table, colour nearly absent",
  "C. The instrument — a dense live panel, colour = state",
] as const;
const CHOSEN = "The manual"; // option B, the one the keypress below selects

/** get → propose+ask → set → summarise. Each turn is decided by what came back, not by a counter, so
 *  an extra loop turn cannot silently skip a step. */
function designStream(recorded: { system: string[] }): StreamFn {
  return async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    recorded.system.push(systemText(messages));
    const tool = lastTool(messages);
    if (tool === null) {
      yield { type: "turn", turn: toolTurn([{ id: "d1", tool: "design_direction", args: { action: "get" } }]) };
      return;
    }
    if (tool.out.includes("No design direction recorded")) {
      yield {
        type: "turn",
        turn: toolTurn([{ id: "a1", tool: "ask_user", args: { question: "Three directions for this landing page. Which one?", options: [...OPTIONS] } }]),
      };
      return;
    }
    if (tool.out.startsWith("answer:")) {
      yield {
        type: "turn",
        turn: toolTurn([{
          id: "d2", tool: "design_direction",
          args: { action: "set", name: CHOSEN, rationale: "the product is a spec, not a pitch", corners: "sharp", layout: "left" },
        }]),
      };
      return;
    }
    yield { type: "turn", turn: textTurn(`RECORDED ${CHOSEN}`) };
  };
}

/** run 2: whatever the prompt says, this model has nothing to ask — it reports what it was told. */
function secondRunStream(recorded: { system: string[] }): StreamFn {
  return async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    recorded.system.push(systemText(messages));
    yield { type: "turn", turn: textTurn("SECOND RUN DONE") };
  };
}

// ---------- the test ----------

test("ask once per project: run 1 asks through the real card and records the human's pick; run 2 gets it in the system prompt and has nothing to ask", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-designflow-"));
  try {
    // ---- run 1: nothing recorded ----
    const first = { system: [] as string[] };
    const s1 = surface(cwd);
    const app1 = runTui({ renderer: s1.renderer, stream: designStream(first), cwd, yolo: false, exitOnClose: false, model: "scripted" });
    s1.io.feed("build the landing page\r");

    // the prompt this run booted with says the question is still open (mutation: designPromptSection
    // dropped from buildDef → this is absent and the model is never told to ask at all)
    await until(s1.renderer, () => first.system.length > 0);
    expect(first.system[0]).toContain("No design direction is recorded yet");
    expect(first.system[0]).toContain("propose THREE");

    // `get` reads and writes nothing, so it raises NO card: the policy resource is the tool's own
    // mode (types.ts Tool.resource), not its name, and `tool.design_direction get` is allowed.
    // Making the human approve the read would train them to allow the card that matters.

    // the question card is the FIRST card of the run: if `get` had raised one, this would find it
    // (the frame shows the card, and until() would match "needs your permission" before the question)
    expect(s1.renderer.frameText()).not.toContain("needs your permission");

    // the question card, through the real ask_user → renderer.askQuestion seam
    const card = await until(s1.renderer, (f) => f.includes("Three directions for this landing page"));
    for (const label of OPTIONS) {
      expect(label.length).toBeLessThanOrEqual(60);   // the cap DESIGN_RULES states
      expect(card).toContain(label.slice(0, 40));     // and the card really shows each one
    }
    expect(card.toLowerCase()).not.toContain("needs your permission"); // ask_user is kind read: asking never needs approval
    expect(existsSync(join(cwd, ".rovecode", "design.json"))).toBe(false); // nothing written while the question is open

    s1.io.feed("\x1b[B");   // ↓ → option B
    s1.io.feed("\r");       // Enter → answer

    // design_direction set is kind custom → tool.design_direction → PROMPT: the human sees what is
    // being recorded on their behalf, once per project. That prompt is the point, so it is asserted.
    const approval = await until(s1.renderer, (f) => f.includes("needs your permission") && f.includes("design_direction"));
    expect(approval).toContain(CHOSEN);
    expect(existsSync(join(cwd, ".rovecode", "design.json"))).toBe(false); // still nothing before consent
    s1.io.feed("\r");       // Enter on `allow`

    await until(s1.renderer, (f) => f.includes(`RECORDED ${CHOSEN}`));
    await quit(s1.io, s1.renderer, app1);

    // the record: the human's pick, stamped as the human's
    const record = JSON.parse(readFileSync(join(cwd, ".rovecode", "design.json"), "utf8")) as Record<string, unknown>;
    expect(record["name"]).toBe(CHOSEN);
    expect(record["chosenBy"]).toBe("human");
    expect(record["provisional"]).toBeUndefined();
    expect(record["layout"]).toBe("left");
    expect(record["chosenAt"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // ---- run 2: the same project, a fresh process-level run ----
    const second = { system: [] as string[] };
    const s2 = surface(cwd);
    const app2 = runTui({ renderer: s2.renderer, stream: secondRunStream(second), cwd, yolo: false, exitOnClose: false, model: "scripted" });
    s2.io.feed("now add the pricing page\r");
    await until(s2.renderer, (f) => f.includes("SECOND RUN DONE"));

    const sys2 = second.system[0] ?? "";
    expect(sys2).toContain("Chosen direction: The manual");        // the answer is IN the prompt, not re-asked for
    expect(sys2).toContain("Composition: left");                   // and the axes ride along with it
    expect(sys2).toContain("do not re-ask");                       // the instruction that closes the question
    expect(sys2).not.toContain("No design direction is recorded"); // the open-question text is gone
    // the word itself lives in the rules text (the headless clause), so pin the RECORD's heading:
    // a human answered, so the direction block must not be the provisional one
    expect(sys2).not.toContain("PROVISIONAL direction:");
    expect(sys2).not.toContain("PROVISIONAL: build to this");

    // and no second question card was ever raised in this run
    expect(s2.renderer.frameText()).not.toContain("Three directions");
    expect(s2.renderer.state.card).toBeNull();
    await quit(s2.io, s2.renderer, app2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
