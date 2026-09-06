/** cli/connect.ts — `rovecode connect` as one line: the argv parser, then the register → key → model →
 *  test → default flow with injected secret/stdin/save/probe (no network, no terminal). The secret is a
 *  canary: it must never appear in the output. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { parseConnectArgs, runConnect, type ConnectArgs } from "../../src/cli/connect.ts";

const CANARY = "sk-canary-secret-0123456789abcdef";
let home: string; let cwd: string; let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rovecode-connect-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-connect-cwd-"));
  savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** hermetic registry: an empty env so the host's real keys never count as configured */
const registry = (env: Record<string, string> = {}) => new ProviderRegistry(cwd, { env, throttleMs: 0 });

function harness(args: ConnectArgs, opts: { env?: Record<string, string>; tty?: boolean; probeOk?: boolean; stdin?: string } = {}) {
  const out: string[] = [];
  const saved: { id: string; secret: string; keyEnv: string }[] = [];
  const probed: { id: string; model?: string }[] = [];
  const reg = registry(opts.env);
  const run = () => runConnect(args, {
    registry: reg,
    tty: opts.tty ?? false,
    out: (l) => out.push(l),
    secret: async () => CANARY,
    stdin: async () => opts.stdin ?? "",
    save: (id, s, keyEnv) => saved.push({ id, secret: s, keyEnv }),
    probe: async (id, model) => {
      probed.push({ id, model });
      return opts.probeOk === false
        ? { ok: false, model: model ?? "", detail: "HTTP 401: bad key" }
        : { ok: true, model: model ?? "", detail: "ok in 12 ms (5 in / 1 out tokens)" };
    },
  });
  return { out, saved, probed, reg, run };
}

const base: ConnectArgs = { id: "anthropic", key: "auto", scope: "user", test: true };
const userFile = () => JSON.parse(readFileSync(join(home, "providers.json"), "utf8")) as { default?: string; providers?: Record<string, { baseUrl: string; noKey?: boolean; keyEnv?: string; defaultModel?: string; protocol?: string }> };

// ---------- the parser ----------

test("parse: a bare id defaults to auto key, user scope and a test call", () => {
  expect(parseConnectArgs(["anthropic"])).toEqual({ id: "anthropic", key: "auto", scope: "user", test: true });
});

test("parse: id + url + every flag", () => {
  expect(parseConnectArgs(["me", "https://h/v1", "--model", "m1", "--protocol", "anthropic", "--key", "--project", "--no-test"]))
    .toEqual({ id: "me", baseUrl: "https://h/v1", model: "m1", protocol: "anthropic", key: "prompt", scope: "project", test: false });
});

test("parse: the id is lowercased, and a bad one is refused before anything is written", () => {
  expect(parseConnectArgs(["ANTHROPIC"])).toMatchObject({ id: "anthropic" });
  expect(parseConnectArgs(["what a name"])).toMatchObject({ error: expect.stringContaining("won't work as an id") });
});

test("parse: two key flags contradict instead of one silently winning", () => {
  expect(parseConnectArgs(["x", "--key", "--no-key"])).toEqual({ error: "--key and --no-key contradict each other — pick one" });
  expect(parseConnectArgs(["x", "--key-stdin", "--key-env", "K"])).toMatchObject({ error: expect.stringContaining("contradict") });
});

test("parse: usage errors — no id, a third positional, a flag without a value, a bad url, a stray flag", () => {
  expect(parseConnectArgs([])).toMatchObject({ error: expect.stringContaining("needs a provider id") });
  expect(parseConnectArgs(["a", "https://h/v1", "extra"])).toMatchObject({ error: expect.stringContaining('unexpected argument "extra"') });
  expect(parseConnectArgs(["a", "--model"])).toMatchObject({ error: expect.stringContaining("--model needs a value") });
  expect(parseConnectArgs(["a", "ftp://h"])).toMatchObject({ error: expect.stringContaining("not an http(s) URL") });
  expect(parseConnectArgs(["a", "--protocol", "grpc"])).toMatchObject({ error: expect.stringContaining("openai or anthropic") });
  expect(parseConnectArgs(["a", "--nope"])).toMatchObject({ error: expect.stringContaining("unknown flag --nope") });
});

test("parse: --protocol without a base URL has nothing to apply to", () => {
  expect(parseConnectArgs(["anthropic", "--protocol", "openai"])).toMatchObject({ error: expect.stringContaining("only applies when you give a base URL") });
});

// ---------- the flow ----------

test("built-in with the key in the env: nothing stored, one probe, the default persisted", async () => {
  const h = harness(base, { env: { ANTHROPIC_API_KEY: "sk-from-env" } });
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([]);
  expect(h.probed).toEqual([{ id: "anthropic", model: "claude-opus-5" }]);
  expect(userFile().default).toBe("anthropic/claude-opus-5");
  expect(h.out.join("\n")).toContain("already has a key (env ANTHROPIC_API_KEY)");
});

test("--key-stdin stores one piped line and never echoes it", async () => {
  const h = harness({ ...base, id: "groq", key: "stdin", model: "llama-3.3" }, { stdin: `${CANARY}\nignored second line\n` });
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([{ id: "groq", secret: CANARY, keyEnv: "GROQ_API_KEY" }]);
  expect(userFile().default).toBe("groq/llama-3.3");
  expect(h.out.join("\n")).not.toContain(CANARY);
});

test("empty stdin stores nothing and exits 2", async () => {
  const h = harness({ ...base, id: "groq", key: "stdin" }, { stdin: "\n" });
  expect(await h.run()).toBe(2);
  expect(h.saved).toEqual([]);
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("no key and no terminal: a pipe is never consumed by a prompt", async () => {
  const h = harness({ ...base, id: "openai" }, { tty: false });
  expect(await h.run()).toBe(2);
  expect(h.saved).toEqual([]);
  expect(h.out.join("\n")).toContain("no terminal to ask on");
});

test("no key but a terminal: the hidden prompt runs and the secret is stored, not printed", async () => {
  const h = harness({ ...base, id: "openai", model: "gpt-x" }, { tty: true });
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([{ id: "openai", secret: CANARY, keyEnv: "OPENAI_API_KEY" }]);
  expect(h.out.join("\n")).not.toContain(CANARY);
});

test("a base URL registers the endpoint, inferring the protocol", async () => {
  const h = harness({ id: "myproxy", baseUrl: "https://api.example.com/v1", model: "m1", key: "stdin", scope: "user", test: true }, { stdin: CANARY });
  expect(await h.run()).toBe(0);
  const f = userFile();
  expect(f.providers!.myproxy).toMatchObject({ baseUrl: "https://api.example.com/v1", protocol: "openai", defaultModel: "m1" });
  expect(f.default).toBe("myproxy/m1");
});

test("--no-key turns a built-in row into a local keyless server", async () => {
  const h = harness({ id: "ollama", model: "llama3", key: "none", scope: "user", test: false });
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([]);
  expect(h.probed).toEqual([]);
  expect(userFile().providers!.ollama).toMatchObject({ noKey: true });
  expect(h.out.join("\n")).toContain("needs no key (local server)");
});

test("--key-env points at an env var instead of storing anything", async () => {
  const h = harness({ id: "anthropic", keyEnv: "WORK_KEY", key: "auto", scope: "user", test: true }, { env: { WORK_KEY: "sk-work" } });
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([]);
  expect(userFile().providers!.anthropic).toMatchObject({ keyEnv: "WORK_KEY" });
});

test("an unknown id without a URL says what it knows and writes nothing", async () => {
  const h = harness({ ...base, id: "wat" });
  expect(await h.run()).toBe(2);
  expect(existsSync(join(home, "providers.json"))).toBe(false);
  expect(h.out.join("\n")).toContain("→ next: rovecode connect wat <baseUrl>");
});

test("a failed test call still writes the config, but exits 1 so a script notices", async () => {
  const h = harness({ ...base, model: "claude-opus-5" }, { env: { ANTHROPIC_API_KEY: "sk-bad" }, probeOk: false });
  expect(await h.run()).toBe(1);
  expect(userFile().default).toBe("anthropic/claude-opus-5");
  expect(h.out.join("\n")).toContain("rovecode provider test anthropic claude-opus-5");
});

test("--no-test skips the call entirely", async () => {
  const h = harness({ ...base, test: false }, { env: { ANTHROPIC_API_KEY: "sk-env" } });
  expect(await h.run()).toBe(0);
  expect(h.probed).toEqual([]);
  expect(userFile().default).toBe("anthropic/claude-opus-5");
});

test("a provider with no model is connected but left without a default", async () => {
  const h = harness({ id: "openai", key: "stdin", scope: "user", test: true }, { stdin: CANARY });
  expect(await h.run()).toBe(0);
  expect(h.probed).toEqual([]);
  expect(h.out.join("\n")).toContain("rovecode model list openai");
  // a built-in needs no providers.json entry, and there is no model to make default — so nothing is written
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("--project writes the project providers.json, not the home one", async () => {
  const h = harness({ ...base, scope: "project", test: false }, { env: { ANTHROPIC_API_KEY: "sk-env" } });
  expect(await h.run()).toBe(0);
  const f = JSON.parse(readFileSync(join(cwd, ".rovecode", "providers.json"), "utf8")) as { default?: string };
  expect(f.default).toBe("anthropic/claude-opus-5");
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});
