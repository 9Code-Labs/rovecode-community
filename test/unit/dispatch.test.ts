import { test, expect } from "bun:test";
import { parseCli, VALUE_FLAGS } from "../../src/cli/dispatch.ts";

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

// ---------- value flags before the command (LOW-3) ----------
// A value flag's VALUE must never be taken for the command: an unknown cmd falls
// through to the bare-prompt one-shot, which spends tokens on a real provider.

test("--out <path> before export: cmd is export, not the path (regression: `aion --out o.md export abc` ran a one-shot named o.md)", () => {
  expect(parseCli(argv("--out", "o.md", "export", "abc"))).toMatchObject({ cmd: "export", rest: ["abc"] });
});

test("--key <name> before auth: cmd is auth, not the key name", () => {
  expect(parseCli(argv("--key", "NAME", "auth", "set", "p"))).toMatchObject({ cmd: "auth", rest: ["set", "p"] });
});

test("--resume <id> alone → interactive default (main.ts opens the TUI on cmd \"\" and reads the id from argv itself)", () => {
  expect(parseCli(argv("--resume", "abc"))).toEqual({ cmd: "", plain: false, yolo: false, rest: [] });
  expect(parseCli(argv("--resume", "abc", "--plain"))).toMatchObject({ cmd: "", plain: true });
  // a flag-shaped "value" is not a value: the flag after it stays a flag, cmd stays ""
  expect(parseCli(argv("--resume", "--plain"))).toMatchObject({ cmd: "", plain: true });
});

test("boolean flags before the command are unchanged", () => {
  expect(parseCli(argv("--json", "export", "x"))).toMatchObject({ cmd: "export", rest: ["x"] });
  expect(parseCli(argv("--yolo", "run", "x"))).toMatchObject({ cmd: "run", yolo: true, rest: ["x"] });
});

test("a value flag AFTER the command leaves its value in rest (contract cmdAuth/export.ts rely on: they drop their own)", () => {
  expect(parseCli(argv("auth", "set", "p", "--key", "NAME"))).toMatchObject({ cmd: "auth", rest: ["set", "p", "NAME"] });
  expect(parseCli(argv("export", "abc", "--out", "o.md"))).toMatchObject({ cmd: "export", rest: ["abc", "o.md"] });
});

test("VALUE_FLAGS is the inventory of every value flag main.ts/export.ts hand-parse", () => {
  expect([...VALUE_FLAGS].sort()).toEqual(["--key", "--out", "--resume"]);
});
