/** cli/setup.ts — `rovecode setup` with scripted answers, an injected probe and save (no network, no
 *  masked prompt): the pick → model → key → test → default flow, the local-server and own-URL doors,
 *  the non-TTY recipe and the cancel path. The secret is a canary: it must never appear in the output. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { runSetup, SETUP_DONE, SETUP_PICKS } from "../../src/cli/setup.ts";

const CANARY = "sk-canary-secret-0123456789abcdef";
let home: string; let cwd: string; let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rovecode-setup-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-setup-cwd-"));
  savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home; // credentials.json + user providers.json land here
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** hermetic registry: an empty env so the host's real keys never count as configured */
const registry = () => new ProviderRegistry(cwd, { env: {}, throttleMs: 0 });

function harness(answers: string[], opts: { secret?: string; probeOk?: boolean } = {}) {
  const out: string[] = [];
  const saved: { id: string; secret: string; keyEnv: string }[] = [];
  const probed: { id: string; model?: string }[] = [];
  const reg = registry();
  const run = () => runSetup({
    registry: reg, tty: true,
    out: (l) => out.push(l),
    ask: async () => answers.shift() ?? "",
    secret: async () => opts.secret ?? CANARY,
    save: (id, s, keyEnv) => saved.push({ id, secret: s, keyEnv }),
    probe: async (id, model) => {
      probed.push({ id, model });
      return opts.probeOk === false ? { ok: false, model: model ?? "", detail: "HTTP 401: bad key" } : { ok: true, model: model ?? "", detail: "ok in 12 ms (5 in / 1 out tokens)" };
    },
  });
  return { out, saved, probed, reg, run };
}

const userFile = () => JSON.parse(readFileSync(join(home, "providers.json"), "utf8")) as { default?: string; providers?: Record<string, unknown> };

test("hosted pick: provider → default model → key (saved, never printed) → one probe → default persisted → Done", async () => {
  const h = harness(["1", ""]); // anthropic, keep the suggested model
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([{ id: "anthropic", secret: CANARY, keyEnv: "ANTHROPIC_API_KEY" }]);
  expect(h.probed).toEqual([{ id: "anthropic", model: "claude-opus-5" }]);
  expect(userFile().default).toBe("anthropic/claude-opus-5");
  const text = h.out.join("\n");
  expect(text).toContain("◆ rovecode setup");
  expect(text).toContain("key stored for anthropic (hidden");
  expect(text).toContain("ok in 12 ms");
  expect(text).toContain("default → anthropic/claude-opus-5");
  expect(text).toContain(SETUP_DONE);
  expect(text).not.toContain(CANARY);
});

test("a typed model id wins over the suggestion; a failed probe still sets the default and says what to check", async () => {
  const h = harness(["anthropic", "claude-haiku-4-5"], { probeOk: false }); // the id works as an answer too
  expect(await h.run()).toBe(0);
  const text = h.out.join("\n");
  expect(text).toContain("that didn't work: HTTP 401: bad key");
  expect(text).toContain("→ next: check the key and the URL, then rovecode provider test anthropic claude-haiku-4-5");
  expect(userFile().default).toBe("anthropic/claude-haiku-4-5");
});

test("local server pick: a keyless user entry is written, no secret prompt, probe + default run", async () => {
  const h = harness(["6", "llama3"]); // ollama
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([]);
  expect(h.probed).toEqual([{ id: "ollama", model: "llama3" }]);
  const f = userFile();
  expect(f.providers?.["ollama"]).toMatchObject({ noKey: true, baseUrl: "http://127.0.0.1:11434/v1" });
  expect(f.default).toBe("ollama/llama3");
  expect(h.out.join("\n")).toContain("marked as a local server");
});

test("own URL door: id + URL + no-key answer register the provider; no model → no probe, a clear next step, exit 0", async () => {
  const h = harness(["8", "MyProxy", "https://llm.example.com/v1", "n", ""]);
  expect(await h.run()).toBe(0);
  expect(h.probed).toEqual([]);
  expect(h.saved).toEqual([]);
  const f = userFile();
  expect(f.providers?.["myproxy"]).toMatchObject({ baseUrl: "https://llm.example.com/v1", protocol: "openai", noKey: true });
  expect(f.default).toBeUndefined();
  const text = h.out.join("\n");
  expect(text).toContain("myproxy registered (openai protocol");
  expect(text).toContain("has no model yet");
  expect(text).toContain("→ next: rovecode model list myproxy, then rovecode model use myproxy/<model>");
});

test("own URL door: a bad id or a non-http URL stops with a next step and writes nothing", async () => {
  const bad = harness(["9", "not ok!", "x"]);
  expect(await bad.run()).toBe(2);
  expect(bad.out.join("\n")).toContain("won't work as an id");
  const url = harness(["9", "proxy", "ftp://nope"]);
  expect(await url.run()).toBe(2);
  expect(url.out.join("\n")).toContain("is not an http(s) URL");
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("an empty secret keeps the provider, skips the probe and points at rovecode auth set", async () => {
  const h = harness(["2", "gpt-x"], { secret: "   " }); // openai, whitespace secret
  expect(await h.run()).toBe(0);
  expect(h.saved).toEqual([]);
  expect(h.probed).toEqual([]);
  const text = h.out.join("\n");
  expect(text).toContain("no key stored");
  expect(text).toContain("→ next: rovecode auth set openai");
  expect(userFile().default).toBe("openai/gpt-x"); // the pick is still the default; the key can follow
});

test("cancel and bad picks: empty answer cancels (2, nothing written); three wrong answers give up (2)", async () => {
  const c = harness([""]);
  expect(await c.run()).toBe(2);
  expect(c.out.join("\n")).toContain("cancelled — nothing changed");
  const w = harness(["x", "99", "zz"]);
  expect(await w.run()).toBe(2);
  expect(w.out.filter((l) => l.includes("is not on the list"))).toHaveLength(3);
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("no TTY: the three-line recipe (rovecode setup first), no questions asked, exit 2", async () => {
  const out: string[] = [];
  let asked = 0;
  const code = await runSetup({ registry: registry(), tty: false, out: (l) => out.push(l), ask: async () => { asked++; return "1"; } });
  expect(code).toBe(2);
  expect(asked).toBe(0);
  const text = out.join("\n");
  expect(text).toStartWith("no provider configured");
  expect(text).toContain("→ next: rovecode setup");
  expect(text).toContain("this stdin is a pipe");
});

test("the menu: nine picks, keys 1-9 in order, two URL doors last, locals marked", () => {
  expect(SETUP_PICKS.map((p) => p.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  expect(SETUP_PICKS.filter((p) => p.local).map((p) => p.id)).toEqual(["ollama", "lmstudio"]);
  expect(SETUP_PICKS.slice(-2).map((p) => p.url)).toEqual(["openai", "anthropic"]);
  for (const p of SETUP_PICKS) expect(p.label).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
});
