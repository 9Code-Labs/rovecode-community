/** PORT #11 tests: shadow-git checkpoints (cline CheckpointTracker port).
 *  Every fixture is a temp dir; git runs ONLY against those fixtures. */

import { test, expect } from "bun:test";
import { Checkpoints, MUTATING_KINDS } from "../../src/coding/checkpoints.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ws(): string { return mkdtempSync(join(tmpdir(), "aion-cp-")); }

function userGit(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
}

/** Recursive content-hash map of a directory (relpath → sha1). Detects ANY mutation. */
function dirState(root: string, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${name.name}` : name.name;
    if (name.isDirectory()) for (const [k, v] of dirState(root, r)) out.set(k, v);
    else out.set(r, createHash("sha1").update(readFileSync(join(root, r))).digest("hex"));
  }
  return out;
}

test("snapshot per write: shadow git-dir under .aion/checkpoints/<session>, workspace stays non-git", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("write a.txt", "e1");
  writeFileSync(join(w, "a.txt"), "v2");
  writeFileSync(join(w, "b.txt"), "b");
  const c2 = await cp.snapshot("edit a.txt", "e2");

  expect(c1.hash).not.toBe(c2.hash);
  expect(cp.list().map((c) => c.label)).toEqual(["write a.txt", "edit a.txt"]);
  expect(cp.list().map((c) => c.entryId)).toEqual(["e1", "e2"]);
  // git-dir lives under .aion/checkpoints/<session>; the WORKSPACE has no .git at all
  expect(cp.gitDir.startsWith(join(w, ".aion", "checkpoints", "s1"))).toBe(true);
  expect(existsSync(join(cp.gitDir, "HEAD"))).toBe(true);
  expect(existsSync(join(w, ".git"))).toBe(false); // non-git workspace works & stays non-git
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("files-only restore round-trips both directions and removes later-created files", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one");
  writeFileSync(join(w, "a.txt"), "v2");
  writeFileSync(join(w, "c.txt"), "c");
  const c2 = await cp.snapshot("two");
  writeFileSync(join(w, "a.txt"), "v3");            // dirty edit after last snapshot
  writeFileSync(join(w, "d.txt"), "d");             // never snapshotted

  const back = await cp.restore(c1.hash, "files");
  expect(back.ok).toBe(true);
  if (back.ok) expect(back.entryId).toBeUndefined(); // files-only: no conversation branch
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v1");
  expect(existsSync(join(w, "c.txt"))).toBe(false);
  expect(existsSync(join(w, "d.txt"))).toBe(false); // untracked-at-restore file removed (stage-all before reset)

  const fwd = await cp.restore(c2.hash, "files");   // FORWARD restore: commits capture states, not deltas
  expect(fwd.ok).toBe(true);
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v2");
  expect(readFileSync(join(w, "c.txt"), "utf8")).toBe("c");
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("conversation-only restore returns the entryId to branch to and leaves files alone", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("turn 1", "entry-42");
  writeFileSync(join(w, "a.txt"), "changed after snapshot");

  const r = await cp.restore(c1.hash, "conversation");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.entryId).toBe("entry-42");     // caller feeds this to SessionStore.branch()
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("changed after snapshot"); // files untouched
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("both mode restores files AND returns the entryId", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("turn 1", "entry-7");
  writeFileSync(join(w, "a.txt"), "v2");
  await cp.snapshot("turn 2", "entry-8");

  const r = await cp.restore(c1.hash, "both");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.entryId).toBe("entry-7");
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v1");
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("conversation restore without a recorded entryId is rejected (no half-restore)", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("label only");       // no entryId recorded
  writeFileSync(join(w, "a.txt"), "v2");
  for (const mode of ["conversation", "both"] as const) {
    const r = await cp.restore(c1.hash, mode);
    expect(r.ok).toBe(false);
  }
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v2"); // "both" rejected BEFORE touching files
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("user .git (root and nested) is byte-for-byte untouched in a git workspace", async () => {
  const w = ws();
  // real user repo with a commit
  userGit(w, "init");
  writeFileSync(join(w, "tracked.txt"), "user v1");
  userGit(w, "add", "-A");
  userGit(w, "commit", "-m", "user commit");
  const headBefore = userGit(w, "rev-parse", "HEAD");
  // nested repo inside the workspace
  mkdirSync(join(w, "sub"));
  userGit(join(w, "sub"), "init");
  writeFileSync(join(w, "sub", "inner.txt"), "inner");
  userGit(join(w, "sub"), "add", "-A");
  userGit(join(w, "sub"), "commit", "-m", "nested commit");

  const rootGitBefore = dirState(join(w, ".git"));
  const nestedGitBefore = dirState(join(w, "sub", ".git"));

  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  const c1 = await cp.snapshot("first", "e1");
  writeFileSync(join(w, "tracked.txt"), "agent edit");
  await cp.snapshot("second", "e2");
  const r = await cp.restore(c1.hash, "files");
  expect(r.ok).toBe(true);
  expect(readFileSync(join(w, "tracked.txt"), "utf8")).toBe("user v1");

  // ANY mutation inside either .git — index, HEAD, refs, objects, config — fails here
  expect(dirState(join(w, ".git"))).toEqual(rootGitBefore);
  expect(dirState(join(w, "sub", ".git"))).toEqual(nestedGitBefore);
  expect(userGit(w, "rev-parse", "HEAD")).toBe(headBefore);
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("excludes: node_modules and .aion are never snapshotted, never deleted by restore", async () => {
  const w = ws();
  mkdirSync(join(w, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(w, "node_modules", "pkg", "x.js"), "junk");
  mkdirSync(join(w, ".aion", "sessions", "s1"), { recursive: true });
  writeFileSync(join(w, ".aion", "sessions", "s1", "entries.jsonl"), "{}");
  writeFileSync(join(w, "a.txt"), "v1");

  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  const c1 = await cp.snapshot("snap");
  const tracked = execFileSync("git", ["--git-dir", cp.gitDir, "ls-files"], { encoding: "utf8" });
  expect(tracked).toContain("a.txt");
  expect(tracked).not.toContain("node_modules");
  expect(tracked).not.toContain(".aion");

  writeFileSync(join(w, "node_modules", "pkg", "later.js"), "installed later");
  const r = await cp.restore(c1.hash, "files");
  expect(r.ok).toBe(true);
  expect(existsSync(join(w, "node_modules", "pkg", "later.js"))).toBe(true); // ignored files survive restore
  expect(existsSync(join(w, ".aion", "sessions", "s1", "entries.jsonl"))).toBe(true);
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("unknown ref → structured error; checkpoints survive re-init (sidecar reload)", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one", "e1");
  const miss = await cp.restore("deadbeefdeadbeef", "files");
  expect(miss.ok).toBe(false);
  if (!miss.ok) expect(miss.error).toContain("deadbeefdeadbeef");

  // fresh instance, same session: history + restore still work (resume path)
  const cp2 = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  expect(cp2.list().map((c) => c.label)).toEqual(["one"]);
  writeFileSync(join(w, "a.txt"), "v2");
  const r = await cp2.restore(c1.hash, "both");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.entryId).toBe("e1");
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v1");
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("MUTATING_KINDS drives the post-tool hook: write/execute in, read out", () => {
  expect(MUTATING_KINDS.has("write")).toBe(true);
  expect(MUTATING_KINDS.has("execute")).toBe(true);
  expect(MUTATING_KINDS.has("read")).toBe(false);
}, 30000);
