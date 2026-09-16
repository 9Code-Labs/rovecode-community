/** Port #24: previewDiff — in-memory edit/write preview rendered as a bounded unified diff.
 *  Pins: hunk shape + context, pure insert/delete, create (all-adds), unchanged, stale
 *  anchors → unavailable (never throws), CRLF fidelity, the exact line cap + marker, binary. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewDiff, DIFF_MAX_LINES, clipLines, moreMarker } from "../../src/coding/diff.ts";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rovecode-diff-"));
const numbered = (n: number, pre = "line") => Array.from({ length: n }, (_, i) => `${pre}-${i + 1}`).join("\n") + "\n";

/** edit-tool args for one anchored op, hashed off `content` the way a fresh read would */
function editArgs(path: string, content: string, anchorLine: number, newLines: string[], over: { tag?: string; anchorHash?: string } = {}) {
  const line = content.split("\n")[anchorLine - 1] ?? "";
  return { path, edits: [{ tag: over.tag ?? fileTag(content), anchorLine, anchorHash: over.anchorHash ?? lineHash(line), newLines }] };
}

/** hunk body lines only: strip the two file headers */
const body = (text: string) => text.split("\n").slice(2);

test("edit: a modify renders git-style headers + one hunk with 3 lines of context", () => {
  const dir = tmp(); const p = join(dir, "f.txt"); const content = numbered(10);
  writeFileSync(p, content);
  const r = previewDiff("edit", editArgs("f.txt", content, 5, ["LINE-5"]), dir);
  expect(r.kind).toBe("modify");
  expect(r.truncated).toBe(false);
  const lines = r.text.split("\n");
  expect(lines[0]).toBe("--- a/f.txt");
  expect(lines[1]).toBe("+++ b/f.txt");
  expect(lines[2]).toBe("@@ -2,7 +2,7 @@");
  expect(lines.slice(3)).toEqual([" line-2", " line-3", " line-4", "-line-5", "+LINE-5", " line-6", " line-7", " line-8"]);
  rmSync(dir, { recursive: true, force: true });
});

test("edit: pure insert shows only + lines; pure delete shows only - lines", () => {
  const dir = tmp(); const p = join(dir, "f.txt"); const content = numbered(6);
  writeFileSync(p, content);
  const ins = previewDiff("edit", editArgs("f.txt", content, 3, ["line-3", "inserted-a", "inserted-b"]), dir);
  expect(ins.kind).toBe("modify");
  expect(body(ins.text).filter((l) => l.startsWith("-"))).toEqual([]);
  expect(body(ins.text).filter((l) => l.startsWith("+"))).toEqual(["+inserted-a", "+inserted-b"]);
  expect(body(ins.text)[0]).toBe("@@ -1,6 +1,8 @@");

  const del = previewDiff("edit", editArgs("f.txt", content, 3, []), dir);
  expect(body(del.text).filter((l) => l.startsWith("+"))).toEqual([]);
  expect(body(del.text).filter((l) => l.startsWith("-"))).toEqual(["-line-3"]);
  rmSync(dir, { recursive: true, force: true });
});

test("write: a new file is kind create — /dev/null header and every body line an add", () => {
  const dir = tmp();
  const r = previewDiff("write", { path: "new.txt", content: "alpha\nbeta\ngamma\n" }, dir);
  expect(r.kind).toBe("create");
  expect(r.truncated).toBe(false);
  const lines = r.text.split("\n");
  expect(lines[0]).toBe("--- /dev/null");
  expect(lines[1]).toBe("+++ b/new.txt");
  expect(lines[2]).toBe("@@ -0,0 +1,3 @@");
  expect(lines.slice(3)).toEqual(["+alpha", "+beta", "+gamma"]);
  // no trailing newline → the unified-diff marker, not a phantom empty line
  const bare = previewDiff("write", { path: "bare.txt", content: "one\ntwo" }, dir);
  expect(body(bare.text)).toEqual(["@@ -0,0 +1,2 @@", "+one", "+two", "\\ No newline at end of file"]);
  rmSync(dir, { recursive: true, force: true });
});

test("write: identical content is kind unchanged with empty text", () => {
  const dir = tmp(); writeFileSync(join(dir, "same.txt"), "x\ny\n");
  const r = previewDiff("write", { path: join(dir, "same.txt"), content: "x\ny\n" }, dir);
  expect(r).toEqual({ text: "", truncated: false, kind: "unchanged" });
  rmSync(dir, { recursive: true, force: true });
});

test("edit: stale anchor/tag, missing file, malformed args → kind unavailable with a reason, never a throw", () => {
  const dir = tmp(); const p = join(dir, "f.txt"); const content = "aaa\nbbb\nccc\n";
  writeFileSync(p, content);
  const hash = previewDiff("edit", editArgs(p, content, 2, ["x"], { anchorHash: lineHash("zzz") }), dir);
  expect(hash.kind).toBe("unavailable");
  expect(hash.text).toStartWith("diff unavailable: stale anchor");
  expect(hash.text).toContain("line 2");
  const tag = previewDiff("edit", editArgs(p, content, 2, ["x"], { tag: "dead" }), dir);
  expect(tag.kind).toBe("unavailable");
  expect(tag.text).toContain("stale read");
  expect(previewDiff("edit", editArgs("nope.txt", content, 1, ["x"]), dir).kind).toBe("unavailable");
  expect(previewDiff("edit", editArgs(p, content, 9, ["x"], { anchorHash: "000" }), dir).text).toContain("out of range");
  for (const bad of [null, 42, {}, { path: "" }, { path: p }, { path: p, edits: "nope" }, { path: p, edits: [{ tag: 1 }] }, { path: p, edits: [null] }]) {
    let r: ReturnType<typeof previewDiff> | undefined;
    expect(() => { r = previewDiff("edit", bad, dir); }).not.toThrow();
    expect(r!.kind).toBe("unavailable");
  }
  expect(previewDiff("write", { path: p }, dir).kind).toBe("unavailable"); // no content
  // a directory where a file is expected: the read error becomes the reason, not an exception
  expect(previewDiff("write", { path: dir, content: "x" }, dir).kind).toBe("unavailable");
  rmSync(dir, { recursive: true, force: true });
});

test("CRLF file: only the edited line differs (no phantom whole-file change), output carries no CR", () => {
  const dir = tmp(); const p = join(dir, "crlf.txt"); const content = "a\r\nb\r\nc\r\n";
  writeFileSync(p, content);
  const r = previewDiff("edit", editArgs("crlf.txt", content, 2, ["B"]), dir);
  expect(r.kind).toBe("modify");
  expect(r.text).not.toContain("\r");
  expect(body(r.text)).toEqual(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]);
  // a write that only converts line endings is reported as such, not as a full rewrite
  const eol = previewDiff("write", { path: "crlf.txt", content: "a\nb\nc\n" }, dir);
  expect(eol.kind).toBe("unchanged");
  expect(eol.text).toContain("line endings");
  rmSync(dir, { recursive: true, force: true });
});

test("bound: a 200-line rewrite clips to exactly DIFF_MAX_LINES + one marker with the exact hidden count", () => {
  const dir = tmp(); const p = join(dir, "big.txt");
  writeFileSync(p, numbered(200));
  const args = { path: "big.txt", content: numbered(200, "LINE") };
  const full = previewDiff("write", args, dir, { maxLines: 100_000 });
  expect(full.truncated).toBe(false);
  const total = full.text.split("\n").length;
  expect(total).toBe(403); // 2 headers + 1 hunk header + 200 removed + 200 added

  const r = previewDiff("write", args, dir);
  expect(r.kind).toBe("modify");
  expect(r.truncated).toBe(true);
  const lines = r.text.split("\n");
  expect(lines.length).toBe(DIFF_MAX_LINES + 1);
  expect(lines.slice(0, DIFF_MAX_LINES)).toEqual(full.text.split("\n").slice(0, DIFF_MAX_LINES));
  expect(lines[DIFF_MAX_LINES]).toBe(`… +${total - DIFF_MAX_LINES} more lines`);

  const small = previewDiff("write", args, dir, { maxLines: 5 });
  expect(small.text.split("\n").length).toBe(6);
  expect(small.text.split("\n")[5]).toBe("… +398 more lines");
  // marker grammar: singular for exactly one hidden line
  expect(clipLines(["a", "b", "c"], 2)).toEqual(["a", "b", moreMarker(1)]);
  expect(moreMarker(1)).toBe("… +1 more line");
  expect(clipLines(["a", "b"], 2)).toEqual(["a", "b"]);
  rmSync(dir, { recursive: true, force: true });
});

test("binary: NUL bytes on disk or in the proposed content → unavailable, no diff attempted", () => {
  const dir = tmp(); const p = join(dir, "blob.bin");
  writeFileSync(p, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x41, 0x42]));
  const disk = previewDiff("write", { path: "blob.bin", content: "text\n" }, dir);
  expect(disk.kind).toBe("unavailable");
  expect(disk.text).toContain("binary");
  const proposed = previewDiff("write", { path: "fresh.txt", content: "a\0b" }, dir);
  expect(proposed.kind).toBe("unavailable");
  expect(proposed.text).toContain("binary");
  rmSync(dir, { recursive: true, force: true });
});

test("pathological rewrite past the Myers budget reports 'too large' instead of stalling", () => {
  const dir = tmp(); const p = join(dir, "huge.txt");
  writeFileSync(p, numbered(3000));
  const r = previewDiff("write", { path: "huge.txt", content: numbered(3000, "LINE") }, dir);
  expect(r.kind).toBe("unavailable");
  expect(r.text).toContain("too large");
  rmSync(dir, { recursive: true, force: true });
});
