/** src/market/prereq.ts — "is the program this item needs on PATH?", asked before the yes.
 *
 *  Nothing here touches the real machine: PATH, PATHEXT, the platform and the existence test are all
 *  injected, so the same assertions hold on a Windows laptop, a Linux runner, and a machine that happens
 *  to have uv installed. A prerequisite test that consults the developer's own PATH tells you about the
 *  developer, not about the code.
 *
 *  The rules being pinned are as much about restraint as behaviour: never execute, never compare versions,
 *  never block, and say nothing rather than something reassuring and empty. */

import { test, expect } from "bun:test";
import { checkPrereq, prereqLine, prereqOf, type PrereqEnv } from "../../src/market/prereq.ts";
import type { MarketItem } from "../../src/market/types.ts";

/** A machine with exactly these files on PATH and no others.
 *
 *  The Windows fake is case-INSENSITIVE, because the real one is and the difference is not cosmetic:
 *  PATHEXT is conventionally uppercase (`.CMD`) while what is on disk is `npx.cmd`. A case-sensitive fake
 *  reports every Node installation as missing and sends you looking for a bug in the lookup that is really
 *  a bug in the test. */
const machine = (files: string[], over: Partial<PrereqEnv> = {}): PrereqEnv => {
  const windows = over.windows ?? false;
  const norm = (p: string) => { const s = p.replace(/\\/g, "/"); return windows ? s.toLowerCase() : s; };
  const have = new Set(files.map(norm));
  return { PATH: "/usr/bin:/usr/local/bin", windows: false, exists: (p: string) => have.has(norm(p)), ...over };
};

const item = (install: MarketItem["install"], kind: MarketItem["kind"] = "mcp"): MarketItem => ({
  id: "x", kind, title: "X", publisher: "p", description: "d",
  source: "curated" as MarketItem["source"], tags: [], env: [], install,
});

const stdio = (command: string): MarketItem["install"] => ({
  kind: "mcp",
  entry: { key: "x", title: "X", source: "curated", publisher: "p", description: "d",
           installs: [{ kind: "stdio", runtime: "other", command, args: [], env: [], pending: [] }] } as never,
});

// ------------------------------------------------------------------ the lookup

test("a program on PATH is found, and its location is reported", () => {
  const r = checkPrereq("uvx", machine(["/usr/local/bin/uvx"]));
  expect(r.found).toBe(true);
  expect(r.path).toBe("/usr/local/bin/uvx");
});

test("a program that is not there is reported missing, with a hint when we can name one honestly", () => {
  const r = checkPrereq("uvx", machine([]));
  expect(r.found).toBe(false);
  expect(r.path).toBeUndefined();
  expect(r.hint).toContain("uv");
  // a program we cannot name a source for gets no hint rather than a guessed one
  expect(checkPrereq("some-vendor-cli", machine([])).hint).toBeUndefined();
});

/** The check that decides whether this feature is useful on Windows at all: `npx` on disk is `npx.cmd`,
 *  so a bare-name lookup reports every Node installation in the world as missing. */
test("on Windows a bare name is resolved through PATHEXT", () => {
  const win = machine(["C:/Program Files/nodejs/npx.cmd"], {
    PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    windows: true,
  });
  const r = checkPrereq("npx", win);
  expect(r.found).toBe(true);
  // the extension comes from PATHEXT, which is conventionally uppercase, so the reported path is
  // `npx.CMD` while the file is `npx.cmd`. Both open the same file on Windows and the path is only ever
  // shown, never re-parsed — so this asserts what is true rather than tidying the casing for looks.
  expect(r.path!.toLowerCase()).toContain("npx.cmd");
});

test("PATH is parsed the way each platform writes it, quotes and blank entries included", () => {
  const win = machine(["C:/tools/git.exe"], { PATH: '"C:\\tools";;C:\\other', PATHEXT: ".EXE", windows: true });
  expect(checkPrereq("git", win).found).toBe(true);
  const posix = machine(["/opt/bin/git"], { PATH: "/usr/bin::/opt/bin" });
  expect(checkPrereq("git", posix).found).toBe(true);
});

test("a launch line that names a path is checked as a path, not searched for on PATH", () => {
  const m = machine(["/opt/custom/mcp-server"]);
  expect(checkPrereq("/opt/custom/mcp-server", m).found).toBe(true);
  expect(checkPrereq("/opt/missing/mcp-server", m).found).toBe(false);
});

test("an empty PATH is not an error, just an answer of no", () => {
  expect(checkPrereq("git", machine([], { PATH: "" })).found).toBe(false);
});

// ------------------------------------------------------------------ what each kind needs

test("an MCP stdio entry is checked against the command it will actually launch", () => {
  expect(prereqOf(item(stdio("uvx")), machine(["/usr/bin/uvx"]))!.program).toBe("uvx");
  expect(prereqOf(item(stdio("docker")), machine([]))!.found).toBe(false);
  // the registry's runtimeHint already became `command` upstream, so nothing is re-derived here
  expect(prereqOf(item(stdio("bunx")), machine(["/usr/bin/bunx"]))!.program).toBe("bunx");
});

test("a remote MCP entry launches nothing locally, so there is no line", () => {
  const http = { kind: "mcp", entry: { key: "x", title: "X", source: "curated", publisher: "p", description: "d",
    installs: [{ kind: "http", url: "https://mcp.example.com/mcp", headers: [] }] } } as unknown as MarketItem["install"];
  expect(prereqOf(item(http), machine([]))).toBeUndefined();
});

/** The case the original design said would never fire, and the one that fires most. Every row in both
 *  catalogs today is git-sourced — 19 of 19 skills, 3 of 3 plugins — so on a machine without git every
 *  install in the market fails AFTER the human has said yes. That is precisely the failure this exists to
 *  move earlier, so it would have been the wrong thing to leave out. */
test("a git-sourced skill or plugin needs git, and says so", () => {
  const skill = item({ kind: "skill", source: { git: "https://github.com/anthropics/skills", subfolder: "skills/pdf" } }, "skill");
  const plugin = item({ kind: "plugin", source: "https://github.com/9Code-Labs/rovecode", git: true, subfolder: "plugins/notes" }, "plugin");
  for (const i of [skill, plugin]) {
    const p = prereqOf(i, machine([]))!;
    expect(p.program).toBe("git");
    expect(p.found).toBe(false);
    expect(p.hint).toContain("git-scm.com");
  }
  expect(prereqOf(skill, machine(["/usr/bin/git"]))!.found).toBe(true);
});

test("a skill that ships its files, or a plugin from a local folder, needs nothing", () => {
  const offline = item({ kind: "skill", files: [{ path: "SKILL.md", text: "---\nname: x\n---\n" }] }, "skill");
  const local = item({ kind: "plugin", source: "./plugins/notes", git: false }, "plugin");
  expect(prereqOf(offline, machine([]))).toBeUndefined();
  expect(prereqOf(local, machine([]))).toBeUndefined();
});

// ------------------------------------------------------------------ the line, and the restraint

test("the line reads as a statement about PATH, never as a verdict on the machine", () => {
  expect(prereqLine(checkPrereq("npx", machine(["/usr/bin/npx"])))).toBe("npx ✓");
  // the SHAPE, not the sentence: which command installs uv and where it is documented belongs to the hint
  // table, and pinning it here breaks this test the day someone corrects a URL that has nothing to do with
  // what is under test. What must hold is that a known tool names itself, says PATH, and offers a way out.
  const uvx = prereqLine(checkPrereq("uvx", machine([])))!;
  expect(uvx.startsWith("uvx — not on PATH")).toBe(true);
  expect(uvx).toMatch(/\(install: .+\)$/);
  // a tool with no hint gets the bare line rather than an empty pair of brackets
  expect(prereqLine(checkPrereq("weird-tool", machine([])))).toBe("weird-tool — not on PATH");
  // "not on PATH" and not "not installed": someone may have it where PATH does not reach
  expect(prereqLine(checkPrereq("uvx", machine([])))).not.toContain("not installed");
  expect(prereqLine(undefined)).toBeUndefined();
});

/** The restraint is the feature. If this ever starts running the program it checks, it can hang, prompt,
 *  or start a daemon during what the user was told is a preview. */
test("nothing is executed and no version is read: the only question asked is whether a file is there", () => {
  const looked: string[] = [];
  const r = checkPrereq("docker", { PATH: "/usr/bin", windows: false, exists: (p) => { looked.push(p); return false; } });
  expect(r.found).toBe(false);
  expect(looked).toEqual(["/usr/bin/docker"]);          // one question, about one path
  expect(JSON.stringify(r)).not.toMatch(/version|\d+\.\d+/);
});
