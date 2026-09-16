/** The real `rovecode sessions …`, `rovecode trace` and `rovecode --resume` CLI (main.ts subprocess, 2026-09-07) with a
 *  scratch project dir + scratch HOME and a scrubbed env — no provider, no network, nothing boots a runtime: the list
 *  table with its hollow-directory footer, `--json` rows (title key ONLY when set), rename, delete (--yes; the session
 *  dir AND its checkpoints shadow dir are gone; refused off a TTY without --yes; an ambiguous prefix removes nothing),
 *  fork (--json → exactly {id, from, title}), search, traversal ids refused BEFORE any write, the `--resume` refusals
 *  that used to open a fresh session silently, and `trace` through the same resolver. Each spawn has a hang bound. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { checkpointShadowDir } from "../../src/coding/checkpoints.ts";
import { SessionStore } from "../../src/core/session.ts";
import type { ForkResult, SearchRow } from "../../src/core/session-ops.ts";
import type { SessionRow } from "../../src/cli/sessions-cmd.ts";
import type { Message } from "../../src/core/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const SPAWN_MS = 120_000;
const testMs = (spawns: number): number => spawns * SPAWN_MS + 30_000;
let cwd = "", home = "", sessions = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-sess-cli-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-sess-home-"));
  sessions = join(cwd, ".rovecode", "sessions");
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

/** the real CLI in the scratch project with only this test's env: no ROVECODE_ knobs, no *_API_KEY, HOME + ROVECODE_HOME = scratch */
function cli(args: string[]): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k) && !/^ROVECODE_/i.test(k)) env[k] = v;
  env.HOME = home; env.USERPROFILE = home; env.ROVECODE_HOME = home;
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: SPAWN_MS, killSignal: "SIGKILL" });
  if (r.exitCode === null) throw new Error(`rovecode ${args.join(" ")}: no exit within ${SPAWN_MS}ms (hang bound)`);
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
}
const oneLine = (s: string): boolean => s.trim() !== "" && s.trim().split("\n").length === 1;

const umsg = (text: string, parentId: string | null = null): Message => ({ id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });
const amsg = (text: string, parentId: string | null): Message => ({ id: randomUUID(), role: "assistant", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });
function seed(id: string, texts: string[]): SessionStore {
  const s = new SessionStore(sessions, id);
  let parent: string | null = null;
  texts.forEach((t, i) => { const m = i % 2 === 0 ? umsg(t, parent) : amsg(t, parent); s.append(m); parent = m.id; });
  return s;
}
const hollow = (id: string): void => { mkdirSync(join(sessions, id), { recursive: true }); writeFileSync(join(sessions, id, "meta.json"), JSON.stringify({ id, createdAt: Date.now() })); };

test("list: the table (newest first, a title in place of the first prompt) + ONE footer counting the hollow directories from the stat alone; --json is the row array with `title` ONLY when set; an empty project says so; nothing boots", () => {
  seed("aaaa-1111", ["first prompt here", "sure"]);
  seed("bbbb-2222", ["other"]);
  hollow("hollow-1"); hollow("hollow-2");
  expect(cli(["sessions", "rename", "aaaa", "Ship  it\ttoday"])).toMatchObject({ code: 0, stderr: "" });
  const rows = JSON.parse(cli(["sessions", "--json"]).stdout) as SessionRow[];
  expect(rows.map((r) => r.id).sort()).toEqual(["aaaa-1111", "bbbb-2222"]); // the hollow ones are not rows
  const a = rows.find((x) => x.id === "aaaa-1111")!, b = rows.find((x) => x.id === "bbbb-2222")!;
  expect(a.title).toBe("Ship it today");
  expect(Object.keys(a).sort()).toEqual(["created", "cwd", "entries", "firstPrompt", "id", "title", "turns", "updated"]);
  expect(Object.keys(b).sort()).toEqual(["created", "cwd", "entries", "firstPrompt", "id", "turns", "updated"]); // never title: null
  expect(a.firstPrompt).toBe("first prompt here");
  expect(a.turns).toBe(1);
  const table = cli(["sessions"]);
  expect(table.code).toBe(0);
  const lines = table.stdout.trimEnd().split("\n");
  expect(lines[0]).toContain(`sessions in ${sessions}`);
  expect(lines.length).toBe(2 + 2 + 1);
  expect(lines.at(-1)).toBe(`2 empty session directories in ${sessions} — nothing was ever written to them`);
  expect(table.stdout).toContain("Ship it today");
  expect(table.stdout).toContain("other");
  expect(readdirSync(home).filter((d) => d !== ".bun")).toEqual([]); // no ~/.rovecode, no credentials, no trust file
  const none = cli(["sessions"]);
  rmSync(sessions, { recursive: true, force: true });
  const empty = cli(["sessions"]);
  expect(none.code).toBe(0);
  expect(empty.code).toBe(0);
  expect(empty.stdout).toMatch(/^no sessions in /);
}, testMs(5));

test("rename: empty title / missing title / unknown id / bad id → exit 2 + one stderr line, nothing changed; an unknown verb is exit 2 with the usage", () => {
  seed("aaaa-1111", ["first prompt here"]);
  for (const args of [["rename", "aaaa", "   "], ["rename", "aaaa"], ["rename", "zzzz", "x"], ["rename"], ["rename", "../x", "t"], ["frobnicate"]]) {
    const bad = cli(["sessions", ...args]);
    expect(bad.code, args.join(" ")).toBe(2);
    expect(bad.stdout, args.join(" ")).toBe("");
    expect(oneLine(bad.stderr), args.join(" ")).toBe(true);
    expect(bad.stderr, args.join(" ")).toContain("usage: rovecode sessions");
  }
  expect(cli(["sessions", "rename", "zzzz", "x"]).stderr).toContain('no session matching "zzzz"');
  expect(cli(["sessions", "rename", "../x", "t"]).stderr).toContain("not a plain directory name");
  expect("title" in JSON.parse(readFileSync(join(sessions, "aaaa-1111", "meta.json"), "utf8"))).toBe(false);
  expect(readdirSync(sessions).sort()).toEqual(["aaaa-1111"]);
  expect(existsSync(join(cwd, ".rovecode", "x"))).toBe(false);
}, testMs(8));

test("delete <prefix> --yes removes exactly the session dir + its checkpoints shadow dir (a read-only file inside) and prints both paths; without --yes on a non-TTY stdin → exit 2, nothing removed; an ambiguous prefix → exit 2 naming the candidates, nothing removed", () => {
  seed("del-aaa", ["gone"]);
  seed("del-aab", ["stays"]);
  seed("keep-1", ["keep"]);
  const shadow = checkpointShadowDir(cwd, "del-aaa");
  mkdirSync(join(shadow, ".git"), { recursive: true });
  writeFileSync(join(shadow, ".git", "HEAD"), "ref: refs/heads/main\n");
  chmodSync(join(shadow, ".git", "HEAD"), 0o444);
  const otherShadow = checkpointShadowDir(cwd, "keep-1");
  mkdirSync(otherShadow, { recursive: true }); writeFileSync(join(otherShadow, "checkpoints.jsonl"), "");
  const snapshot = () => [readdirSync(sessions).sort(), readdirSync(join(cwd, ".rovecode", "checkpoints")).sort()];
  const before = snapshot();
  const noYes = cli(["sessions", "delete", "del-aaa"]); // stdin "ignore" → not a TTY
  expect(noYes.code).toBe(2); // MUTATION TARGET: drop the --yes gate
  expect(noYes.stdout).toBe("");
  expect(oneLine(noYes.stderr)).toBe(true);
  expect(noYes.stderr).toContain("--yes");
  expect(snapshot()).toEqual(before);
  const amb = cli(["sessions", "delete", "del-a", "--yes"]);
  expect(amb.code).toBe(2); // MUTATION TARGET: resolve an ambiguous prefix to the first hit
  expect(amb.stderr).toContain("matches 2 sessions");
  expect(amb.stderr).toContain("del-aaa");
  expect(amb.stderr).toContain("del-aab");
  expect(oneLine(amb.stderr)).toBe(true);
  expect(snapshot()).toEqual(before);
  const ok = cli(["sessions", "delete", "del-aaa", "--yes"]);
  expect(ok.code).toBe(0);
  expect(ok.stderr).toBe("");
  const removedLines = ok.stdout.trim().split("\n");
  expect(removedLines.length).toBe(2);
  expect(removedLines.every((l) => l.startsWith("removed ") && basename(l.slice("removed ".length)) === "del-aaa")).toBe(true);
  expect(removedLines.some((l) => l.includes("sessions"))).toBe(true);
  expect(removedLines.some((l) => l.includes("checkpoints"))).toBe(true); // MUTATION TARGET: drop the checkpoints removal
  expect(existsSync(join(sessions, "del-aaa"))).toBe(false);
  expect(existsSync(shadow)).toBe(false); // the shadow dir is GONE — a half-delete would leave space used with nothing pointing at it
  expect(existsSync(join(sessions, "del-aab"))).toBe(true);
  expect(existsSync(join(sessions, "keep-1"))).toBe(true);
  expect(existsSync(join(otherShadow, "checkpoints.jsonl"))).toBe(true);
}, testMs(3));

test("`../x`, an absolute path and an unknown id exit 2 BEFORE any write (delete --yes, rename, fork): no directory created anywhere, nothing removed — a planted <state dir>/x (where join(root, '../x') lands) survives", () => {
  seed("real-1", ["hi"]);
  writeFileSync(join(cwd, ".rovecode", "x"), "planted");
  const before = [readdirSync(cwd).sort(), readdirSync(join(cwd, ".rovecode")).sort(), readdirSync(sessions).sort()];
  for (const ref of ["../x", join(sessions, "real-1"), "nope", ".."]) {
    for (const verb of [["delete", ref, "--yes"], ["rename", ref, "t"], ["fork", ref]]) {
      const r = cli(["sessions", ...verb]);
      expect(r.code, verb.join(" ")).toBe(2);
      expect(r.stdout, verb.join(" ")).toBe("");
      expect(oneLine(r.stderr), verb.join(" ")).toBe(true);
    }
  }
  expect([readdirSync(cwd).sort(), readdirSync(join(cwd, ".rovecode")).sort(), readdirSync(sessions).sort()]).toEqual(before);
  expect(readFileSync(join(cwd, ".rovecode", "x"), "utf8")).toBe("planted");
}, testMs(12));

test("fork <prefix> [--json]: a new uuid dir with identical entries, title '(fork #1)', forkedFrom, id = the new dir; --json → exactly {id, from, title}; search finds the title tier and the recall tier; no terms → exit 2", () => {
  seed("src-1", ["look at this", "nice"]);
  const f = JSON.parse(cli(["sessions", "fork", "src", "--json"]).stdout) as ForkResult;
  expect(Object.keys(f).sort()).toEqual(["from", "id", "title"]);
  expect(f).toMatchObject({ from: "src-1", title: "look at this (fork #1)" });
  expect(readFileSync(join(sessions, f.id, "entries.jsonl"), "utf8")).toBe(readFileSync(join(sessions, "src-1", "entries.jsonl"), "utf8"));
  expect(JSON.parse(readFileSync(join(sessions, f.id, "meta.json"), "utf8"))).toMatchObject({ id: f.id, forkedFrom: "src-1", title: f.title });
  const prose = cli(["sessions", "fork", "src-1"]);
  expect(prose.code).toBe(0);
  expect(prose.stdout).toContain('fork of src-1 · "look at this (fork #1)"');
  const rows = JSON.parse(cli(["sessions", "search", "look", "--json"]).stdout) as SearchRow[];
  expect(rows.some((r) => r.entryId === "" && r.title === "look at this (fork #1)")).toBe(true); // title tier
  expect(rows.some((r) => r.sessionId === "src-1" && r.entryId !== "")).toBe(true);              // recall tier
  const none = cli(["sessions", "search"]);
  expect(none.code).toBe(2);
  expect(oneLine(none.stderr)).toBe(true);
  expect(cli(["sessions", "search", "zzzznothing"]).stdout).toMatch(/^no matches for "zzzznothing"/);
}, testMs(6));

test("--resume <bad|unknown|ambiguous> exits 2 with ONE stderr line BEFORE any surface boots and creates nothing (it used to open a new session under the typed name, silently); trace takes the same gate and prints a resolved session", () => {
  seed("alpha-one", ["hello one"]);
  seed("alpha-two", ["hello two"]);
  const before = readdirSync(sessions).sort();
  for (const [ref, says] of [["../x", "not a plain directory name"], ["typo", 'no session matching "typo"'], ["alpha", "matches 2 sessions"]] as const) {
    const r = cli(["--resume", ref]);
    expect(r.code, ref).toBe(2);
    expect(r.stdout, ref).toBe("");
    expect(oneLine(r.stderr), ref).toBe(true);
    expect(r.stderr, ref).toContain(says);
    expect(r.stderr, ref).toContain("--resume");
  }
  expect(cli(["--resume", "typo"]).stderr).toContain("rovecode sessions lists them");
  expect(readdirSync(sessions).sort()).toEqual(before);
  expect(existsSync(join(cwd, ".rovecode", "x"))).toBe(false);
  const noId = cli(["trace"]);
  expect(noId.code).toBe(2);
  expect(noId.stderr).toContain("rovecode trace needs a session id or prefix");
  expect(cli(["trace", "../x"]).code).toBe(2);
  expect(cli(["trace", "alpha"]).stderr).toContain("matches 2 sessions");
  const ok = cli(["trace", "alpha-o"]);
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("hello one");
  expect(readdirSync(sessions).sort()).toEqual(before);
}, testMs(9));
