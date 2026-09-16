/** Port #66 — the real `rovecode auth login|list|remove` CLI (main.ts subprocess) with a scratch
 *  HOME/ROVECODE_HOME and a scrubbed env: the Anthropic refusal (exit 1, the owner-decision note, no
 *  network), the usage/unknown-provider paths, `auth list` over a hand-written store showing kind +
 *  expiry with the tokens redacted, `auth remove` deleting an oauth entry, and the help text. Every
 *  spawn carries a hard timeout. Real logins are NOT run here (no accounts, no network): the flows
 *  are covered in-process by the oauth-*.test.ts files against fake servers. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const TOKEN = "copilot-CANARY-access-token-0123456789";
const REFRESH = "gho_CANARY_refresh_0123456789";
const OR_KEY = "sk-or-CANARY-permanent-0123456789";
let home = "";

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "rovecode-auth-cli-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** HANG bound per CLI spawn, not a latency claim: the real `main.ts` boot imports the whole tree (~1–2 s idle)
 *  and a saturated box stretched `auth list` past the old 30 s (reproduced under a parallel full suite) while
 *  every answer was right. Nothing here times the CLI — the bound exists so a CLI that never exits fails with
 *  its command named instead of wedging the run. Each test's Bun timeout sits above `spawns × SPAWN_MS`. */
const SPAWN_MS = 120_000;
const testMs = (spawns: number): number => spawns * SPAWN_MS + 30_000;

/** the real CLI with only this test's env: no ROVECODE_ knobs, no *_API_KEY, HOME + ROVECODE_HOME = scratch */
function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/_API_KEY$/.test(k) && !/^ROVECODE_/i.test(k)) env[k] = v;
  }
  env.HOME = home; env.USERPROFILE = home; env.ROVECODE_HOME = home;
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: SPAWN_MS, killSignal: "SIGKILL" });
  if (r.exitCode === null) throw new Error(`rovecode ${args.join(" ")}: no exit within ${SPAWN_MS}ms (hang bound — see SPAWN_MS)`);
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
}

test("auth login anthropic is refused: exit 1, the owner-decision note citing research/round3_landscape.md:64-66, nothing on stdout, no file written", () => {
  const r = runCli(["auth", "login", "anthropic"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("rovecode auth login anthropic: refused");
  expect(r.stderr).toContain("owner decision");
  expect(r.stderr).toContain("research/round3_landscape.md:64-66");
  expect(r.stderr).toContain("rovecode auth set anthropic");
  expect(existsSync(join(home, "credentials.json"))).toBe(false);
}, testMs(1));

test("auth login without a provider prints the usage (exit 1); an unknown provider names it; the bare `auth` usage mentions login", () => {
  const none = runCli(["auth", "login"]);
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("usage: rovecode auth login <github-copilot|openrouter|openai>");
  const unknown = runCli(["auth", "login", "nosuch"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('no OAuth login for "nosuch"');
  expect(unknown.stderr).toContain("usage: rovecode auth login <github-copilot|openrouter|openai>");
  const bare = runCli(["auth"]);
  expect(bare.code).toBe(1);
  expect(bare.stderr).toContain("rovecode auth login <github-copilot|openrouter|openai>");
}, testMs(3));

test("auth list shows kind + expiry for oauth entries next to api entries, tokens redacted; auth remove deletes the oauth entry", () => {
  writeFileSync(join(home, "credentials.json"), JSON.stringify({
    "github-copilot": { type: "oauth", access: TOKEN, refresh: REFRESH, expires: 1_700_000_000_000 },
    openrouter: { type: "oauth", access: OR_KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER },
    openai: { type: "api", key: "sk-oai-CANARY-0123456789", keyName: "OPENAI_API_KEY" },
  }), "utf8");
  const list = runCli(["auth", "list"]);
  expect(list.code).toBe(0);
  const lines = list.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^github-copilot oauth {2}oauth token {14}copi… {2}EXPIRED 2023-11-14T22:13:20\.000Z$/);
  expect(lines[1]).toMatch(/^openai {9}api {4}OPENAI_API_KEY {11}sk-o…$/);
  expect(lines[2]).toMatch(/^openrouter {5}oauth {2}oauth token {14}sk-o… {2}never expires$/);
  for (const secret of [TOKEN, REFRESH, OR_KEY, "CANARY"]) expect(list.stdout + list.stderr).not.toContain(secret);

  const rm = runCli(["auth", "remove", "github-copilot"]);
  expect(rm.code).toBe(0);
  expect(rm.stdout).toContain("removed credential for github-copilot");
  const raw = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as Record<string, unknown>;
  expect(raw["github-copilot"]).toBeUndefined();
  expect(Object.keys(raw).sort()).toEqual(["openai", "openrouter"]);
  const again = runCli(["auth", "remove", "github-copilot"]);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("no stored credential for github-copilot");
}, testMs(3));

test("auth list with nothing stored points at both onboarding commands; help documents auth login", () => {
  const list = runCli(["auth", "list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("no stored credentials");
  expect(list.stdout).toContain("rovecode auth login <provider>");
  // rovecode's help is grouped: the short page carries the one-line entry, `help all` the reference with the refusals
  const help = runCli(["help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("auth login <id>");
  expect(help.stdout).toContain("github-copilot");
  const all = runCli(["help", "all"]);
  expect(all.code).toBe(0);
  expect(all.stdout).toContain("rovecode auth login <provider>");
  expect(all.stdout).toContain("anthropic is refused");
  expect(all.stdout).toContain("openai (ChatGPT device code; the token is sent over the Codex Responses wire only");
  expect(all.stdout).toContain("kind (api | oauth)");
}, testMs(3));
