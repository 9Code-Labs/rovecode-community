/** The argv guard: an unknown first word falls through to the one-shot `run`, and a prompt is billed. A
 *  single PATH-SHAPED word (dispatch.ts pathShaped) must not be sent silently — off a TTY the CLI refuses
 *  with exit 2 and says how to send it on purpose; `rovecode run <word>` is never guarded; a sentence is
 *  never guarded. Regression for 2026-09-06, when `rovecode ./src/cli/main.ts` typed by mistake became a
 *  real provider call. The CLI runs hermetically (no ROVECODE_*, no *_API_KEY, empty ROVECODE_HOME), so an
 *  unguarded prompt is told apart by the OTHER exit-2 message — the "no provider" refusal from cmdRun. */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathShaped } from "../../src/cli/dispatch.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const never = (): boolean => false;
const T = 60_000;

// ---------- the pure shape test ----------

test("pathShaped: path prefixes, drive letters and file extensions, with nothing on disk", () => {
  for (const w of ["./src/cli/main.ts", "../x", "/etc/hosts", ".\\src", "..\\x", "\\\\server\\share", "C:\\Users\\b", "c:/repo", "main.ts", "README.md", "notes.txt", "package.json", "a.yaml", "x.py", "deploy.sh"]) {
    expect(pathShaped(w, never)).toBe(true);
  }
});

test("pathShaped: words and sentences are prompts — never guarded", () => {
  for (const w of ["hello", "fix", "summarise", "fix the failing tests", "./x is broken, fix it", "what does main.ts do", "help me", "v2", "1.2.3"]) {
    expect(pathShaped(w, never)).toBe(false);
  }
  expect(pathShaped("", never)).toBe(false);
});

test("pathShaped: a bare name that exists on disk counts; one that does not, does not; a throwing probe is 'no'", () => {
  expect(pathShaped("src", (p) => p === "src")).toBe(true);
  expect(pathShaped("src", (p) => p !== "src")).toBe(false);
  expect(pathShaped("src", () => { throw new Error("EACCES"); })).toBe(false);
  expect(pathShaped("src", never)).toBe(false);
});

// ---------- the real CLI, off a TTY ----------

let work = "", home = "";
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "rovecode-argv-guard-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-argv-guard-home-"));
  writeFileSync(join(work, "notes.md"), "# notes\n");
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  env.ROVECODE_HOME = home;
  const r = Bun.spawnSync({ cmd: [process.execPath, MAIN, ...args], cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test("a path-shaped first word off a TTY: exit 2, the reason names the word, says a prompt is billed, and shows the explicit `run` form; nothing else ran", () => {
  const r = cli(["./src/cli/main.ts"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('"./src/cli/main.ts" looks like a path, not a prompt');
  expect(r.stderr).toContain("billed");
  expect(r.stderr).toContain("rovecode run ./src/cli/main.ts");
  expect(r.stderr).not.toContain("no provider"); // refused BEFORE the runtime booted, not by the provider gate
  expect(r.stdout).toBe("");
}, T);

test("an existing bare name in the cwd is guarded too, and the words after it are kept in the suggested `run` form", () => {
  const r = cli(["notes.md", "summarise this"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('"notes.md" looks like a path');
  expect(r.stderr).toContain('rovecode run notes.md "summarise this"');
}, T);

test("`rovecode run <path>` is the explicit form and is never guarded: it reaches the provider gate (a different exit-2 message)", () => {
  const r = cli(["run", "./src/cli/main.ts"]);
  expect(r.code).toBe(2);
  expect(r.stderr).not.toContain("looks like a path");
}, T);

test("a sentence is a prompt, not a path: not guarded, reaches the provider gate", () => {
  const r = cli(["fix the failing tests in ./src/cli/main.ts"]);
  expect(r.code).toBe(2);
  expect(r.stderr).not.toContain("looks like a path");
}, T);

test("a known command that happens to be a directory name in the cwd is dispatched as the command, not guarded", () => {
  mkdirSync(join(work, "tools"), { recursive: true });
  const r = cli(["tools"]);
  expect(r.code).toBe(0);
  expect(r.stderr).not.toContain("looks like a path");
  expect(r.stdout).toContain("ask_user");
}, T);
