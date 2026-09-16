/** Port #44 re-verify pass — sextant-diff-base.ts + the base selection in sextant-files.ts fileDiff /
 *  fileDiffAsync. reconstructBefore walks a hashline edit back from the post-edit file (single op,
 *  multi-line insert + deletion, EOF, first line), takes its candidates from HEAD or the file itself, lets
 *  the TAG reject a whitespace twin and returns null — never a guess — without a candidate, on a block
 *  that is not the op's newLines, on disagreeing tags or duplicate anchors. fileDiff prefers the captured
 *  base, then the rebuilt one, then HEAD (flagged), then "" inside a repo (flagged), else null; the sync and
 *  async forms agree case by case (fake runners, no spawn). */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEditsToContent, fileTag, lineHash } from "../../src/coding/hashline.ts";
import { toAsync, type GitRunner } from "../../src/sextant/git-status.ts";
import { editOpsOf, reconstructBefore, type HashlineOp } from "../../src/sextant/sextant-diff-base.ts";
import { fileDiff, fileDiffAsync } from "../../src/sextant/sextant-files.ts";

const op = (content: string, line: number, newLines: string[]): HashlineOp => ({ tag: fileTag(content), anchorLine: line, anchorHash: lineHash(content.split("\n")[line - 1]!), newLines });
function apply(content: string, ops: readonly HashlineOp[]): string {
  const r = applyEditsToContent(content, ops.map((o) => ({ ...o, path: "f" })), "f");
  if (!r.ok) throw new Error(`fixture edit rejected: ${JSON.stringify(r.failure)}`);
  return r.content;
}

test("reconstructBefore: one replaced line, a 3-line insert + a deletion in one call, an EOF edit and a first-line deletion all walk back to the exact original when HEAD holds the replaced lines — the TAG proves it", () => {
  const original = "keep-1\nold-line\nkeep-2\nkeep-3\nlast\n";
  const cases: HashlineOp[][] = [
    [op(original, 2, ["new-line"])],
    [op(original, 2, ["a", "b", "c"]), op(original, 4, [])],
    [op(original, 5, ["LAST"])],
    [op(original, 1, [])],
    [op(original, 1, ["x"]), op(original, 3, ["y", "z"]), op(original, 5, [])],
  ];
  for (const ops of cases) {
    const post = apply(original, ops);
    expect(post).not.toBe(original);
    expect(reconstructBefore(post, ops, original)).toBe(original);
    expect(reconstructBefore(post, [...ops].reverse(), original)).toBe(original); // op order does not matter
  }
});

test("candidates: an unchanged twin line in the file itself supplies the text when HEAD has none; a whitespace twin in HEAD (same hash, other text) is rejected by the TAG and the exact twin wins; null with no candidate, a block that is not the op's newLines, disagreeing tags, duplicate anchors or no ops", () => {
  const original = "a\nx = 1\nb\nx = 1\n";
  const ops = [op(original, 2, ["x = 2"])];
  const post = apply(original, ops);
  expect(reconstructBefore(post, ops, null)).toBe(original);                       // line 4 is the twin
  expect(reconstructBefore(post, ops, "a\n  x = 1\nb\n")).toBe(original);         // HEAD's indented twin fails the TAG, the disk twin passes
  expect(reconstructBefore("a\nx = 2\nb\n", ops, "a\n  x = 1\nb\n")).toBeNull();  // only the wrong-whitespace twin exists → TAG mismatch → null (mutation: skip the TAG check → a wrong base)
  const unique = "a\nunique\nb\n";
  const u = [op(unique, 2, ["gone"])];
  expect(reconstructBefore(apply(unique, u), u, null)).toBeNull();                 // no line anywhere hashes to the anchor
  expect(reconstructBefore(apply(unique, u), u, unique)).toBe(unique);             // …unless HEAD has it
  expect(reconstructBefore("a\nother\nb\n", u, unique)).toBeNull();                // the disk block is not the op's newLines
  expect(reconstructBefore(apply(unique, u), [{ ...u[0]!, tag: "ffff" }], unique)).toBeNull(); // the TAG never matches a rebuilt "ffff"
  const two = [op(original, 2, ["p"]), { ...op(original, 3, ["q"]), tag: "0000" }];
  expect(reconstructBefore(apply(original, [two[0]!]), two, original)).toBeNull(); // ops disagree on the TAG
  expect(reconstructBefore(post, [ops[0]!, { ...ops[0]!, newLines: ["z"] }], original)).toBeNull(); // two ops on one line
  expect(reconstructBefore(post, [], original)).toBeNull();
  expect(reconstructBefore(post, [{ ...ops[0]!, anchorLine: 99 }], original)).toBeNull(); // out of range
});

test("editOpsOf: the edit tool's args → ops verbatim; a missing edits array or any malformed op yields [] (never a partial list)", () => {
  const good = { path: "x", edits: [{ tag: "ab12", anchorLine: 3, anchorHash: "0k1", newLines: ["a", "b"] }, { tag: "ab12", anchorLine: 7, anchorHash: "zz9", newLines: [] }] };
  expect(editOpsOf(good)).toEqual(good.edits);
  expect(editOpsOf({ path: "x" })).toEqual([]);
  expect(editOpsOf(null)).toEqual([]);
  expect(editOpsOf("edits")).toEqual([]);
  expect(editOpsOf({ edits: [{ tag: "ab12", anchorLine: 1.5, anchorHash: "a", newLines: [] }] })).toEqual([]);
  expect(editOpsOf({ edits: [good.edits[0], { tag: "ab12", anchorLine: 2, anchorHash: "a", newLines: [1] }] })).toEqual([]);
  expect(editOpsOf({ edits: [{ tag: 1, anchorLine: 2, anchorHash: "a", newLines: [] }] })).toEqual([]);
});

// ---------- fileDiff / fileDiffAsync base selection ----------

const table = (rows: Record<string, string>): GitRunner => (args) => { const k = args.join(" "); return k in rows ? { status: 0, stdout: rows[k]! } : { status: 128, stdout: "" }; };
const changes = (d: { hunks: { rows: { op: string; text: string }[] }[] }): [string, string][] => d.hunks.flatMap((h) => h.rows).filter((r) => r.op !== " ").map((r) => [r.op, r.text]);

test("fileDiff: captured base beats HEAD (edit-only, unflagged); ops rebuild the same base; nothing captured → HEAD hunks flagged `head`; a repo file HEAD never saw → all adds flagged; outside git → null unless captured; a deleted file with a base → all deletes; the async form agrees on every case", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-fd-"));
  try {
    const before = "keep-1\nold-line\nkeep-2\nextra\n", head = "keep-1\nold-line\nkeep-2\n";
    writeFileSync(join(dir, "n.txt"), "keep-1\nnew-line\nkeep-2\nextra\n");
    const repo = table({ "show HEAD:./n.txt": head, "rev-parse --abbrev-ref HEAD": "main\n" });
    const ops = [op(before, 2, ["new-line"])];
    const cases: [string, string | null | undefined, GitRunner, HashlineOp[] | undefined][] = [
      ["n.txt", before, repo, undefined],           // captured
      ["n.txt", undefined, repo, ops],              // rebuilt
      ["n.txt", undefined, repo, []],               // HEAD
      ["n.txt", undefined, table({ "rev-parse --abbrev-ref HEAD": "main\n" }), []],  // untracked in a repo
      ["n.txt", undefined, () => null, []],         // no git, nothing captured
      ["n.txt", "keep-1\n", () => null, []],        // no git, captured
      ["gone.txt", "a\nb\n", repo, []],             // deleted file, captured base
      ["gone.txt", undefined, () => null, []],      // nothing on either side
    ];
    const results = cases.map(([rel, b, run, o]) => fileDiff(dir, rel, b, run, o));
    expect(results[0]).toMatchObject({ add: 1, del: 1 }); expect(results[0]!.base).toBeUndefined(); expect(changes(results[0]!)).toEqual([["-", "old-line"], ["+", "new-line"]]);
    expect(results[1]).toEqual(results[0]);                                       // (mutation: HEAD preferred → +2 −1 flagged)
    expect(results[2]).toMatchObject({ add: 2, del: 1, base: "head" });
    expect(changes(results[2]!)).toEqual([["-", "old-line"], ["+", "new-line"], ["+", "extra"]]);
    expect(results[3]).toMatchObject({ add: 4, del: 0, base: "head" });
    expect(results[4]).toBeNull();
    expect(results[5]).toMatchObject({ add: 3, del: 0 }); expect(results[5]!.base).toBeUndefined();
    expect(results[6]).toMatchObject({ add: 0, del: 2 });
    expect(results[7]).toBeNull();
    for (let i = 0; i < cases.length; i++) {
      const [rel, b, run, o] = cases[i]!;
      expect(await fileDiffAsync(dir, rel, b, toAsync(run), o)).toEqual(results[i]!);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
