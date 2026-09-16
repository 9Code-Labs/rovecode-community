/** Port #22 glob/grep/ls: output shapes (file:line, truncation markers pinned
 *  byte-exact), bounds (clampLimit contract, SCAN_CAP + its note through the
 *  fileTools seam), gitignore awareness, binary + 1MB skip, mid-scan abort,
 *  junction-cycle safety, the bounded ls stat sweep, read-class policy
 *  (deny-default auto-allow, resource = searched path — also when `path` is
 *  omitted or relative), registration in all three sites, Windows paths. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, unlinkSync, symlinkSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  globTool, grepTool, lsTool, listFiles, fileTools, clampLimit, scanCapLine,
  GLOB_LIMIT_DEFAULT, GREP_LIMIT_DEFAULT, LS_LIMIT_DEFAULT, LIMIT_CAP, SCAN_CAP, GREP_LINE_CAP, GREP_FILE_BYTES_CAP,
} from "../../src/coding/files.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ToolContext, ToolCallPart, PermissionRule } from "../../src/core/types.ts";

// ---------- fixtures ----------

const ctx = (cwd = process.cwd()): ToolContext => ({
  sessionId: "s-files", cwd, signal: new AbortController().signal,
  permissions: { effect: "allow" as const },
});

function tmpRoot(): string { return mkdtempSync(join(tmpdir(), "rovecode-files-")); }

/** git init + local identity; throws loudly when git is unavailable (the
 *  harness already depends on git for checkpoints/repomap). */
function gitInit(dir: string): void {
  const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (r.error || r.status !== 0) throw new Error("git unavailable — required by this suite (and by rovecode checkpoints)");
}

// ---------- glob: output shape + sort ----------

test("glob: returns absolute paths, recent-first then alphabetical; 'No files found' when nothing matches", async () => {
  const root = tmpRoot();
  const old1 = join(root, "aaa.txt");
  const old2 = join(root, "bbb.txt");
  const fresh = join(root, "zzz.txt");
  for (const p of [old1, old2, fresh]) writeFileSync(p, "x");
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(old1, threeDaysAgo, threeDaysAgo);
  utimesSync(old2, threeDaysAgo, threeDaysAgo);

  const out = await globTool.execute({ pattern: "*.txt", path: root }, ctx());
  expect(out.ok).toBe(true);
  // fresh (recent, mtime within 24h) first; stale ones alphabetical by absolute path
  expect(out.output.split("\n")).toEqual([fresh, old1, old2]);

  const none = await globTool.execute({ pattern: "*.nope", path: root }, ctx());
  expect(none.ok).toBe(true);
  expect(none.output).toBe("No files found");
  rmSync(root, { recursive: true, force: true });
});

test("glob: pathless patterns match names at any depth; path-anchored patterns match the relative path", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  writeFileSync(join(root, "sub", "deep", "note.md"), "x");
  writeFileSync(join(root, "top.md"), "x");
  writeFileSync(join(root, "top.ts"), "x");

  const any = await globTool.execute({ pattern: "*.md", path: root }, ctx());
  expect(any.output.split("\n").sort()).toEqual([join(root, "sub", "deep", "note.md"), join(root, "top.md")].sort());

  const anchored = await globTool.execute({ pattern: "sub/**/*.md", path: root }, ctx());
  expect(anchored.output).toBe(join(root, "sub", "deep", "note.md"));
  rmSync(root, { recursive: true, force: true });
});

test("glob: maxFiles bound with the exact opencode truncation marker; arg clamped to the advertised cap", async () => {
  const root = tmpRoot();
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), "x");
  const out = await globTool.execute({ pattern: "*.txt", path: root, maxFiles: 2 }, ctx());
  const lines = out.output.split("\n");
  expect(lines).toHaveLength(4); // 2 paths + blank + marker
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe("(Results are truncated: showing first 2 results. Consider using a more specific path or pattern.)");
  expect((out.data as { truncated: boolean }).truncated).toBe(true);

  // an absurd maxFiles is clamped to LIMIT_CAP, never trusted
  const clamped = await globTool.execute({ pattern: "*.txt", path: root, maxFiles: 10_000_000 }, ctx());
  expect(clamped.ok).toBe(true);
  expect(clamped.output.split("\n")).toHaveLength(5); // all 5, no marker
  rmSync(root, { recursive: true, force: true });
});

test("glob: non-directory targets are rejected", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "f.txt"), "x");
  const miss = await globTool.execute({ pattern: "*", path: join(root, "gone") }, ctx());
  expect(miss.ok).toBe(false);
  const file = await globTool.execute({ pattern: "*", path: join(root, "f.txt") }, ctx());
  expect(file.ok).toBe(false);
  expect(file.output).toContain("glob path must be a directory");
  rmSync(root, { recursive: true, force: true });
});

// ---------- bounds: the clamp contract (literal cap, ceiling, floor) ----------

test("clampLimit: LIMIT_CAP is the literal 1000 and the ceiling; absent/NaN/non-positive fall back to the default; fractions floor", () => {
  expect(LIMIT_CAP).toBe(1000); // the literal — a self-referential `cap ${LIMIT_CAP}` pin survives a raise
  expect(clampLimit(1e7, 100)).toBe(LIMIT_CAP);
  expect(clampLimit(LIMIT_CAP + 1, 100)).toBe(LIMIT_CAP);
  expect(clampLimit(LIMIT_CAP, 100)).toBe(LIMIT_CAP);
  expect(clampLimit(-1, 100)).toBe(100);
  expect(clampLimit(0, 100)).toBe(100);
  expect(clampLimit(undefined, 100)).toBe(100);
  expect(clampLimit(Number.NaN, 100)).toBe(100);
  expect(clampLimit(2.9, 100)).toBe(2);
});

// ---------- grep: output shape + bounds ----------

test("grep: file:line output shape with 'Found N matches' header", async () => {
  const root = tmpRoot();
  const abs = join(root, "a.txt");
  writeFileSync(abs, "hello\nneedle here\nbye\nneedle again\n");
  const out = await grepTool.execute({ pattern: "needle", path: root }, ctx());
  expect(out.ok).toBe(true);
  const lines = out.output.split("\n");
  expect(lines[0]).toBe("Found 2 matches");
  expect(lines[1]).toBe(`${abs}:2: needle here`);
  expect(lines[2]).toBe(`${abs}:4: needle again`);

  const none = await grepTool.execute({ pattern: "zebra", path: root }, ctx());
  expect(none.ok).toBe(true);
  expect(none.output).toBe("No matches found");
  rmSync(root, { recursive: true, force: true });
});

test("grep: maxMatches cap with exact truncation marker and 'more matches available' header", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "many.txt"), Array.from({ length: 10 }, (_, i) => `needle ${i}`).join("\n"));
  const out = await grepTool.execute({ pattern: "needle", path: root, maxMatches: 3 }, ctx());
  const lines = out.output.split("\n");
  expect(lines[0]).toBe("Found 3 matches (more matches available)");
  expect(lines.filter((l) => l.includes("many.txt:"))).toHaveLength(3);
  expect(lines[lines.length - 2]).toBe("");
  expect(lines[lines.length - 1]).toBe("(Results truncated. Consider using a more specific path or pattern.)");
  rmSync(root, { recursive: true, force: true });
});

test("grep: per-line char cap at GREP_LINE_CAP with '...' marker (huge lines stay bounded)", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "huge.txt"), "needle" + "a".repeat(5000) + "\nshort needle\n");
  const out = await grepTool.execute({ pattern: "needle", path: root }, ctx());
  const capped = out.output.split("\n").find((l) => l.includes("huge.txt:1:"))!;
  const text = capped.slice(capped.indexOf(":1: ") + 4);
  expect(text.length).toBe(GREP_LINE_CAP + 3);
  expect(text.endsWith("...")).toBe(true);
  // the short line rides along un-capped
  expect(out.output).toContain(":2: short needle");
  rmSync(root, { recursive: true, force: true });
});

test("grep: binary files are skipped; glob filter narrows candidates; invalid regex is a clean failure", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "bin.dat"), Buffer.from("needle\0\0\0binary"));
  writeFileSync(join(root, "plain.txt"), "needle in text\n");
  writeFileSync(join(root, "other.md"), "needle in md\n");

  const out = await grepTool.execute({ pattern: "needle", path: root }, ctx());
  expect(out.output).toContain("plain.txt:1:");
  expect(out.output).toContain("other.md:1:");
  expect(out.output).not.toContain("bin.dat");

  const filtered = await grepTool.execute({ pattern: "needle", path: root, glob: "*.txt" }, ctx());
  expect(filtered.output).toContain("plain.txt:1:");
  expect(filtered.output).not.toContain("other.md");

  const bad = await grepTool.execute({ pattern: "([", path: root }, ctx());
  expect(bad.ok).toBe(false);
  expect(bad.output).toContain("invalid regex");
  rmSync(root, { recursive: true, force: true });
});

test("grep: a single-file path searches just that file", async () => {
  const root = tmpRoot();
  const abs = join(root, "solo.txt");
  writeFileSync(abs, "one\nneedle\n");
  writeFileSync(join(root, "other.txt"), "needle too\n");
  const out = await grepTool.execute({ pattern: "needle", path: abs }, ctx());
  expect(out.output.split("\n")).toEqual(["Found 1 matches", `${abs}:2: needle`]);
  rmSync(root, { recursive: true, force: true });
});

test("grep: an abort issued while the scan is in flight ends it with 'grep aborted' (the loop yields per file); a pre-aborted signal short-circuits", async () => {
  const root = tmpRoot();
  for (let i = 0; i < 8; i++) writeFileSync(join(root, `f${i}.txt`), "needle\n");
  // execute() runs synchronously up to its first awaited read, then hands back
  // the pending promise; abort() lands before that read settles, so the check at
  // the top of the NEXT iteration must see it. The old synchronous scan had
  // already produced all 8 matches by the time abort() ran.
  const ac = new AbortController();
  const pending = grepTool.execute({ pattern: "needle", path: root }, { ...ctx(), signal: ac.signal });
  ac.abort();
  expect(await pending).toEqual({ ok: false, output: "grep aborted" });

  const pre = new AbortController();
  pre.abort();
  expect(await grepTool.execute({ pattern: "needle", path: root }, { ...ctx(), signal: pre.signal })).toEqual({ ok: false, output: "grep aborted" });

  // unaborted control over the same fixture
  const full = await grepTool.execute({ pattern: "needle", path: root }, ctx());
  expect(full.output.split("\n")[0]).toBe("Found 8 matches");
  rmSync(root, { recursive: true, force: true });
});

test("grep: files over GREP_FILE_BYTES_CAP (1MB) are skipped — as directory candidates and as a single-file target", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "big.txt"), "needle\n" + "x".repeat(GREP_FILE_BYTES_CAP)); // cap + 7 bytes
  writeFileSync(join(root, "small.txt"), "needle\n");
  const out = await grepTool.execute({ pattern: "needle", path: root }, ctx());
  expect(out.output.split("\n")).toEqual(["Found 1 matches", `${join(root, "small.txt")}:1: needle`]);
  const single = await grepTool.execute({ pattern: "needle", path: join(root, "big.txt") }, ctx());
  expect(single.output).toBe("No matches found");
  rmSync(root, { recursive: true, force: true });
});

// ---------- gitignore + default excludes ----------

test("gitignore honored in a git repo: glob and grep drop ignored files; ls hides + counts them", async () => {
  const root = tmpRoot();
  gitInit(root);
  writeFileSync(join(root, ".gitignore"), "secret.txt\n");
  writeFileSync(join(root, "secret.txt"), "zebra classified\n");
  writeFileSync(join(root, "kept.txt"), "zebra public\n");

  const g = await globTool.execute({ pattern: "*.txt", path: root }, ctx());
  expect(g.output).toBe(join(root, "kept.txt"));

  const s = await grepTool.execute({ pattern: "zebra", path: root }, ctx());
  expect(s.output).toContain("kept.txt:1:");
  expect(s.output).not.toContain("secret.txt");

  const l = await lsTool.execute({ path: root }, ctx());
  expect(l.output).toContain("kept.txt (");
  expect(l.output).not.toContain("secret.txt");
  expect(l.output).toContain("(1 ignored)");
  rmSync(root, { recursive: true, force: true });
});

test("outside git: node_modules and dotfiles are excluded by default (glob/grep walk, ls note)", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "dep.js"), "needle dep\n");
  writeFileSync(join(root, ".hidden.js"), "needle hidden\n");
  writeFileSync(join(root, "app.js"), "needle app\n");

  const listing = listFiles(root);
  expect(listing.viaGit).toBe(false);
  expect(listing.rel).toEqual(["app.js"]);

  const g = await globTool.execute({ pattern: "**/*.js", path: root }, ctx());
  expect(g.output).toBe(join(root, "app.js"));

  const s = await grepTool.execute({ pattern: "needle", path: root }, ctx());
  expect(s.output.split("\n")).toEqual(["Found 1 matches", `${join(root, "app.js")}:1: needle app`]);

  const l = await lsTool.execute({ path: root }, ctx());
  expect(l.output).toContain("app.js (");
  expect(l.output).not.toContain("node_modules");
  expect(l.output).not.toContain(".hidden.js");
  expect(l.output).toContain("(2 ignored)");
  rmSync(root, { recursive: true, force: true });
});

// ---------- SCAN_CAP: injectable cap on both enumeration paths + the exact note through every tool ----------

test("SCAN_CAP: listFiles caps the walk AND the git ls-files path (reported via .capped); SCAN_CAP and the note string are pinned", () => {
  expect(SCAN_CAP).toBe(10_000);
  expect(scanCapLine(SCAN_CAP)).toBe("(File enumeration capped at 10000 files; results may be incomplete.)");

  const walk = tmpRoot();
  for (const n of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(walk, n), "x");
  expect(listFiles(walk)).toEqual({ rel: ["a.txt", "b.txt", "c.txt"], viaGit: false, capped: false });
  expect(listFiles(walk, 2)).toEqual({ rel: ["a.txt", "b.txt"], viaGit: false, capped: true });

  const repo = tmpRoot();
  gitInit(repo);
  for (const n of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, n), "x");
  const viaGit = listFiles(repo, 2);
  expect(viaGit.viaGit).toBe(true);
  expect(viaGit.capped).toBe(true);
  expect(viaGit.rel).toHaveLength(2);
  expect(listFiles(repo).capped).toBe(false);
  rmSync(walk, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("SCAN_CAP note: glob/grep/ls built over a 2-file cap append the exact marker (hits and no-hits); the SCAN_CAP tools stay silent below the cap", async () => {
  const root = tmpRoot();
  for (const n of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(root, n), "needle\n");
  const NOTE = "(File enumeration capped at 2 files; results may be incomplete.)";
  const small = fileTools(2);

  const g = await small.globTool.execute({ pattern: "*.txt", path: root }, ctx());
  const gl = g.output.split("\n");
  expect(gl.slice(0, 2).sort()).toEqual([join(root, "a.txt"), join(root, "b.txt")]); // recency order among same-ms files is not pinned
  expect(gl.slice(2)).toEqual(["", NOTE]);
  const gNone = await small.globTool.execute({ pattern: "*.nope", path: root }, ctx());
  expect(gNone.output).toBe(`No files found\n\n${NOTE}`);

  const s = await small.grepTool.execute({ pattern: "needle", path: root }, ctx());
  const sl = s.output.split("\n");
  expect(sl[0]).toBe("Found 2 matches");
  expect(sl.slice(-2)).toEqual(["", NOTE]);
  const sNone = await small.grepTool.execute({ pattern: "zebra", path: root }, ctx());
  expect(sNone.output).toBe(`No matches found\n\n${NOTE}`);

  const l = await small.lsTool.execute({ path: root }, ctx());
  expect(l.output).toBe(`Directory listing for ${root}:\na.txt (7 bytes)\nb.txt (7 bytes)\n\n${NOTE}`);

  for (const out of [
    await globTool.execute({ pattern: "*.txt", path: root }, ctx()),
    await grepTool.execute({ pattern: "needle", path: root }, ctx()),
    await lsTool.execute({ path: root }, ctx()),
  ]) expect(out.output).not.toContain("File enumeration capped");
  rmSync(root, { recursive: true, force: true });
});

test("listFiles (non-git walk): a directory junction/symlink back into an ancestor is skipped, not descended — no duplicates, terminates", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "file.txt"), "x");
  writeFileSync(join(root, "top.txt"), "x");
  // "junction" needs no privilege on Windows; POSIX ignores the type hint and makes a plain symlink
  const loop = join(root, "sub", "loop");
  symlinkSync(root, loop, "junction");
  expect(listFiles(root)).toEqual({ rel: ["sub/file.txt", "top.txt"], viaGit: false, capped: false });
  // drop the link itself before the recursive rm so nothing walks through it
  try { rmdirSync(loop); } catch { unlinkSync(loop); }
  rmSync(root, { recursive: true, force: true });
});

// ---------- ls: output shape + bounds ----------

test("ls: dirs first as [DIR], files with sizes, alphabetical; exact shape pinned", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "zzz-dir"));
  writeFileSync(join(root, "alpha.txt"), "1234567");
  const out = await lsTool.execute({ path: root }, ctx());
  expect(out.ok).toBe(true);
  expect(out.output).toBe(`Directory listing for ${root}:\n[DIR] zzz-dir\nalpha.txt (7 bytes)`);
  rmSync(root, { recursive: true, force: true });
});

test("ls: maxEntries bound with truncation marker; empty dir and non-dir errors", async () => {
  const root = tmpRoot();
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), "x");
  const out = await lsTool.execute({ path: root, maxEntries: 2 }, ctx());
  expect(out.output).toContain("f0.txt (1 bytes)");
  expect(out.output).toContain("(Results truncated: showing first 2 of 5 entries.)");
  expect(out.output).not.toContain("f2.txt");

  const emptyRoot = tmpRoot();
  const empty = await lsTool.execute({ path: emptyRoot }, ctx());
  expect(empty.output).toBe(`Directory ${emptyRoot} is empty.`);

  const notDir = await lsTool.execute({ path: join(root, "f0.txt") }, ctx());
  expect(notDir.ok).toBe(false);
  expect(notDir.output).toContain("Path is not a directory");
  const missing = await lsTool.execute({ path: join(root, "nope") }, ctx());
  expect(missing.ok).toBe(false);
  rmSync(root, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

test("ls: the stat sweep is bounded by the scan cap — alphabetical slice BEFORE statting (dirs-first applies within the slice); both notes compose", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.txt"), "x");
  writeFileSync(join(root, "b.txt"), "x");
  mkdirSync(join(root, "zdir")); // would lead the listing if everything were statted first
  const NOTE = "(File enumeration capped at 2 files; results may be incomplete.)";
  const { lsTool: capped } = fileTools(2);
  const out = await capped.execute({ path: root }, ctx());
  expect(out.output).toBe(`Directory listing for ${root}:\na.txt (1 bytes)\nb.txt (1 bytes)\n\n${NOTE}`);
  expect(out.data).toEqual({ entries: 2, truncated: false });
  const both = await capped.execute({ path: root, maxEntries: 1 }, ctx());
  expect(both.output).toBe(`Directory listing for ${root}:\na.txt (1 bytes)\n\n(Results truncated: showing first 1 of 2 entries.)\n\n${NOTE}`);
  expect(both.data).toEqual({ entries: 1, truncated: true });
  rmSync(root, { recursive: true, force: true });
});

// ---------- Windows path handling ----------

test("platform-native separators (backslashes on Windows) work for path args, relative and absolute", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "sub", "dir"), { recursive: true });
  writeFileSync(join(root, "sub", "dir", "w.txt"), "needle win\n");
  // join() produces backslash-separated paths on Windows — pass them verbatim
  const absSub = join(root, "sub", "dir");
  const g = await globTool.execute({ pattern: "*.txt", path: absSub }, ctx());
  expect(g.output).toBe(join(absSub, "w.txt"));
  const s = await grepTool.execute({ pattern: "needle", path: absSub }, ctx());
  expect(s.output).toContain(`${join(absSub, "w.txt")}:1: needle win`);
  // relative path resolved against ctx.cwd
  const rel = await lsTool.execute({ path: join("sub", "dir") }, ctx(root));
  expect(rel.output).toContain("w.txt (");
  rmSync(root, { recursive: true, force: true });
});

// ---------- policy: kind read → file.read auto-allow under deny-default ----------

test("policy: dispatch auto-allows glob/grep/ls under the read-class rule with NO approver; deny-default without it", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "p.txt"), "needle policy\n");
  const registry = new ToolRegistry();
  registry.register(globTool, grepTool, lsTool);
  const calls: ToolCallPart[] = [
    { kind: "tool_call", id: "c1", tool: "glob", args: { pattern: "*.txt", path: root } },
    { kind: "tool_call", id: "c2", tool: "grep", args: { pattern: "needle", path: root } },
    { kind: "tool_call", id: "c3", tool: "ls", args: { path: root } },
  ];
  for (const call of calls) {
    const denied = await registry.dispatch(call, ctx(), undefined, [], undefined, () => {});
    expect(denied.ok).toBe(false);
    expect(denied.output).toContain("Permission denied");
  }
  const allow: PermissionRule[] = [{ action: "file.read", resource: "*", effect: "allow" }];
  for (const call of calls) {
    const ok = await registry.dispatch(call, ctx(), undefined, allow, undefined, () => {});
    expect(ok.ok).toBe(true);
  }
  rmSync(root, { recursive: true, force: true });
});

test("policy: resource is the searched/listed path — a path-targeted deny rule blocks all three", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "p.txt"), "x");
  const registry = new ToolRegistry();
  registry.register(globTool, grepTool, lsTool);
  const rules: PermissionRule[] = [
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.read", resource: root, effect: "deny" }, // resource = args.path (declared in every schema)
  ];
  for (const [tool, args] of [
    ["glob", { pattern: "*", path: root }],
    ["grep", { pattern: "x", path: root }],
    ["ls", { path: root }],
  ] as const) {
    const out = await registry.dispatch({ kind: "tool_call", id: "d-" + tool, tool, args }, ctx(), undefined, rules, undefined, () => {});
    expect(out.ok).toBe(false);
    expect(out.output).toContain("Permission denied");
  }
  rmSync(root, { recursive: true, force: true });
});

test("policy: omitting `path` (tools default to ctx.cwd), '' or '.' cannot dodge a path-targeted deny — the resource falls back to ctx.cwd", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "p.txt"), "x");
  const other = tmpRoot();
  writeFileSync(join(other, "q.txt"), "x");
  const registry = new ToolRegistry();
  registry.register(globTool, grepTool, lsTool);
  const rules: PermissionRule[] = [
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.read", resource: root, effect: "deny" },
  ];
  const calls = [
    ["glob", { pattern: "*" }], ["grep", { pattern: "x" }], ["ls", {}],
    ["glob", { pattern: "*", path: "." }], ["grep", { pattern: "x", path: "" }], ["ls", { path: "." }],
  ] as const;
  for (const [tool, args] of calls) {
    const denied = await registry.dispatch({ kind: "tool_call", id: "cwd-" + tool, tool, args }, ctx(root), undefined, rules, undefined, () => {});
    expect(denied.ok).toBe(false);
    expect(denied.output).toContain("Permission denied");
    // the same call from an un-denied cwd runs — the deny is on the path, not the tool
    const allowed = await registry.dispatch({ kind: "tool_call", id: "other-" + tool, tool, args }, ctx(other), undefined, rules, undefined, () => {});
    expect(allowed.ok).toBe(true);
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("tool contracts: kind read, parallel-safe, schemas advertise defaults and caps", () => {
  for (const t of [globTool, grepTool, lsTool]) {
    expect(t.kind).toBe("read");
    expect(t.sequential).toBe(false);
    expect((t.schema.args as { properties: Record<string, unknown> }).properties["path"]).toBeDefined();
  }
  const prop = (t: { schema: { args: Record<string, unknown> } }, k: string): string =>
    ((t.schema.args["properties"] as Record<string, { description?: string }>)[k]?.description) ?? "";
  expect(prop(globTool, "maxFiles")).toContain(`default ${GLOB_LIMIT_DEFAULT}`);
  expect(prop(globTool, "maxFiles")).toContain(`cap ${LIMIT_CAP}`);
  expect(prop(grepTool, "maxMatches")).toContain(`default ${GREP_LIMIT_DEFAULT}`);
  expect(prop(grepTool, "maxMatches")).toContain(`cap ${LIMIT_CAP}`);
  expect(prop(lsTool, "maxEntries")).toContain(`default ${LS_LIMIT_DEFAULT}`);
  expect(prop(lsTool, "maxEntries")).toContain(`cap ${LIMIT_CAP}`);
});

// ---------- registration: runtime (dispatch-level) + cmdTools + gauntlet (grep-level) ----------

test("registration: createRuntime registers glob/grep/ls", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-files-rt-"));
  const rt = createRuntime({ cwd, stream: null });
  const names = rt.registry.list().map((t) => t.schema.name);
  for (const n of ["glob", "grep", "ls"]) expect(names).toContain(n);
  rmSync(cwd, { recursive: true, force: true });
});

test("registration: main.ts cmdTools and gauntlet-runner.ts register glob/grep/ls (source pin)", () => {
  const mainSrc = readFileSync(join(import.meta.dir, "../../src/cli/main.ts"), "utf8");
  const gauntletSrc = readFileSync(join(import.meta.dir, "../../src/eval/gauntlet-runner.ts"), "utf8");
  for (const src of [mainSrc, gauntletSrc]) {
    expect(src).toContain("registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool)");
  }
});
