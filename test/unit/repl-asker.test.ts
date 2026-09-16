/** `rovecode --plain` ask_user asker (cli/repl.ts readlineAsker) — WIRE-1 re-verify LOW: on the run's abort
 *  the promise resolved null but rl.question's callback stayed ARMED, so the user's NEXT typed line
 *  was swallowed by the dead callback and readline emitted no `line` event (reachable via Ctrl-C
 *  while a question is pending). The signal now also goes to rl.question, which disarms it. Driven
 *  over a PassThrough readline, so the probe is exact: `line` events after the abort. */

import { test, expect } from "bun:test";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { readlineAsker } from "../../src/cli/repl.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** house hazard: an awaited promise with no pending timer hangs the runner forever */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

function rig() {
  const input = new PassThrough();
  const output = new PassThrough(); output.resume(); // drain the prompt text
  const rl = readline.createInterface({ input, output, terminal: false });
  const lines: string[] = [];
  rl.on("line", (l) => lines.push(l));
  const printed: string[] = [];
  const ask = readlineAsker(rl, (s) => printed.push(s));
  return { input, rl, lines, printed, ask };
}
const Q = { question: "Which database?", options: ["postgres", "sqlite"] };

test("an aborted pending question is DISARMED: the next typed line reaches the repl as a `line` event, and a fresh question still answers", async () => {
  const { input, rl, lines, printed, ask } = rig();
  try {
    const ac = new AbortController();
    const pending = ask(Q, ac.signal);
    expect(printed).toEqual(["\n  question: Which database?", "    1) postgres", "    2) sqlite"]); // numbered options printed
    ac.abort();
    expect(await deadline(pending, 2000, "aborted question")).toBeNull();                       // the run's abort resolves null (unchanged)
    input.write("my next prompt\n");
    await sleep(50);
    expect(lines).toEqual(["my next prompt"]);                                                   // mutation: drop `{ signal }` from rl.question → the dead callback eats it → []
    // the asker is intact afterwards: a typed number answers the next question, not the `line` event
    const p2 = ask(Q, new AbortController().signal);
    input.write("2\n");
    expect(await deadline(p2, 2000, "answered question")).toEqual({ choice: 1, label: "sqlite" });
    expect(lines).toEqual(["my next prompt"]);
    // free text and the empty-line decline keep their meaning
    const p3 = ask({ question: "Name?" }, new AbortController().signal);
    input.write("use mysql\n");
    expect(await deadline(p3, 2000, "free text")).toEqual({ text: "use mysql" });
    const p4 = ask(Q, new AbortController().signal);
    input.write("\n");
    expect(await deadline(p4, 2000, "declined")).toBeNull();
  } finally { rl.close(); }
});
