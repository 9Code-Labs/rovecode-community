/** `--add-dir`, the flag half (ported from the Nimbus harness, #81): parseAddDirs (repeatable, `--add-dir=<dir>` form, resolved
 *  against the base = launch dir, exact duplicates collapse, a missing path / a file / a filesystem root / a missing value →
 *  the injected fail with the pinned message), `--add-dir` ∈ dispatch.ts VALUE_FLAGS, parseCli dispatching `run` with a
 *  pre-command --add-dir, runPromptWords dropping a post-command value (MUTATION: --add-dir missing from VALUE_FLAGS →
 *  `../lib` becomes the command / a prompt word — the --max-cost bug that shipped a flag value as a CSS opacity). */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { parseCli, VALUE_FLAGS } from "../../src/cli/dispatch.ts";
import { runPromptWords } from "../../src/cli/output.ts";
import { ADD_DIR_FLAG, parseAddDirs } from "../../src/cli/run-flags.ts";

const pending: string[] = [];
afterEach(() => { for (const d of pending.splice(0)) rmSync(d, { recursive: true, force: true }); });
const argv = (...a: string[]) => ["bun", "main.ts", ...a];
class Usage extends Error {}
const fail = (msg: string): never => { throw new Usage(msg); };

function fixture(): { base: string; lib: string; other: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "rovecode-p81-flags-"))); pending.push(base);
  const lib = join(base, "lib"), other = join(base, "other");
  mkdirSync(lib); mkdirSync(other); mkdirSync(join(lib, "sub"));
  writeFileSync(join(base, "file.txt"), "f\n");
  return { base, lib, other };
}

test("parseAddDirs: every occurrence, both forms, resolved against base, argv order kept, exact duplicates collapse; none → []", () => {
  const { base, lib, other } = fixture();
  expect(parseAddDirs(argv("run", "hi"), fail, base)).toEqual([]);
  expect(parseAddDirs(argv("run", "--add-dir", "lib", "hi"), fail, base)).toEqual([lib]);
  expect(parseAddDirs(argv("run", "--add-dir=lib", "hi"), fail, base)).toEqual([lib]);
  expect(parseAddDirs(argv("--add-dir", "lib", "run", "--add-dir", other, "hi", "--add-dir=./lib/sub"), fail, base)).toEqual([lib, other, join(lib, "sub")]);
  expect(parseAddDirs(argv("run", "--add-dir", "lib", "--add-dir", "./lib", "hi"), fail, base)).toEqual([lib]); // same resolved path twice → once
  expect(parseAddDirs(argv("--add-dir", lib), fail, base)).toEqual([lib]); // the TUI form (no command)
});

test("parseAddDirs: a missing path or a file → `--add-dir \"<v>\" is not a directory`; a filesystem root → the `would disable the workspace boundary — pass --yolo` line; a missing value → `--add-dir needs a value` (MUTATION: skip the root check → `C:\\` is accepted)", () => {
  const { base } = fixture();
  expect(() => parseAddDirs(argv("run", "--add-dir", "nope", "hi"), fail, base)).toThrow('--add-dir "nope" is not a directory');
  expect(() => parseAddDirs(argv("run", "--add-dir=file.txt", "hi"), fail, base)).toThrow('--add-dir "file.txt" is not a directory');
  const root = parse(base).root;
  expect(() => parseAddDirs(argv("run", "--add-dir", root, "hi"), fail, base)).toThrow(/would disable the workspace boundary — pass --yolo/);
  expect(() => parseAddDirs(argv("run", "hi", "--add-dir"), fail, base)).toThrow("--add-dir needs a value");
  expect(() => parseAddDirs(argv("run", "--add-dir", "--yolo", "hi"), fail, base)).toThrow("--add-dir needs a value"); // a flag-shaped value is no value
  expect(() => parseAddDirs(argv("run", "--add-dir=", "hi"), fail, base)).toThrow("--add-dir needs a directory");
});

test("--add-dir is a value flag everywhere: in dispatch.ts VALUE_FLAGS; `rovecode --add-dir ../lib run hi` dispatches run; `rovecode run hi --add-dir ../lib` sends `hi` (MUTATION: drop it from VALUE_FLAGS)", () => {
  expect(ADD_DIR_FLAG).toBe("--add-dir");
  expect(VALUE_FLAGS.has("--add-dir")).toBe(true);
  expect(parseCli(argv("--add-dir", "../lib", "run", "hi"))).toMatchObject({ cmd: "run", rest: ["hi"] });
  expect(parseCli(argv("--add-dir=../lib", "run", "hi"))).toMatchObject({ cmd: "run", rest: ["hi"] });
  expect(parseCli(argv("--add-dir", "../lib"))).toMatchObject({ cmd: "" }); // the TUI, never a one-shot named ../lib
  expect(parseCli(argv("--add-dir", "../lib", "--add-dir", "D:/x", "--plain"))).toMatchObject({ cmd: "", plain: true });
  const post = argv("run", "hi", "there", "--add-dir", "../lib", "--add-dir=../other");
  expect(runPromptWords(parseCli(post), post)).toEqual(["hi", "there"]);
  const pre = argv("--add-dir", "../lib", "run", "fix", "it");
  expect(runPromptWords(parseCli(pre), pre)).toEqual(["fix", "it"]);
  const bare = argv("--add-dir", "../lib", "fix", "the", "tests");
  expect(runPromptWords(parseCli(bare), bare)).toEqual(["fix", "the", "tests"]); // bare prompt: the value is not word 0
});
