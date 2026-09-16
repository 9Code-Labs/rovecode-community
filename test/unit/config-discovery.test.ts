/** Port #8 CRIT-1: cwd-UPWARD discovery — ancestor walk, nearest-wins
 *  shadowing, depth-major precedence, repo-root (.git) and stopAt bounds. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadProjectContext } from "../../src/core/config.ts";

/** Hermetic root: `.git` stops the walk at the tmp dir (see module doc). */
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-config-walk-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("upward discovery: a root AGENTS.md is visible from a nested subdir, with a ../-relative display path", () => {
  const root = tmpRoot();
  write(root, "AGENTS.md", "root agents");
  const sub = join(root, "a", "b");
  mkdirSync(sub, { recursive: true });

  const result = loadProjectContext(sub);

  expect(result.sources).toEqual([
    { path: "../../AGENTS.md", family: "agents", chars: "root agents".length, truncated: false },
  ]);
  expect(result.text).toBe("\n\n## From ../../AGENTS.md\nroot agents");
  expect(result.skippedFiles).toBe(0);

  cleanup(root);
});

test("nearest wins: when both levels define AGENTS.md, only the nearer one is harvested — the farther one is shadowed, not stubbed", () => {
  const root = tmpRoot();
  write(root, "AGENTS.md", "root version");
  write(root, "a/AGENTS.md", "sub version");

  const result = loadProjectContext(join(root, "a"));

  expect(result.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: "sub version".length, truncated: false },
  ]);
  expect(result.text).toBe("\n\n## From AGENTS.md\nsub version");
  expect(result.text).not.toContain("root version");

  cleanup(root);
});

test("precedence is depth-major: ALL of a nearer directory's files come before any farther directory's", () => {
  const root = tmpRoot();
  write(root, "AGENTS.md", "root agents");   // agents family outranks claude WITHIN a dir…
  write(root, "a/CLAUDE.md", "sub claude");  // …but the nearer dir wins across dirs

  const result = loadProjectContext(join(root, "a"));

  expect(result.sources.map((s) => s.path)).toEqual(["CLAUDE.md", "../AGENTS.md"]);
  expect(result.text).toBe("\n\n## From CLAUDE.md\nsub claude\n\n## From ../AGENTS.md\nroot agents");

  cleanup(root);
});

test("the walk stops INCLUSIVELY at the first .git directory — a repo never inherits context from outside itself", () => {
  const outer = tmpRoot();
  write(outer, "AGENTS.md", "outside the repo");
  write(outer, "repo/AGENTS.md", "inside the repo");
  mkdirSync(join(outer, "repo", ".git"));
  const sub = join(outer, "repo", "src");
  mkdirSync(sub);

  const result = loadProjectContext(sub);

  expect(result.sources).toEqual([
    { path: "../AGENTS.md", family: "agents", chars: "inside the repo".length, truncated: false },
  ]);
  expect(result.text).not.toContain("outside the repo");

  cleanup(outer);
});

test("a .git FILE (git worktree marker) also stops the walk", () => {
  const outer = tmpRoot();
  // FW2-Q: the outer file sits at a DIFFERENT relPath than any inner file —
  // an outer AGENTS.md would be shadowed by the inner one via nearest-wins
  // even with the boundary stop broken, so it cannot discriminate the stop.
  // CLAUDE.md exists ONLY outside: it shows up iff the walk crosses the
  // .git-FILE boundary (kills a dir-only hasGitMarker mutant).
  write(outer, "CLAUDE.md", "outside the worktree");
  write(outer, "wt/.git", "gitdir: /somewhere/else");
  write(outer, "wt/AGENTS.md", "inside the worktree");
  const sub = join(outer, "wt", "src");
  mkdirSync(sub);

  const result = loadProjectContext(sub);

  expect(result.sources.map((s) => s.path)).toEqual(["../AGENTS.md"]); // and nothing above the boundary
  expect(result.text).toContain("inside the worktree");
  expect(result.text).not.toContain("outside the worktree");

  cleanup(outer);
});

test("opts.stopAt bounds the walk (inclusive) below the repo root", () => {
  const root = tmpRoot();
  write(root, "AGENTS.md", "top level");
  const mid = join(root, "a");
  const sub = join(root, "a", "b");
  mkdirSync(sub, { recursive: true });

  // default: walks to the .git root and finds the file two levels up
  const full = loadProjectContext(sub);
  expect(full.sources.map((s) => s.path)).toEqual(["../../AGENTS.md"]);

  // stopAt mid: the walk is [sub, mid] — the top-level file is out of range
  const bounded = loadProjectContext(sub, { stopAt: mid });
  expect(bounded).toEqual({ text: "", sources: [], skippedFiles: 0 });

  cleanup(root);
});

test("a blank nearer file does not shadow a farther one (LOW-6 interplay)", () => {
  const root = tmpRoot();
  write(root, "AGENTS.md", "root wins");
  write(root, "a/AGENTS.md", "");

  const result = loadProjectContext(join(root, "a"));

  expect(result.sources).toEqual([
    { path: "../AGENTS.md", family: "agents", chars: "root wins".length, truncated: false },
  ]);

  cleanup(root);
});

test("byte-identical content across levels is included once — the nearer occurrence wins, the farther never reaches sources", () => {
  const root = tmpRoot();
  write(root, "CLAUDE.md", "same body");
  write(root, "a/AGENTS.md", "same body");

  const result = loadProjectContext(join(root, "a"));

  expect(result.sources).toEqual([
    { path: "AGENTS.md", family: "agents", chars: "same body".length, truncated: false },
  ]);
  expect(result.text).toBe("\n\n## From AGENTS.md\nsame body");

  cleanup(root);
});

test(".cursor/rules files from different levels coexist; same-named rule files shadow nearest-wins", () => {
  const root = tmpRoot();
  write(root, ".cursor/rules/shared.mdc", "root shared rule");
  write(root, ".cursor/rules/root-only.mdc", "root only rule");
  write(root, "a/.cursor/rules/shared.mdc", "sub shared rule");

  const result = loadProjectContext(join(root, "a"));

  expect(result.sources.map((s) => s.path)).toEqual([
    ".cursor/rules/shared.mdc",       // nearest wins for the shared name
    "../.cursor/rules/root-only.mdc", // unshadowed root rule still visible
  ]);
  expect(result.text).toContain("sub shared rule");
  expect(result.text).toContain("root only rule");
  expect(result.text).not.toContain("root shared rule");

  cleanup(root);
});
