import { test, expect } from "bun:test";
import { lineHash, fileTag, applyEdits, readAnchored, renderAnchored, readTool, editTool, bashTool, setEditLinter } from "../../src/coding/hashline.ts";
import type { PermissionDecision } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lineHash ignores whitespace", () => {
  expect(lineHash("return a + b")).toBe(lineHash("return  a+b"));
});

test("hashline edit applies with valid anchors, reverse order safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "one\ntwo\n");
  const r = applyEdits(p, [{ path: p, tag: "dead", anchorLine: 1, anchorHash: lineHash("one"), newLines: ["1"] }]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.failure.kind).toBe("tag-mismatch");
  rmSync(dir, { recursive: true, force: true });
});

test("hash mismatch returns nearest-match diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hl-"));
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
