import { test, expect } from "bun:test";
import { parseCli } from "../../src/cli/dispatch.ts";

const argv = (...args: string[]) => ["bun", "main.ts", ...args];

test("bare invocation → interactive default", () => {
  expect(parseCli(argv())).toEqual({ cmd: "", plain: false, yolo: false, rest: [] });
});

test("--plain stays a flag, never the command (regression: aion --plain ran a one-shot)", () => {
  const c = parseCli(argv("--plain"));
  expect(c.cmd).toBe("");
  expect(c.plain).toBe(true);
});

test("--yolo before or after the command", () => {
  expect(parseCli(argv("--yolo"))).toMatchObject({ cmd: "", yolo: true });
  expect(parseCli(argv("run", "--yolo", "fix it"))).toMatchObject({ cmd: "run", yolo: true, rest: ["fix it"] });
});

test("one-shot prompt: first non-flag becomes cmd, rest joins the prompt", () => {
  const c = parseCli(argv("fix", "the", "tests"));
  expect(c.cmd).toBe("fix");
  expect(c.rest).toEqual(["the", "tests"]);
});

test("trace takes its id from rest", () => {
  expect(parseCli(argv("trace", "abc-123")).rest).toEqual(["abc-123"]);
});

test("--help and -h route to the help command, not the TUI", () => {
  expect(parseCli(argv("--help")).cmd).toBe("help");
  expect(parseCli(argv("-h")).cmd).toBe("help");
});
