import { test, expect } from "bun:test";
import {
  lineHash, fileTag, applyEdits, applyEditsToContent, readAnchored, renderAnchored, readTool, editTool, writeTool, bashTool, setEditLinter,
  describeEditFailure, MAX_EDIT_MESSAGE_CHARS,
} from "../../src/coding/hashline.ts";
import { configureExecutor, resetExecutor, type SpawnRunner } from "../../src/core/executor.ts";
import type { PermissionDecision } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lineHash ignores whitespace", () => {
  expect(lineHash("return a + b")).toBe(lineHash("return  a+b"));
});

test("hashline edit applies with valid anchors, reverse order safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "alpha\nbeta\ngamma\n");
  const f = readAnchored(p);
  const r = applyEdits(p, [
    { path: p, tag: f.tag, anchorLine: 1, anchorHash: f.lines[0]!.hash, newLines: ["ALPHA"] },
    { path: p, tag: f.tag, anchorLine: 3, anchorHash: f.lines[2]!.hash, newLines: ["GAMMA", "GAMMA2"] },
  ]);
  expect(r.ok).toBe(true);
  const out = readFileSync(p, "utf8");
  expect(out).toBe("ALPHA\nbeta\nGAMMA\nGAMMA2\n");
  rmSync(dir, { recursive: true, force: true });
});

test("stale tag rejected with diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "one\ntwo\n");
  const r = applyEdits(p, [{ path: p, tag: "dead", anchorLine: 1, anchorHash: lineHash("one"), newLines: ["1"] }]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.failure.kind).toBe("tag-mismatch");
  rmSync(dir, { recursive: true, force: true });
});

test("hash mismatch returns nearest-match diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "aaa\nbbb\nccc\n");
  const f = readAnchored(p);
  const r = applyEdits(p, [{ path: p, tag: f.tag, anchorLine: 2, anchorHash: lineHash("zzz"), newLines: ["x"] }]);
  expect(r.ok).toBe(false);
  if (!r.ok && r.failure.kind === "hash-mismatch") {
    expect(r.failure.line).toBe(2);
    expect(r.failure.nearest.length).toBeGreaterThan(0);
  } else throw new Error("expected hash-mismatch");
  rmSync(dir, { recursive: true, force: true });
});

test("fileTag changes on content change", () => {
  expect(fileTag("a")).not.toBe(fileTag("b"));
  expect(fileTag("same")).toBe(fileTag("same"));
});

test("renderAnchored includes path#tag header and hashed lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "r.txt");
  writeFileSync(p, "x\ny\n");
  const rendered = renderAnchored(readAnchored(p));
  expect(rendered.startsWith(p + "#")).toBe(true);
  expect(rendered).toContain("1#");
  expect(rendered).toContain("|x");
  rmSync(dir, { recursive: true, force: true });
});

// ---------- readTool windowing ----------

function makeCtx(dir: string): { sessionId: string; cwd: string; signal: AbortSignal; permissions: PermissionDecision } {
  return { sessionId: "s", cwd: dir, signal: new AbortController().signal, permissions: { effect: "allow" } };
}

test("readTool windows large files with bounds note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "big.txt");
  writeFileSync(p, Array.from({ length: 5000 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
  const ctx = makeCtx(dir);

  // default window: first 2000 lines only (trailing newline counts as one line)
  const def = await readTool.execute({ path: "big.txt" }, ctx);
  expect(def.ok).toBe(true);
  expect(def.output).toContain("showing lines 1-2000 of 5001");
  expect(def.output).toContain("2000#");
  expect(def.output).not.toContain("2001#");
  expect(def.output).not.toContain("line-3000");

  // explicit window keeps absolute numbering
  const win = await readTool.execute({ path: "big.txt", offset: 3000, limit: 10 }, ctx);
  expect(win.output).toContain("showing lines 3000-3009 of 5001");
  expect(win.output).toContain("3000#");
  expect(win.output).toContain("3009#");
  expect(win.output).not.toContain("3010#");

  // offset past EOF: empty slice, honest note
  const over = await readTool.execute({ path: "big.txt", offset: 9999 }, ctx);
  expect(over.ok).toBe(true);
  expect(over.output).toContain("past EOF");
  expect(over.output).toContain("of 5001");

  // small file: full content, exact bounds (trailing newline = one empty line)
  writeFileSync(p, "a\nb\n");
  const small = await readTool.execute({ path: "big.txt" }, ctx);
  expect(small.output).toContain("showing lines 1-3 of 3");
  expect(small.output).toContain("|a");
  expect(small.output).toContain("|b");

  expect((await readTool.execute({ path: "nope.txt" }, ctx)).ok).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- bashTool deny patterns ----------

test("bashTool refuses destructive commands, runs benign ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const ctx = makeCtx(dir);
  for (const cmd of ["rm -rf /", "rm -rf /*", "sudo rm -rf /etc", ':(){ :|:& };:', "mkfs.ext4 /dev/sda1", "shutdown now", "format c:", "del /f /q *", "echo hi > /dev/sda"]) {
    const r = await bashTool.execute({ command: cmd }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("blocklist");
  }
  const ok = await bashTool.execute({ command: "echo hello" }, ctx);
  expect(ok.ok).toBe(true);
  expect(ok.output).toContain("hello");
  // cwd locked to ctx.cwd: the command resolves files relative to it
  writeFileSync(join(dir, "marker.txt"), "from-cwd");
  const cat = await bashTool.execute({ command: "cat marker.txt" }, ctx);
  expect(cat.ok).toBe(true);
  expect(cat.output).toContain("from-cwd");
  rmSync(dir, { recursive: true, force: true });
});

// ---------- editTool lint-gate ----------

test("editTool lint-gate reverts edits that add new lint errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "aaa\nbbb\n");
  const f = readAnchored(p);
  let calls = 0;
  // fake linter: flags any content containing "TODO"
  setEditLinter((content) => {
    calls++;
    return content.includes("TODO") ? ["1:1 forbidden token TODO"] : [];
  });
  try {
    const bad = await editTool.execute({ path: p, edits: [{ tag: f.tag, anchorLine: 2, anchorHash: f.lines[1]!.hash, newLines: ["TODO bad"] }] }, makeCtx(dir));
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("reverted");
    expect(bad.output).toContain("forbidden token TODO");
    expect(calls).toBe(2); // once on before-content, once after
    expect(readFileSync(p, "utf8")).toBe("aaa\nbbb\n"); // reverted to original

    // clean edit passes and leaves new content
    const good = await editTool.execute({ path: p, edits: [{ tag: f.tag, anchorLine: 2, anchorHash: f.lines[1]!.hash, newLines: ["clean"] }] }, makeCtx(dir));
    expect(good.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("aaa\nclean\n");
    expect(calls).toBe(4);
  } finally {
    setEditLinter(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint-gate tolerates pre-existing errors, only NEW ones revert", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "aaa\nbbb\n");
  const f = readAnchored(p);
  // linter reports a pre-existing error for ANY content — edit that keeps it must pass
  setEditLinter(() => ["0:0 pre-existing"]);
  try {
    const r = await editTool.execute({ path: p, edits: [{ tag: f.tag, anchorLine: 1, anchorHash: f.lines[0]!.hash, newLines: ["AAA"] }] }, makeCtx(dir));
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("AAA\nbbb\n");
  } finally {
    setEditLinter(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- bashTool retry ----------

test("bashTool retries once on non-zero exit and reports final code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const ctx = makeCtx(dir);
  // counter file: first command fails, second (retry) succeeds
  const script = `if [ -f flag ]; then echo attempt-2; else touch flag; exit 3; fi`;
  const r = await bashTool.execute({ command: script }, ctx);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("attempt-2");
  expect(r.output).toContain("exit=0");
  // persistently failing command: retry happens, final code reported, ok:false
  const fail = await bashTool.execute({ command: `exit 7` }, ctx);
  expect(fail.ok).toBe(false);
  expect(fail.output).toContain("exit=7");
  rmSync(dir, { recursive: true, force: true });
});

// ---------- bashTool spawn failure through the executor seam (port #10 G8) ----------

test("bashTool surfaces a missing bash as structured exit=-1 spawn failed, not a throw (G8)", async () => {
  // Fake runner behind the seam: what bunRunner returns when the binary is
  // missing (Bun.spawn throws before exec → code -1, message in stderr).
  let spawns = 0;
  const runner: SpawnRunner = () => {
    spawns++;
    return Promise.resolve({ code: -1, stdout: "", stderr: "spawn failed: ENOENT bash" });
  };
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  try {
    await configureExecutor("direct", { runner });
    const out = await bashTool.execute({ command: "echo hi" }, makeCtx(dir));
    expect(out.ok).toBe(false);
    expect(out.output).toBe("exit=-1\n\nstderr:\nspawn failed: ENOENT bash");
    // Retry policy: bashTool retries ANY non-zero exit once, including -1. Kept
    // (not special-cased) because a spawn failure never creates a process, so
    // the doomed retry is ~free, and Windows spawn failures are not always
    // deterministic (antivirus/EBUSY holds on bash.exe) — one retry can
    // genuinely recover. Pinned so any future change is a conscious one:
    expect(spawns).toBe(2);
  } finally {
    resetExecutor(); // the seam is module-global — never leak the fake runner
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- port #28: actionable failure text (aider failed-block report semantics) ----------

const REMEDY = "Remedy: re-read the file with `read` to get fresh line hashes, then retry the edit.";

test("editTool hash mismatch: the message shows the anchor line's CURRENT text + hash vs the expected hash, lists the lines that carry the anchor (≤3), and ends with the read-then-retry remedy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "aaa\nbbb\nccc\nbbb\nbbb\nbbb\n");
  const f = readAnchored(p);
  try {
    // the anchor's hash lives elsewhere (lines 2, 4, 5, 6 read "bbb") — capped at three
    const moved = await editTool.execute({ path: p, edits: [{ tag: f.tag, anchorLine: 1, anchorHash: lineHash("bbb"), newLines: ["x"] }] }, makeCtx(dir));
    expect(moved.ok).toBe(false);
    expect(moved.output).toBe(`Edit rejected: anchor mismatch at ${p}:1 — line 1 now reads "aaa" (hash ${lineHash("aaa")}), your anchor expected hash ${lineHash("bbb")}. Lines whose hash matches your anchor: 2, 4, 5 — did you mean one of those? ${REMEDY}`);
    // no line carries the anchor: the file changed under the model
    const gone = await editTool.execute({ path: "f.txt", edits: [{ tag: f.tag, anchorLine: 2, anchorHash: "zzz", newLines: ["x"] }] }, makeCtx(dir));
    expect(gone.ok).toBe(false);
    expect(gone.output).toBe(`Edit rejected: anchor mismatch at ${p}:2 — line 2 now reads "bbb" (hash ${lineHash("bbb")}), your anchor expected hash zzz. No line in the file has that hash now — the content changed since your read. ${REMEDY}`);
    expect(gone.output.length).toBeLessThanOrEqual(MAX_EDIT_MESSAGE_CHARS);
    expect(readFileSync(p, "utf8")).toBe("aaa\nbbb\nccc\nbbb\nbbb\nbbb\n"); // nothing applied
    // the structured failure carries the same facts (port #24 preview consumer keeps `nearest`)
    const r = applyEditsToContent("aaa\nbbb\nccc\n", [{ path: p, tag: fileTag("aaa\nbbb\nccc\n"), anchorLine: 1, anchorHash: lineHash("ccc"), newLines: [] }], p);
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === "hash-mismatch") {
      expect(r.failure.text).toBe("aaa");
      expect(r.failure.matches).toEqual([3]);
      expect(r.failure.nearest).toBe("line 3 currently holds that hash: ccc");
    } else throw new Error("expected hash-mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editTool out-of-range / stale tag / missing file each state what the file is NOW and how to recover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "aaa\nbbb\nccc\nddd\n"); // 5 lines (the trailing newline is an empty 5th)
  const f = readAnchored(p);
  try {
    const range = await editTool.execute({ path: p, edits: [{ tag: f.tag, anchorLine: 9, anchorHash: "000", newLines: ["x"] }] }, makeCtx(dir));
    expect(range.output).toBe(`Edit rejected: line 9 is out of range — ${p} has 5 lines (valid anchors: 1-5). ${REMEDY}`);
    const stale = await editTool.execute({ path: p, edits: [{ tag: "dead", anchorLine: 1, anchorHash: f.lines[0]!.hash, newLines: ["x"] }] }, makeCtx(dir));
    expect(stale.output).toBe(`Edit rejected: stale read — ${p} changed since you read it (file TAG is now ${f.tag}, your edit carries dead). ${REMEDY}`);
    const missing = await editTool.execute({ path: "nope.txt", edits: [{ tag: "0000", anchorLine: 1, anchorHash: "000", newLines: ["x"] }] }, makeCtx(dir));
    expect(missing.ok).toBe(false);
    expect(missing.output).toBe(`Edit rejected: file not found: ${join(dir, "nope.txt")} — check the path (relative paths resolve against ${dir}) or create the file with \`write\`.`);
    expect(missing.output).not.toContain("out of range"); // the old "line 0 out of range (file has 0 lines)" is gone
    expect(readFileSync(p, "utf8")).toBe("aaa\nbbb\nccc\nddd\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeTool: a missing parent directory is a 'Write rejected' message naming the directory and the fix, never a raw ENOENT; an existing directory still writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  try {
    const target = join(dir, "missing", "deep");
    const out = await writeTool.execute({ path: "missing/deep/new.txt", content: "x" }, makeCtx(dir));
    expect(out.ok).toBe(false);
    expect(out.output).toBe(`Write rejected: directory ${target} does not exist — create it first (bash: mkdir -p ${JSON.stringify(target)}) or write into an existing directory.`);
    expect(out.output).not.toContain("ENOENT");
    const fine = await writeTool.execute({ path: "new.txt", content: "hello" }, makeCtx(dir));
    expect(fine.ok).toBe(true);
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("hello");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failure messages stay bounded (≤600): a very long path and line text clip the DETAIL, the remedy always survives; long lint lists are cut with a count", async () => {
  const long = describeEditFailure({ kind: "hash-mismatch", path: "/" + "p".repeat(700), line: 1, expected: "aaa", actual: "bbb", nearest: "", text: "t".repeat(80), matches: [] });
  expect(long.length).toBeLessThanOrEqual(MAX_EDIT_MESSAGE_CHARS);
  expect(long.startsWith("Edit rejected: anchor mismatch at /ppp")).toBe(true);
  expect(long.endsWith(`… ${REMEDY}`)).toBe(true);
  const short = describeEditFailure({ kind: "out-of-range", path: "/w/f.txt", line: 7, lineCount: 3 });
  expect(short).toBe(`Edit rejected: line 7 is out of range — /w/f.txt has 3 lines (valid anchors: 1-3). ${REMEDY}`);
  // lint gate: 20 new errors → the first 8 + "… and 12 more", then the retry line
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "aaa\nbbb\n");
  const f = readAnchored(p);
  setEditLinter((content) => content.includes("BAD") ? Array.from({ length: 20 }, (_, i) => `${i + 1}:1 lint-${i + 1}`) : []);
  try {
    const bad = await editTool.execute({ path: p, edits: [{ tag: f.tag, anchorLine: 2, anchorHash: f.lines[1]!.hash, newLines: ["BAD"] }] }, makeCtx(dir));
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("1:1 lint-1\n");
    expect(bad.output).toContain("8:1 lint-8\n… and 12 more\nFix these and retry the edit.");
    expect(bad.output).not.toContain("lint-9");
    expect(readFileSync(p, "utf8")).toBe("aaa\nbbb\n");
  } finally {
    setEditLinter(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
