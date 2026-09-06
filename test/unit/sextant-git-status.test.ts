/** Port #41 git status: porcelain v1 parsing from fixtures (-z form incl. `R new\0old`, `??`, `D`,
 *  `AM`, `!!`; newline form incl. `R old -> new` and C-quoted paths with UTF-8 octal escapes),
 *  null-never-throw behavior through an injected runner (no git / not a repo / runner throws), and a
 *  real `git init` temp repo end-to-end (branch, statuses incl. rename + untracked in a new dir,
 *  HEAD content, detached HEAD, non-repo dir). */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  gitBranch, gitBranchAsync, gitHeadContent, gitHeadContentAsync, gitPorcelain, gitPorcelainAsync, gitRunnerAsync, parsePorcelain, spawnGit, spawnGitAsync, toAsync, unquotePath,
  type GitRunner,
} from "../../src/sextant/git-status.ts";
import { fileDiff, fileDiffAsync, scanRepo, scanRepoAsync } from "../../src/sextant/sextant-files.ts";

const Z = [" M src/a.ts", "?? new.ts", "D  gone.ts", "R  new-name.ts", "old-name.ts", "A  added.ts", "AM added-mod.ts", "!! ignored.log", "MM both.ts", " D wt-deleted.ts", "RM moved-mod.ts", "was.ts", "C  copy.ts", "orig.ts", "?? ../above.ts", "UU conflict.ts", "T  typechange.ts"].join("\0") + "\0";

test("parsePorcelain (-z): M/A/D classes, renames/copies → M on the NEW path, untracked → A, ignored + paths above cwd dropped", () => {
  const m = parsePorcelain(Z);
  expect([...m]).toEqual([
    ["src/a.ts", "M"], ["new.ts", "A"], ["gone.ts", "D"], ["new-name.ts", "M"], ["added.ts", "A"], ["added-mod.ts", "A"],
    ["both.ts", "M"], ["wt-deleted.ts", "D"], ["moved-mod.ts", "M"], ["copy.ts", "M"], ["conflict.ts", "M"], ["typechange.ts", "M"],
  ]);
  expect(m.has("old-name.ts")).toBe(false);
  expect(m.has("ignored.log")).toBe(false);
  expect(m.has("../above.ts")).toBe(false);
  expect(parsePorcelain("")).toEqual(new Map());
  expect(parsePorcelain("\0\0")).toEqual(new Map());
});

test("parsePorcelain (newline form): `R old -> new`, quoted paths with tabs/quotes/UTF-8 octal escapes, CRLF, backslashes normalized", () => {
  const text = ["R  old.ts -> new.ts", " M \"we ird\\ttab.ts\"", "?? \"caf\\303\\251.ts\"", "A  \"say \\\"hi\\\".md\"", " M src\\win\\path.ts", "?? ./dotted.ts", ""].join("\r\n");
  const m = parsePorcelain(text);
  expect([...m]).toEqual([["new.ts", "M"], ["we ird\ttab.ts", "M"], ["café.ts", "A"], ["say \"hi\".md", "A"], ["src/win/path.ts", "M"], ["dotted.ts", "A"]]);
  expect(unquotePath("plain.ts")).toBe("plain.ts");
  expect(unquotePath("\"a\\\\b\"")).toBe("a\\b");
  expect(unquotePath("\"\"")).toBe("");
});

// ---------- injected runner (no git / not a repo / throwing) ----------

const none: GitRunner = () => null;
const notRepo: GitRunner = () => ({ status: 128, stdout: "" });
const boom: GitRunner = () => { throw new Error("spawn EACCES"); };
const fake = (table: Record<string, string>): GitRunner => (args) => { const k = args.join(" "); return k in table ? { status: 0, stdout: table[k]! } : { status: 128, stdout: "" }; };

test("no git → null (never throws) for gitBranch / gitPorcelain / gitHeadContent through the injected runner", () => {
  for (const run of [none, notRepo, boom]) {
    expect(gitBranch("C:/x", run)).toBeNull();
    expect(gitPorcelain("C:/x", run)).toBeNull();
    expect(gitHeadContent("C:/x", "a.ts", run)).toBeNull();
  }
});

test("gitBranch: abbrev-ref, detached HEAD → short sha, no commits yet → symbolic-ref; gitPorcelain parses; gitHeadContent asks `show HEAD:./path`", () => {
  expect(gitBranch("C:/x", fake({ "rev-parse --abbrev-ref HEAD": "feature/auth\n" }))).toBe("feature/auth");
  expect(gitBranch("C:/x", fake({ "rev-parse --abbrev-ref HEAD": "HEAD\n", "rev-parse --short HEAD": "d6d3977\n" }))).toBe("d6d3977");
  expect(gitBranch("C:/x", fake({ "rev-parse --abbrev-ref HEAD": "HEAD\n" }))).toBe("HEAD");
  expect(gitBranch("C:/x", fake({ "rev-parse --abbrev-ref HEAD": "", "symbolic-ref --short -q HEAD": "main\n" }))).toBe("main");
  const seen: string[][] = [];
  const spy: GitRunner = (args, cwd) => { seen.push([cwd, ...args]); return { status: 0, stdout: Z }; };
  expect(gitPorcelain("C:/x", spy)?.get("new-name.ts")).toBe("M");
  expect(seen).toEqual([["C:/x", "status", "--porcelain=v1", "-z", "--untracked-files=all"]]);
  seen.length = 0;
  const head: GitRunner = (args, cwd) => { seen.push([cwd, ...args]); return { status: 0, stdout: "const a = 1;\n" }; };
  expect(gitHeadContent("C:/x", ".\\src\\a.ts", head)).toBe("const a = 1;\n");
  expect(seen).toEqual([["C:/x", "show", "HEAD:./src/a.ts"]]);
  expect(gitHeadContent("C:/x", "../escape.ts", head)).toBeNull();
  expect(seen).toHaveLength(1); // never asked
  expect(gitHeadContent("C:/x", "", head)).toBeNull();
});

// ---------- real git end-to-end ----------

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const haveGit = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;

test.if(haveGit)("real repo: branch, M/A/D incl. staged rename and untracked file inside a new dir, HEAD content, detached HEAD, non-repo → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-git-"));
  try {
    git(dir, "init", "-q");
    git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "core.autocrlf", "false");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "const b = 2;\n");
    writeFileSync(join(dir, "sub", "c.ts"), "const c = 3;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    expect(gitBranch(dir)).toBe("main");
    expect(gitPorcelain(dir)).toEqual(new Map()); // clean
    writeFileSync(join(dir, "a.ts"), "const a = 2;\n");
    unlinkSync(join(dir, "b.ts"));
    writeFileSync(join(dir, "new.ts"), "new\n");
    mkdirSync(join(dir, "fresh"));
    writeFileSync(join(dir, "fresh", "d.ts"), "d\n");
    renameSync(join(dir, "sub", "c.ts"), join(dir, "sub", "renamed.ts"));
    git(dir, "add", "-A", "sub");
    const m = gitPorcelain(dir)!;
    expect([...m].sort()).toEqual([["a.ts", "M"], ["b.ts", "D"], ["fresh/d.ts", "A"], ["new.ts", "A"], ["sub/renamed.ts", "M"]]);
    expect(m.has("sub/c.ts")).toBe(false);
    expect(gitHeadContent(dir, "a.ts")).toBe("const a = 1;\n");
    expect(gitHeadContent(dir, "sub/c.ts")).toBe("const c = 3;\n");
    expect(gitHeadContent(dir, "new.ts")).toBeNull();
    // cwd given with backslashes still works on Windows (on POSIX a backslash is a name byte, not a separator)
    if (process.platform === "win32") expect(gitBranch(dir.replace(/\//g, "\\"))).toBe("main");
    git(dir, "checkout", "-q", "--detach");
    expect(gitBranch(dir)).toMatch(/^[0-9a-f]{7,}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- re-verify pass: the async twins (#44 LOW-3) ----------

test("gitRunnerAsync: a hung child is killed at the timeout and the call resolves null (no rejection, no 30 s wait); a missing executable resolves null; a throwing sync runner wrapped by toAsync yields null through the twins", async () => {
  const t0 = Date.now();
  const hang = gitRunnerAsync({ timeoutMs: 100, argv: () => [process.execPath, "-e", "setTimeout(() => {}, 30000)"] });
  expect(await hang(["x"], ".")).toBeNull();
  // 15 s, not 5: the claim is "the 100 ms timeout fires instead of waiting 30 s for the sleeper", and
  // spawning a node child on a loaded machine can eat several seconds without saying anything about
  // that claim. The mutation this guards (no timeout at all) parks for 30 s and still fails.
  expect(Date.now() - t0).toBeLessThan(15_000);
  const missing = gitRunnerAsync({ argv: () => ["definitely-not-a-binary-f44", "--version"] });
  expect(await missing(["x"], ".")).toBeNull();
  for (const run of [none, notRepo, boom]) {
    expect(await gitBranchAsync("C:/x", toAsync(run))).toBeNull();
    expect(await gitPorcelainAsync("C:/x", toAsync(run))).toBeNull();
    expect(await gitHeadContentAsync("C:/x", "a.ts", toAsync(run))).toBeNull();
  }
  expect(await gitBranchAsync("C:/x", toAsync(fake({ "rev-parse --abbrev-ref HEAD": "HEAD\n", "rev-parse --short HEAD": "d6d3977\n" })))).toBe("d6d3977");
  expect(await gitHeadContentAsync("C:/x", "../escape.ts", toAsync(fake({})))).toBeNull();
}, 30_000); // spawns real child processes; bun's 5 s default cut this under parallel load

test.if(haveGit)("real repo: every async twin answers exactly what its sync form does — branch, porcelain (rename + untracked), HEAD content, the full scanRepo snapshot, fileDiff; `git --version` through spawnGitAsync exits 0; a non-repo dir → null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-git-async-"));
  try {
    git(dir, "init", "-q");
    git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(dir, "config", "user.email", "t@example.com"); git(dir, "config", "user.name", "t"); git(dir, "config", "core.autocrlf", "false");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n"); writeFileSync(join(dir, "b.ts"), "const b = 2;\n"); writeFileSync(join(dir, "sub", "c.ts"), "const c = 3;\n");
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init");
    writeFileSync(join(dir, "a.ts"), "const a = 2;\n"); unlinkSync(join(dir, "b.ts")); writeFileSync(join(dir, "new.ts"), "new\n");
    renameSync(join(dir, "sub", "c.ts"), join(dir, "sub", "renamed.ts")); git(dir, "add", "-A", "sub");
    expect(await gitBranchAsync(dir)).toBe(gitBranch(dir));
    expect(await gitBranchAsync(dir)).toBe("main");
    expect(await gitPorcelainAsync(dir)).toEqual(gitPorcelain(dir));
    expect([...(await gitPorcelainAsync(dir))!].sort()).toEqual([["a.ts", "M"], ["b.ts", "D"], ["new.ts", "A"], ["sub/renamed.ts", "M"]]);
    expect(await gitHeadContentAsync(dir, "a.ts")).toBe("const a = 1;\n");
    expect(await gitHeadContentAsync(dir, "new.ts")).toBeNull();
    const snap = await scanRepoAsync(dir);
    expect(snap).toEqual(scanRepo(dir));
    expect(snap.git).toBe(true); expect(snap.branch).toBe("main"); expect(snap.paths).toContain("sub/renamed.ts"); expect(snap.paths).toContain("new.ts");
    expect(await fileDiffAsync(dir, "a.ts", undefined)).toEqual(fileDiff(dir, "a.ts", undefined));
    expect(await fileDiffAsync(dir, "a.ts", undefined)).toMatchObject({ add: 1, del: 1, base: "head" });
    expect((await spawnGitAsync(["--version"], dir))?.status).toBe(0);
    const outside = mkdtempSync(join(tmpdir(), "rovecode-sx-norepo-async-"));
    try {
      const inside = spawnSync("git", ["-C", outside, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", windowsHide: true }).status === 0;
      if (!inside) { expect(await gitBranchAsync(outside)).toBeNull(); expect(await gitPorcelainAsync(outside)).toBeNull(); expect((await scanRepoAsync(outside)).git).toBe(false); }
      expect(await gitBranchAsync(join(outside, "definitely", "missing"))).toBeNull();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // ~40 real git child processes, 2.4 s on an idle machine. bun's default per-test budget is 5 s, so under
  // a full suite this failed on the clock while every assertion in it was fine. The work is genuinely this
  // large — the alternative to the budget is a smaller test, not a faster one.
}, 30_000);

test.if(haveGit)("real git, not a repo / missing dir → null for all three (real spawnGit, nothing thrown)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-norepo-"));
  try {
    const inside = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", windowsHide: true }).status === 0;
    if (!inside) {
      expect(gitBranch(dir)).toBeNull();
      expect(gitPorcelain(dir)).toBeNull();
      expect(gitHeadContent(dir, "x.ts")).toBeNull();
    }
    expect(gitBranch(join(dir, "definitely", "missing"))).toBeNull();
    expect(gitPorcelain(join(dir, "definitely", "missing"))).toBeNull();
    expect(spawnGit(["--version"], dir)?.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
