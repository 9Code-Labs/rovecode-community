/** No source file may carry a LITERAL control byte. A C0 or C1 byte other than tab and newline, written into a string
 *  or a regex as the byte itself rather than as an escape, is invisible in an editor and in review — and worse, a NUL
 *  anywhere in the first 8 000 bytes makes git call the whole file BINARY: `git diff` then prints "Binary files differ"
 *  and shows nothing at all. Six files in this tree carried one (a sentinel, two sanitiser classes, three test fixtures)
 *  and four of them had silently lost their diff; the sweep that found them started from a NUL that was about to be
 *  committed in a new file. Every one of them means the same thing written as `\u0000` / `\u001b`, which reviews.
 *
 *  This test is the guard, and it lives in the suite rather than in a script or a commit message because `bun test` is
 *  already what runs before anything lands (package.json `check` = model index --check && tsc --noEmit && bun test):
 *  no new step, no CI edit, nobody having to remember. Reading every tracked file costs well under a second.
 *
 *  THE HAND CHECK, for the person who arrives here in two years because this test just failed:
 *      git grep -nP "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\xc2[\x80-\x9f]" -- src test scripts plugins docs
 *  The `\xc2[\x80-\x9f]` half is the C1 range, which is two bytes in UTF-8. Do NOT add `-I`: that flag skips the files
 *  git has classified as binary, which is exactly the case you are hunting, and plain `git grep` prints "Binary file X
 *  matches" without the line — so pair it with this test (or a byte scan) when you want line numbers. `git ls-files
 *  --eol` is the weaker check: it reports a file git has ALREADY given up on (`-text`), not the file still treated as
 *  text while carrying a byte nobody can see.
 *
 *  THE FIX is always the same: write the escape. `"\u0000"`, `"\u001b"`, `/[\u0000-\u001f\u007f]/` — identical to the
 *  engine, visible to a human. src/sextant/market-source.ts:147 is the house example (an escaped control class with the
 *  eslint pragma above it; the rule flags the characters, not the spelling, so the pragma stays either way). */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const DIRS = ["src", "test", "scripts", "plugins", "docs"];

/** EMPTY, and worth keeping that way — "no literal control byte anywhere under those directories" is a shorter and
 *  stronger rule than a list of exceptions whose reasons rot, and a list with one entry invites a second. What WOULD
 *  justify an entry: a fixture whose whole point is a byte no escape can express, e.g. an intentionally malformed
 *  UTF-8 blob read from disk. A test that merely wants a control character in a string does not qualify — the escape
 *  is exactly that character (test/unit/sextant-market-docs.test.ts proves it: it asserts on hostile terminal input
 *  written entirely in escapes). Add the path WITH the reason on the same line; never widen this to a byte or a glob. */
const ALLOW: readonly string[] = [];

/** tab and newline are the two control characters source is made of; CR is deliberately included as an offender —
 *  this repository is LF (.gitattributes `* text=auto eol=lf`), so a lone CR in a tracked file is its own bug */
const offending = (text: string): { line: number; code: number }[] => {
  const hits: { line: number; code: number }[] = [];
  let line = 1;
  for (const ch of text) {
    if (ch === "\n") { line++; continue; }
    if (ch === "\t") continue;
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) hits.push({ line, code: c });
  }
  return hits;
};

const hex = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;

test("no tracked source file carries a literal C0/C1 byte (tab and newline excepted) — a raw byte is invisible in review and a NUL makes git call the file binary", () => {
  // --cached AND --others (minus what .gitignore covers): the byte that started this sweep was in a file that had never
  // been committed, so a guard over tracked files only would have missed the very case it exists for
  const ls = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...DIRS], { cwd: REPO, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  expect(ls.status).toBe(0); // no git, no verdict — say so rather than passing an unrun check
  const files = ls.stdout.toString("utf8").split("\0").filter((f) => f !== "");
  expect(files.length).toBeGreaterThan(100); // the sweep found 610; a handful would mean the listing, not the tree, changed

  const findings: string[] = [];
  for (const file of files) {
    if (ALLOW.includes(file)) continue;
    let text: string;
    try { text = readFileSync(join(REPO, file), "utf8"); } catch { continue } // a listed-but-absent file is another test's problem
    const hits = offending(text);
    if (hits.length === 0) continue;
    const shown = hits.slice(0, 4).map((h) => `line ${h.line} ${hex(h.code)}`).join(", ");
    findings.push(`${file}: ${hits.length} literal control byte${hits.length === 1 ? "" : "s"} (${shown}${hits.length > 4 ? ", …" : ""})`);
  }
  // the message IS the fix — this test fails on a machine whose owner has never heard of the sweep
  expect(findings.join("\n") + (findings.length > 0 ? "\n→ write it as an escape (\\u0000, \\u001b, /[\\u0000-\\u001f\\u007f]/): identical to the engine, visible in a diff. A raw NUL in the first 8 000 bytes makes git report \"Binary files differ\" and show no diff at all." : "")).toBe("");
});

test("the guard would catch the exact shape it was written for (a sentinel string and a regex class with raw bytes), and leaves tab, newline and ordinary text alone", () => {
  const raw = String.fromCharCode(0), esc = "\\u0000";
  expect(offending(`const KEEP = "${raw}keep-untrusted";`)).toEqual([{ line: 1, code: 0 }]);
  expect(offending(`const KEEP = "${esc}keep-untrusted";`)).toEqual([]);
  expect(offending(`v.replace(/[${raw}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]/g, " ")`).map((h) => h.code)).toEqual([0, 0x1f, 0x7f]);
  expect(offending("line one\n\tindented · … — ✓\nline three\n")).toEqual([]);
  expect(offending(`a${String.fromCharCode(0x9b)}b`)).toEqual([{ line: 1, code: 0x9b }]); // C1, two bytes in UTF-8
  expect(offending("trailing\r\n")).toEqual([{ line: 1, code: 0x0d }]); // this repo is LF: a CR is an offender too
});
