import { test, expect } from "bun:test";
import { parseCli, VALUE_FLAGS } from "../../src/cli/dispatch.ts";

const argv = (...args: string[]) => ["bun", "main.ts", ...args];

test("bare invocation → interactive default", () => {
  expect(parseCli(argv())).toEqual({ cmd: "", plain: false, yolo: false, acceptEdits: false, classic: false, rest: [] });
});

// ---------- port #44: --classic / --pet <name> ----------

test("--classic is a boolean flag, never the command; absent → false (sextant is the default on a capable TTY)", () => {
  expect(parseCli(argv("--classic"))).toMatchObject({ cmd: "", classic: true });
  expect(parseCli(argv("--classic", "--yolo"))).toMatchObject({ cmd: "", classic: true, yolo: true });
  expect(parseCli(argv("run", "x", "--classic"))).toMatchObject({ cmd: "run", classic: true, rest: ["x"] });
  expect(parseCli(argv()).classic).toBe(false);
});

test("--pet <name> is a value flag: the name never becomes the command, is exposed as `pet`, and the key is absent when not given", () => {
  expect(parseCli(argv("--pet", "stormy"))).toEqual({ cmd: "", plain: false, yolo: false, acceptEdits: false, classic: false, pet: "stormy", rest: [] });
  expect(parseCli(argv("--pet", "stormy", "--resume", "abc"))).toMatchObject({ cmd: "", pet: "stormy" });
  expect(parseCli(argv("--pet", "--classic"))).toMatchObject({ cmd: "", classic: true }); // a flag-shaped "value" is not a value
  expect("pet" in parseCli(argv("--pet", "--classic"))).toBe(false);
  expect("pet" in parseCli(argv())).toBe(false);
  expect(parseCli(argv("--pet", "s", "trace", "abc"))).toMatchObject({ cmd: "trace", rest: ["abc"], pet: "s" }); // value skipped when locating cmd
});

test("--plain stays a flag, never the command (regression: rovecode --plain ran a one-shot)", () => {
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

test("--out <path> before export: cmd is export, not the path (regression: `rovecode --out o.md export abc` ran a one-shot named o.md)", () => {
  expect(parseCli(argv("--out", "o.md", "export", "abc"))).toMatchObject({ cmd: "export", rest: ["abc"] });
});

test("--key <name> before auth: cmd is auth, not the key name", () => {
  expect(parseCli(argv("--key", "NAME", "auth", "set", "p"))).toMatchObject({ cmd: "auth", rest: ["set", "p"] });
});

test("--resume <id> alone → interactive default (main.ts opens the TUI on cmd \"\" and reads the id from argv itself)", () => {
  expect(parseCli(argv("--resume", "abc"))).toEqual({ cmd: "", plain: false, yolo: false, acceptEdits: false, classic: false, rest: [] });
  expect(parseCli(argv("--resume", "abc", "--plain"))).toMatchObject({ cmd: "", plain: true });
  // a flag-shaped "value" is not a value: the flag after it stays a flag, cmd stays ""
  expect(parseCli(argv("--resume", "--plain"))).toMatchObject({ cmd: "", plain: true });
});

test("boolean flags before the command are unchanged", () => {
  expect(parseCli(argv("--json", "export", "x"))).toMatchObject({ cmd: "export", rest: ["x"] });
  expect(parseCli(argv("--yolo", "run", "x"))).toMatchObject({ cmd: "run", yolo: true, rest: ["x"] });
});

test("a value flag AFTER the command leaves its value in rest (contract cmdAuth/export.ts/output.ts rely on: they drop their own)", () => {
  expect(parseCli(argv("auth", "set", "p", "--key", "NAME"))).toMatchObject({ cmd: "auth", rest: ["set", "p", "NAME"] });
  expect(parseCli(argv("export", "abc", "--out", "o.md"))).toMatchObject({ cmd: "export", rest: ["abc", "o.md"] });
  expect(parseCli(argv("run", "hi", "--output", "json"))).toMatchObject({ cmd: "run", rest: ["hi", "json"] }); // output.ts runPromptWords drops "json"
});

// port #35: --output is a value flag — `rovecode --output json run hi` must dispatch run, not a
// one-shot prompt named "json" (which would spend tokens on a real provider)
test("--output <mode> before the command: cmd is the command, the mode is never the command", () => {
  expect(parseCli(argv("--output", "json", "run", "hi"))).toMatchObject({ cmd: "run", rest: ["hi"] });
  expect(parseCli(argv("--output", "ndjson", "hi", "there"))).toMatchObject({ cmd: "hi", rest: ["there"] });
  expect(parseCli(argv("--output=json", "run", "hi"))).toMatchObject({ cmd: "run", rest: ["hi"] }); // = form is a plain flag
});

test("VALUE_FLAGS is the inventory of every value flag main.ts/export.ts/output.ts/dispatch.ts/registry.ts hand-parse", () => {
  // --protocol --key-env --model --scope: `rovecode provider add` (providers/registry.ts parseAddArgs)
  // This list is the point of the test: --max-cost shipped in 60456d6 WITHOUT being added here, so
  // `run "…" --max-cost 0.15` sent the model the word "0.15" and it used the number as a CSS opacity.
  expect([...VALUE_FLAGS].sort()).toEqual(["--add-dir", "--effort", "--key", "--key-env", "--max-cost", "--max-seconds", "--max-turns", "--model", "--out", "--output", "--pet", "--protocol", "--resume", "--scope"]); // --max-*: cli/run-limits.ts
});

test("--accept-edits is a boolean flag, never the command", () => {
  expect(parseCli(argv("--accept-edits"))).toMatchObject({ cmd: "", acceptEdits: true, yolo: false });
  expect(parseCli(argv("run", "x", "--accept-edits"))).toMatchObject({ cmd: "run", acceptEdits: true, rest: ["x"] });
  expect(parseCli(argv()).acceptEdits).toBe(false);
});
