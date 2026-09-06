/** `git diff | rovecode run "review this"`: piped stdin becomes a fenced block under the prompt (cli/output.ts
 *  readPipedStdin + withPipedInput), never read from a terminal, never waited on forever, and it reaches the
 *  run — the run_start event's goal carries it. */

import { expect, test } from "bun:test";
import { VALUE_FLAGS, parseCli } from "../../src/cli/dispatch.ts";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPipedStdin, runPromptWords, withPipedInput } from "../../src/cli/output.ts";

const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

test("runPromptWords drops EVERY post-command value flag's value, not only --output's: `run hi --max-turns 1` is the prompt 'hi', not 'hi 1'", () => {
  // found while wiring stdin: the goal of `rovecode run "hi" --output json --max-turns 1` was recorded as "hi 1"
  const argv = ["bun", "main.ts", "run", "hi", "--output", "json", "--max-turns", "1", "--max-seconds", "30"];
  expect(runPromptWords({ cmd: "run", rest: ["hi", "json", "1", "30"] }, argv)).toEqual(["hi"]);
  const bare = ["bun", "main.ts", "review", "this", "--max-turns", "2"];
  expect(runPromptWords({ cmd: "review", rest: ["this", "2"] }, bare)).toEqual(["review", "this"]);
  // a value that is itself a word the user typed is dropped by POSITION, so a prompt may still say "json"
  const word = ["bun", "main.ts", "run", "explain", "json", "--max-turns", "3"];
  expect(runPromptWords({ cmd: "run", rest: ["explain", "json", "3"] }, word)).toEqual(["explain", "json"]);
});

test("withPipedInput: fenced under the prompt; the fence outgrows backticks in the text; no words → an introduction; empty → unchanged", () => {
  expect(withPipedInput("review this", "line 1\nline 2\n")).toBe("review this\n\n```\nline 1\nline 2\n```");
  expect(withPipedInput("review this", "has ``` inside")).toBe("review this\n\n````\nhas ``` inside\n````");
  expect(withPipedInput("", "x")).toBe("Here is the input:\n\n```\nx\n```");
  expect(withPipedInput("prompt", "")).toBe("prompt");
  expect(withPipedInput("prompt", "\r\nwin\r\n")).toBe("prompt\n\n```\n\nwin\n```");   // CRLF normalised, trailing newlines dropped
});

test("readPipedStdin: a TTY is never read; a pipe is read to EOF; an idle pipe is given up on at the first-byte deadline with a note; the cap trims with a note", async () => {
  const tty = new PassThrough() as PassThrough & { isTTY?: boolean }; tty.isTTY = true;
  expect(await readPipedStdin(tty)).toBe("");

  const pipe = new PassThrough();
  const reading = readPipedStdin(pipe);
  pipe.write("hello "); setTimeout(() => { pipe.write("world"); pipe.end(); }, 20);
  expect(await reading).toBe("hello world");

  const notes: string[] = [];
  const idle = new PassThrough();
  const t0 = Date.now();
  expect(await readPipedStdin(idle, { firstByteMs: 60, note: (l) => notes.push(l) })).toBe("");
  expect(Date.now() - t0).toBeLessThan(1_000);
  expect(notes[0]).toContain("nothing arrived");

  const big = new PassThrough(); const bigNotes: string[] = [];
  const bigRead = readPipedStdin(big, { maxChars: 10, note: (l) => bigNotes.push(l) });
  big.end("0123456789ABCDEF");
  expect(await bigRead).toBe("0123456789");
  expect(bigNotes[0]).toContain("kept the first 10");
});

test("end to end: the piped text is in the run's goal; stdin 'ignore' costs no wait; --no-stdin ignores a pipe", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-stdin-"));
  const env = { ...process.env, ROVECODE_HOME: mkdtempSync(join(tmpdir(), "rovecode-stdin-home-")), ROVECODE_MOCK: "1", ROVECODE_NO_CHECKPOINTS: "1" };
  const run = async (args: string[], stdin: "ignore" | string) => {
    const t0 = Date.now();
    const p = Bun.spawn([process.execPath, MAIN, "run", ...args, "--output", "ndjson", "--max-turns", "1"], { cwd, env, stdin: stdin === "ignore" ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (stdin !== "ignore" && p.stdin && typeof p.stdin !== "number") { p.stdin.write(stdin); p.stdin.end(); }
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    const start = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; goal?: string }).find((e) => e.type === "run_start");
    return { code, goal: start?.goal ?? "", err, ms: Date.now() - t0 };
  };
  try {
    const piped = await run(["review this"], "diff --git a/x b/x\n+added line\n");
    expect(piped.code).toBe(0);
    expect(piped.goal).toBe("review this\n\n```\ndiff --git a/x b/x\n+added line\n```");

    const ignored = await run(["hello there"], "ignore");
    expect(ignored.goal).toBe("hello there");
    expect(ignored.err).not.toContain("stdin:");                    // a closed stdin is EOF, not a 3 s wait
    expect(ignored.ms).toBeLessThan(2_500);

    const skipped = await run(["hello there", "--no-stdin"], "not wanted\n");
    expect(skipped.goal).toBe("hello there");
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(env.ROVECODE_HOME, { recursive: true, force: true }); }
}, 30_000);

test("every value flag's value stays out of the prompt — including --max-cost, which was sending its number to the model", () => {
  // Measured, not hypothetical: `run "yazi golgesi gozukmuyor" --max-cost 0.15` stored the first user
  // message as "yazi golgesi gozukmuyor 0.15", and the model used the stray 0.15 as the CSS opacity it
  // then wrote. --max-cost landed without being added to VALUE_FLAGS, one commit after the same class of
  // bug was fixed for every other flag. This asserts the WHOLE table rather than the one flag, so the
  // next value flag cannot repeat it.
  for (const flag of VALUE_FLAGS) {
    const argv = ["bun", "main.ts", "run", "fix the thing", flag, "SENTINEL"];
    const words = runPromptWords(parseCli(argv), argv);
    expect(words.join(" ")).toBe("fix the thing");
    expect(words).not.toContain("SENTINEL");
  }
});
