/** Provider credential store tests (port #37): CRUD in a temp ROVECODE_HOME, env-vs-stored
 *  precedence pinned in BOTH directions, redaction (a canary secret must never surface —
 *  in-process AND through the real `rovecode auth list` CLI), key-name resolution from the
 *  models.dev snapshot, file location, and error paths. Discriminating by construction:
 *  reverting the redactSecret body or swapping the stored/env passes in resolveProvider
 *  flips named tests here. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import {
  credentialsPath, loadCredentials, saveCredential, removeCredential,
  listProviders, redactSecret, keyNameFor, readSecret, echoScrubSequence,
} from "../../src/providers/auth.ts";
import { resolveProvider, listBuiltinProviders } from "../../src/providers/stream.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const CANARY = "CANARY-hunter2-3f9a1b7c-do-not-print";

// every env var resolveProvider or the auth store consults — saved/cleared per test
const ENV_KEYS = [
  "ROVECODE_HOME", "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL", "OPENAI_API_KEY",
  ...listBuiltinProviders().map((p) => p.envKey),
];
const savedEnv = new Map<string, string | undefined>();
let home = "";

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), "rovecode-auth-"));
  process.env.ROVECODE_HOME = home;
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  rmSync(home, { recursive: true, force: true });
});

/** Spawn the real CLI with only this test's env (no ambient keys leak in). */
function runCli(args: string[], stdin?: string): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/_API_KEY$/.test(k) && !/^ROVECODE_/.test(k)) env[k] = v;
  }
  env.ROVECODE_HOME = home;
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: ROOT, env,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
  });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
}

// ---------- file location ----------

test("credentials file lives at $ROVECODE_HOME/credentials.json", () => {
  saveCredential("anthropic", "sk-ant-roundtrip-0123456789");
  expect(credentialsPath()).toBe(join(home, "credentials.json"));
  expect(existsSync(join(home, "credentials.json"))).toBe(true);
});

test("default path (no ROVECODE_HOME) is ~/.rovecode/credentials.json — path only, nothing written", () => {
  delete process.env.ROVECODE_HOME;
  expect(credentialsPath()).toBe(join(homedir(), ".rovecode", "credentials.json"));
});

test("written file has restrictive permissions (POSIX 0o600; best-effort on Windows)", () => {
  saveCredential("openai", "sk-perm-check-0123456789");
  if (process.platform === "win32") {
    // fs mode bits only drive FILE_ATTRIBUTE_READONLY on Windows — protection comes from
    // the %USERPROFILE% NTFS ACL, so only existence is assertable here (see auth.ts note)
    expect(existsSync(credentialsPath())).toBe(true);
  } else {
    const mode = (require("node:fs").statSync(credentialsPath()).mode as number) & 0o777;
    expect(mode).toBe(0o600);
  }
});

// ---------- CRUD round-trip ----------

test("save → load → replace → remove round-trip", () => {
  saveCredential("anthropic", "sk-first-0123456789");
  expect(loadCredentials()["anthropic"]).toEqual({ type: "api", key: "sk-first-0123456789", keyName: "ANTHROPIC_API_KEY" });

  saveCredential("anthropic", "sk-second-0123456789", "MY_CUSTOM_KEY");
  expect(loadCredentials()["anthropic"]).toEqual({ type: "api", key: "sk-second-0123456789", keyName: "MY_CUSTOM_KEY" });

  expect(removeCredential("anthropic")).toBe(true);
  expect(loadCredentials()["anthropic"]).toBeUndefined();
  expect(existsSync(credentialsPath())).toBe(false); // last entry removed -> file removed
});

test("remove of a missing provider returns false and touches nothing", () => {
  saveCredential("openai", "sk-keepme-0123456789");
  expect(removeCredential("nosuch")).toBe(false);
  expect(loadCredentials()["openai"]?.key).toBe("sk-keepme-0123456789");
});

test("corrupt file reads as empty; malformed entries dropped; unknown types round-trip", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(credentialsPath(), "not json {", "utf8");
  expect(loadCredentials()).toEqual({});

  writeFileSync(credentialsPath(), JSON.stringify({
    good: { type: "api", key: "sk-good-0123456789" },
    noKey: { type: "api" },
    future: { type: "oauth", refresh: "r", access: "a" },
  }), "utf8");
  expect(Object.keys(loadCredentials())).toEqual(["good"]);

  saveCredential("openai", "sk-added-0123456789");
  removeCredential("good");
  const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
  expect(raw["future"]).toEqual({ type: "oauth", refresh: "r", access: "a" }); // preserved unharmed
});

test("whitespace-only stored key is dropped on load, so the env key wins; save refuses it too", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(credentialsPath(), JSON.stringify({ deepseek: { type: "api", key: " " } }), "utf8");
  expect(loadCredentials()).toEqual({});
  process.env.DEEPSEEK_API_KEY = "env-ds-key-0123456789";
  const cfg = resolveProvider();
  expect(cfg?.id).toBe("deepseek");
  expect(cfg?.apiKey).toBe("env-ds-key-0123456789"); // not the stored " "
  expect(() => saveCredential("deepseek", " \t ")).toThrow(/empty secret/);
});

// ---------- models.dev auth map ----------

test("keyNameFor: models.dev snapshot drives key names; fallback rule for off-catalog ids", () => {
  expect(keyNameFor("anthropic")).toBe("ANTHROPIC_API_KEY");   // snapshot, identity id
  expect(keyNameFor("openai")).toBe("OPENAI_API_KEY");
  expect(keyNameFor("deepseek")).toBe("DEEPSEEK_API_KEY");
  expect(keyNameFor("openrouter")).toBe("OPENROUTER_API_KEY");
  expect(keyNameFor("together")).toBe("TOGETHER_API_KEY");     // via togetherai mapping
  expect(keyNameFor("fireworks")).toBe("FIREWORKS_API_KEY");   // via fireworks-ai mapping
  expect(keyNameFor("moonshot")).toBe("MOONSHOT_API_KEY");     // via moonshotai alias
  expect(keyNameFor("kaesra")).toBe("KAESRA_API_KEY");         // not in models.dev -> fallback
  // a snapshot-only name the uppercase fallback CANNOT produce — proves models.dev drives:
  expect(keyNameFor("alibaba")).toBe("DASHSCOPE_API_KEY");
});

// ---------- redaction ----------

test("redaction: listProviders never exposes the secret (canary)", () => {
  saveCredential("anthropic", CANARY);
  const entries = listProviders();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.redacted).toBe("CANA…"); // first 4 chars + ellipsis, per bar
  expect(entries[0]!.keyName).toBe("ANTHROPIC_API_KEY");
  expect(JSON.stringify(entries)).not.toContain(CANARY);
});

test("redaction: secrets of 8 chars or fewer collapse to the ellipsis alone", () => {
  expect(redactSecret("short")).toBe("…");
  expect(redactSecret("12345678")).toBe("…");
  expect(redactSecret("123456789")).toBe("1234…");
});

// ---------- precedence (both directions pinned) ----------

test("precedence: stored credential beats a named env key (cross-provider selection)", () => {
  process.env.KAESRA_API_KEY = "env-kaesra-key-0123456789"; // kaesra is FIRST in builtin order
  saveCredential("anthropic", "sk-stored-ant-0123456789");
  const cfg = resolveProvider();
  expect(cfg?.id).toBe("anthropic");
  expect(cfg?.apiKey).toBe("sk-stored-ant-0123456789");
  expect(cfg?.protocol).toBe("anthropic");
});

test("precedence: same provider with both -> the STORED value wins over the env value", () => {
  process.env.OPENAI_API_KEY = "env-openai-key-0123456789";
  saveCredential("openai", "sk-stored-oai-0123456789");
  const cfg = resolveProvider();
  expect(cfg?.id).toBe("openai");
  expect(cfg?.apiKey).toBe("sk-stored-oai-0123456789");
});

test("precedence: explicit ROVECODE_BASE_URL/ROVECODE_API_KEY pair still beats stored creds", () => {
  saveCredential("anthropic", "sk-stored-ant-0123456789");
  process.env.ROVECODE_BASE_URL = "https://example.test/v1";
  process.env.ROVECODE_API_KEY = "explicit-pair-key-0123456789";
  const cfg = resolveProvider();
  expect(cfg?.id).toBe("custom");
  expect(cfg?.apiKey).toBe("explicit-pair-key-0123456789");
});

test("precedence: env-only still resolves (regression) and nothing-at-all is null", () => {
  expect(resolveProvider()).toBeNull();
  process.env.DEEPSEEK_API_KEY = "env-ds-key-0123456789";
  const cfg = resolveProvider();
  expect(cfg?.id).toBe("deepseek");
  expect(cfg?.apiKey).toBe("env-ds-key-0123456789");
});

// ---------- readSecret: the `rovecode auth set` prompt, driven in-process ----------

const PROMPT = "ANTHROPIC_API_KEY for anthropic: ";
type FakeTty = PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode?: (m: boolean) => unknown };

/** A TTY-like stdin: reports isTTY and (optionally) honours setRawMode like tty.ReadStream. */
function fakeTty(rawModeSupported: boolean): FakeTty {
  const s = new PassThrough() as FakeTty;
  s.isTTY = true;
  s.isRaw = false;
  if (rawModeSupported) s.setRawMode = function (this: FakeTty, m: boolean) { this.isRaw = m; return this; };
  return s;
}

function capture(columns?: number): { out: Writable & { columns?: number }; text: () => string } {
  let buf = "";
  const out = new Writable({ write(c, _e, cb) { buf += String(c); cb(); } }) as Writable & { columns?: number };
  if (columns !== undefined) out.columns = columns;
  return { out, text: () => buf };
}

test("readSecret (tty, raw mode): keystrokes never reach the terminal — output is prompt + newline only", async () => {
  const input = fakeTty(true);
  const { out, text } = capture(80);
  const pending = readSecret(PROMPT, { input, output: out });
  expect(input.isRaw).toBe(true); // readline terminal mode switched the driver's echo off
  input.write(CANARY);
  input.write("\r");
  expect(await pending).toBe(CANARY);
  expect(text()).toBe(PROMPT + "\n"); // readline's own echo went to the sink, not here
  expect(text()).not.toContain("CANARY");
  expect(input.isRaw).toBe(false); // restored on close
});

test("readSecret (tty, no raw mode available): erases every row the driver's echo wrapped onto", async () => {
  const input = fakeTty(false); // no setRawMode → the terminal driver echoes prompt+line itself
  const { out, text } = capture(80);
  const key = "sk-" + "0123456789".repeat(11).slice(0, 105); // 108 chars, like an Anthropic key
  const pending = readSecret(PROMPT, { input, output: out });
  expect(input.isRaw).toBe(false);
  input.write(key + "\r\n"); // a cooked driver delivers the whole line + CRLF at once
  expect(await pending).toBe(key);
  expect(text()).toBe(PROMPT + echoScrubSequence(PROMPT.length, key.length, 80));
  expect(text()).toContain("\x1b[1A\x1b[2K\x1b[1A\x1b[2K"); // 33 + 108 = 141 cols → 2 rows at 80
  expect(text()).not.toContain(key.slice(0, 8));
});

test("readSecret (piped stdin): no prompt, nothing written, trimmed line; EOF without a line → empty", async () => {
  const input = new PassThrough();
  const { out, text } = capture();
  const pending = readSecret(PROMPT, { input, output: out });
  input.end(`  ${CANARY}  \n`);
  expect(await pending).toBe(CANARY);
  expect(text()).toBe("");

  const empty = new PassThrough();
  const cap2 = capture();
  const pending2 = readSecret(PROMPT, { input: empty, output: cap2.out });
  empty.end();
  expect(await pending2).toBe("");
  expect(cap2.text()).toBe("");
});

// ---------- CLI end-to-end (real main.ts subprocess, temp ROVECODE_HOME) ----------

test("cli: auth set stores the piped secret without printing it; list redacts it", () => {
  const set = runCli(["auth", "set", "anthropic"], `${CANARY}\n`);
  expect(set.code).toBe(0);
  expect(set.stdout).toContain("ANTHROPIC_API_KEY");
  expect(set.stdout + set.stderr).not.toContain(CANARY);
  const stored = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as Record<string, { key: string }>;
  expect(stored["anthropic"]!.key).toBe(CANARY);

  const list = runCli(["auth", "list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("anthropic");
  expect(list.stdout).toContain("ANTHROPIC_API_KEY");
  expect(list.stdout).toContain("CANA…");
  expect(list.stdout + list.stderr).not.toContain(CANARY);
}, 30_000);

test("cli: auth set --key overrides the key name; remove deletes; remove missing errors", () => {
  const set = runCli(["auth", "set", "kaesra", "--key", "MY_PROXY_KEY"], "sk-proxy-0123456789\n");
  expect(set.code).toBe(0);
  const list = runCli(["auth", "list"]);
  expect(list.stdout).toContain("MY_PROXY_KEY");

  const rm = runCli(["auth", "remove", "kaesra"]);
  expect(rm.code).toBe(0);
  const rmMissing = runCli(["auth", "remove", "kaesra"]);
  expect(rmMissing.code).toBe(1);
  expect(rmMissing.stderr).toContain("no stored credential for kaesra");
}, 30_000);

test("cli: auth set rejects unknown providers and empty secrets (no partial writes)", () => {
  const unknown = runCli(["auth", "set", "not-a-provider"], "sk-whatever-0123456789\n");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('unknown provider "not-a-provider"');
  expect(unknown.stderr + unknown.stdout).not.toContain("sk-whatever");

  const empty = runCli(["auth", "set", "openai"], "");
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("empty secret");
  expect(existsSync(join(home, "credentials.json"))).toBe(false);
}, 30_000);
