/** Port #65 fix (LOW) — the ONE `--plain` routing line for /commit and /undo (cli/repl.ts → tui/git-plain.ts
 *  runPlainGitCommand) had no test. A REAL `rovecode --plain` subprocess in a temp git repository with a staged change:
 *  `/undo` before any checkpoint prints the no-checkpoint note, `/commit feat: x` prints the approval question with the
 *  exact bash command, `y` commits it — `git log -1` shows the message. Mutation: the routing line removed → both lines
 *  go to the (dead) provider as prompts, the repository keeps its single commit and this fails. Hermetic: a scrubbed env
 *  (no ROVECODE_/AION_ or *_API_KEY leaks), a dead configured provider so the no-provider prompt is skipped (the
 *  tui-context-cmds idiom), scratch HOME + NIMBUS_HOME, retries off, a deadline on every wait, the child killed in
 *  finally. */

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** a repo with one commit of a.txt and a staged change; identity, no gpg, no hooks — nothing read from HOME */
function initRepo(dir: string): void {
  git(dir, "init", "-q");
  mkdirSync(join(dir, ".nohooks"));
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", join(dir, ".nohooks")]]) git(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.txt"), "one\nwidget\n");
  git(dir, "add", "a.txt");
}

function scrubbedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AION|ROVECODE)_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  return {
    ...env, NO_COLOR: "1", HOME: home, ROVECODE_HOME: home,
    // a configured (dead) provider skips the interactive provider prompt; retries off so a mis-routed line fails fast
    ROVECODE_BASE_URL: "http://127.0.0.1:9/v1", ROVECODE_API_KEY: "x", ROVECODE_RETRY_MAX: "0", ROVECODE_NO_REPOMAP: "1",
  };
}

test("rovecode --plain: /undo and /commit reach runPlainGitCommand — `/commit feat: x` asks over readline with the exact bash command, `y` commits it (git log -1), the routing line is the only way there", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rove-p65-plain-git-"));
  const home = mkdtempSync(join(tmpdir(), "rove-p65-plain-home-"));
  initRepo(cwd);
  const main = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
  const proc = Bun.spawn([process.execPath, "run", main, "--plain"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: scrubbedEnv(home) });
  let out = "", err = "";
  const dec = new TextDecoder();
  const pump = (async () => { for await (const chunk of proc.stdout) out += dec.decode(chunk, { stream: true }); })().catch(() => {});
  const pumpErr = (async () => { for await (const chunk of proc.stderr) err += dec.decode(chunk, { stream: true }); })().catch(() => {});
  const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
    const d = Date.now() + ms;
    while (Date.now() < d && !pred()) await new Promise((r) => setTimeout(r, 50));
    if (!pred()) throw new Error(`${what}: not seen within ${ms}ms\nstdout:\n${out}\nstderr:\n${err}`);
  };
  try {
    await until(() => out.includes("commands:"), 30_000, "the REPL banner");
    expect(out).toContain("commands: /exit /new /yolo");
    proc.stdin.write("/undo\n");
    await until(() => out.includes("no checkpoint to undo to"), 20_000, "the /undo note");
    proc.stdin.write("/commit feat: x\n");
    await until(() => out.includes("allow? [y]es / [n]o:"), 30_000, "the commit approval question");
    expect(out).toContain(`approval needed: bash ${JSON.stringify({ command: "git commit -m 'feat: x'" })}`);
    expect(out).toContain("    commit message:");
    expect(out).toContain("      feat: x");
    expect(out).toContain("    files (1): a.txt");
    expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1");           // nothing committed before the answer
    proc.stdin.write("y\n");
    await until(() => /\n {2}committed \[\S+ [0-9a-f]+\] feat: x/.test(out), 30_000, "the committed note");
    proc.stdin.write("/exit\n");
    await proc.stdin.end();
    await until(() => out.includes("bye — session"), 15_000, "the exit line");
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
    await pump;
    await pumpErr;
  }
  expect(git(cwd, "log", "-1", "--pretty=%B")).toBe("feat: x");        // mutation: routing line removed → "init" (the line went to the dead provider)
  expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("2");
  expect(out).not.toContain("error:");                                    // no line reached the (dead) model
  for (const d of [cwd, home]) for (let i = 0; i < 20; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}, 120_000);
