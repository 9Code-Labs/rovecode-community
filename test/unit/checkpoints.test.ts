/** PORT #11 tests: shadow-git checkpoints (cline CheckpointTracker port)
 *  + the /restore command layer (checkpoints-cmd.ts) against stubbed ctx.
 *  Every fixture is a temp dir; git runs ONLY against those fixtures. */

import { test, expect } from "bun:test";
import { Checkpoints, MUTATING_KINDS, anchorEntryId } from "../../src/coding/checkpoints.ts";
import { cmdRestore, type CheckpointCmdCtx } from "../../src/tui/checkpoints-cmd.ts";
import type { Renderer } from "../../src/tui/renderer.ts";
import { SessionStore } from "../../src/core/session.ts";
import { toOpenAiMessages } from "../../src/providers/stream.ts";
import type { Message } from "../../src/core/types.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

function ws(): string { return mkdtempSync(join(tmpdir(), "rovecode-cp-")); }

/** Minimal CheckpointCmdCtx: notes + branch targets captured, everything else inert. */
function cmdCtx(cp: Checkpoints | null): { ctx: CheckpointCmdCtx; notes: string[]; branched: string[] } {
  const notes: string[] = [];
  const branched: string[] = [];
  const renderer = { addSystemNote: (t: string) => { notes.push(t); }, pickOne: async () => null } as unknown as Renderer;
  return {
    ctx: {
      renderer, busy: () => false, sessionId: () => "s1",
      checkpointsFor: async () => cp,
      branchTo: (id) => { branched.push(id); return true; },
      replayAndRefresh: () => {},
    },
    notes, branched,
  };
}

/** Assistant tool_call ids with no role:"tool" reply in the lowered wire form —
 *  a non-empty result is exactly the history shape providers reject with a 400. */
function orphanToolCalls(wire: Record<string, unknown>[]): string[] {
  const replied = new Set(wire.filter((m) => m.role === "tool").map((m) => String(m.tool_call_id)));
  const orphans: string[] = [];
  for (const m of wire) {
    if (m.role !== "assistant") continue;
    for (const c of (m.tool_calls as { id: string }[] | undefined) ?? []) if (!replied.has(c.id)) orphans.push(c.id);
  }
  return orphans;
}

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

test("snapshot per write: shadow git-dir under .rovecode/checkpoints/<session>, workspace stays non-git", async () => {
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
  // git-dir lives under .rovecode/checkpoints/<session>; the WORKSPACE has no .git at all
  expect(cp.gitDir.startsWith(join(w, ".rovecode", "checkpoints", "s1"))).toBe(true);
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

test("excludes: node_modules and .rovecode are never snapshotted, never deleted by restore", async () => {
  const w = ws();
  mkdirSync(join(w, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(w, "node_modules", "pkg", "x.js"), "junk");
  mkdirSync(join(w, ".rovecode", "sessions", "s1"), { recursive: true });
  writeFileSync(join(w, ".rovecode", "sessions", "s1", "entries.jsonl"), "{}");
  writeFileSync(join(w, "a.txt"), "v1");

  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  const c1 = await cp.snapshot("snap");
  const tracked = execFileSync("git", ["--git-dir", cp.gitDir, "ls-files"], { encoding: "utf8" });
  expect(tracked).toContain("a.txt");
  expect(tracked).not.toContain("node_modules");
  expect(tracked).not.toContain(".rovecode");

  writeFileSync(join(w, "node_modules", "pkg", "later.js"), "installed later");
  const r = await cp.restore(c1.hash, "files");
  expect(r.ok).toBe(true);
  expect(existsSync(join(w, "node_modules", "pkg", "later.js"))).toBe(true); // ignored files survive restore
  expect(existsSync(join(w, ".rovecode", "sessions", "s1", "entries.jsonl"))).toBe(true);
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

// ---------- R2 verdict fixes (HIGH-1/2, MED-3, LOW-5) ----------

test("HIGH-1: restore never throws — a stale index.lock returns ok:false naming the failing VERB", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one", "e1");
  writeFileSync(join(w, "a.txt"), "v2");
  writeFileSync(join(cp.gitDir, "index.lock"), ""); // hostile: a crashed git left its lock behind
  const r = await cp.restore(c1.hash, "files");     // pre-fix this REJECTED → unhandled → Bun exit 1
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error).toMatch(/git reset failed/);                 // the verb (LOW-5a)…
    expect(r.error).not.toContain(`git ${cp.gitDir} failed`);    // …not the git-dir path blame
  }
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v2");     // failed restore left the tree alone
  rmSync(join(cp.gitDir, "index.lock"));
  const r2 = await cp.restore(c1.hash, "files");                 // not wedged: lock gone → works
  expect(r2.ok).toBe(true);
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v1");
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("HIGH-1 surface: cmdRestore renders the failure as a note and never rejects (app.ts void's it)", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one", "e1");
  writeFileSync(join(cp.gitDir, "index.lock"), "");
  const { ctx, notes } = cmdCtx(cp);
  await cmdRestore(ctx, c1.hash.slice(0, 8));       // a rejection here = dead TUI process
  expect(notes.some((n) => n.includes("restore failed:") && n.includes("reset"))).toBe(true);
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("HIGH-2: anchorEntryId picks the LAST USER message, and branching there yields a well-formed wire history", async () => {
  const w = ws();
  const store = new SessionStore(join(w, "sessions"), "s1");
  const u1: Message = { id: "u1", role: "user", parts: [{ kind: "text", text: "add a feature" }], parentId: null, createdAt: 1 };
  const a1: Message = { id: "a1", role: "assistant", parts: [{ kind: "tool_call", id: "t1", tool: "write", args: { path: "a.txt", content: "x" } }], parentId: "u1", createdAt: 2 };
  store.append(u1); store.append(a1); // the loop appends the assistant PRE-dispatch: this IS snapshot-time state

  const anchor = anchorEntryId(store.messages());
  expect(anchor).toBe("u1");                                   // NOT .at(-1) — that is a1, the tool issuer
  expect(store.messages().at(-1)!.id).toBe("a1");

  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "x");
  const c1 = await cp.snapshot("write", anchor);
  const r = await cp.restore(c1.hash, "conversation");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.entryId).toBe("u1");
  expect(store.branch(r.entryId!)).toBe(true);
  const trimmed = store.messages();
  expect(trimmed.at(-1)!.role).toBe("user");                   // history ends at the user turn
  expect(orphanToolCalls(toOpenAiMessages(trimmed))).toEqual([]); // no dangling tool_calls on the wire
  // CONTRAST — the pre-fix anchor (tail entry) branches to exactly the provider-400 shape:
  expect(store.branch("a1")).toBe(true);
  expect(orphanToolCalls(toOpenAiMessages(store.messages()))).toEqual(["t1"]);
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("MED-3 module: duplicate hashes are ONE candidate and the LATEST entry's anchor wins", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one", "e-old");
  // identical content re-snapshotted can mint the SAME commit hash (same tree/parent/second);
  // forge the sidecar shape directly so the fixture is deterministic
  const sidecar = join(w, ".rovecode", "checkpoints", "s1", "checkpoints.jsonl");
  appendFileSync(sidecar, JSON.stringify({ hash: c1.hash, label: "one", entryId: "e-new", createdAt: Date.now() }) + "\n");
  const cp2 = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  expect(cp2.list().length).toBe(2);

  const conv = await cp2.restore(c1.hash, "conversation");     // pre-fix hits[0] returned e-old
  expect(conv.ok).toBe(true);
  if (conv.ok) expect(conv.entryId).toBe("e-new");
  writeFileSync(join(w, "a.txt"), "v2");
  const files = await cp2.restore(c1.hash.slice(0, 12), "files"); // prefix across duplicates: NOT ambiguous
  expect(files.ok).toBe(true);
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v1");
  rmSync(w, { recursive: true, force: true });
}, 30000);

test("MED-3 surface: cmdRestore dedupes candidates by hash instead of refusing the ref forever", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one", "e-old");
  const sidecar = join(w, ".rovecode", "checkpoints", "s1", "checkpoints.jsonl");
  appendFileSync(sidecar, JSON.stringify({ hash: c1.hash, label: "one", entryId: "e-new", createdAt: Date.now() }) + "\n");
  const cp2 = await Checkpoints.init({ workspace: w, sessionId: "s1" });

  const { ctx, notes, branched } = cmdCtx(cp2);
  await cmdRestore(ctx, `${c1.hash.slice(0, 8)} conversation`);
  expect(notes.some((n) => n.includes("be more specific"))).toBe(false); // pre-fix: permanent refusal
  expect(notes.some((n) => n.startsWith(`restored ${c1.hash.slice(0, 8)}`))).toBe(true);
  expect(branched).toEqual(["e-new"]);                                   // latest anchor, matching the module
  rmSync(w, { recursive: true, force: true });
}, 30000);

const winTest = process.platform === "win32" ? test : test.skip;
winTest("LOW-5b: case-variant workspace path (C:\\foo vs c:\\foo) reopens the shadow repo instead of throwing", async () => {
  const w = ws();
  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  writeFileSync(join(w, "a.txt"), "v1");
  const c1 = await cp.snapshot("one", "e1");
  const variant = (/^[A-Z]/.test(w) ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1);
  const cp2 = await Checkpoints.init({ workspace: variant, sessionId: "s1" }); // pre-fix: threw "belongs to …"
  expect(cp2.list().map((c) => c.hash)).toEqual([c1.hash]);
  writeFileSync(join(w, "a.txt"), "v2");
  const r = await cp2.restore(c1.hash, "files");
  expect(r.ok).toBe(true);
  expect(readFileSync(join(w, "a.txt"), "utf8")).toBe("v1");
  rmSync(w, { recursive: true, force: true });
}, 30000);

test('LOW-5c: dot-only session ids ("." / "..") cannot collapse into or escape the shadow root', async () => {
  const w = ws();
  const root = join(w, ".rovecode", "checkpoints");
  for (const sid of [".", ".."]) {
    const cp = await Checkpoints.init({ workspace: w, sessionId: sid });
    const shadowDir = dirname(cp.gitDir);
    expect(resolve(shadowDir).startsWith(root + sep)).toBe(true); // "..": escaped to .rovecode pre-fix
    expect(resolve(shadowDir)).not.toBe(root);                    // ".": collapsed ONTO the root pre-fix
  }
  rmSync(w, { recursive: true, force: true });
}, 30000);
