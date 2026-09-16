/** tui/providers-cmd.ts `/connect` — the TUI's one-line connect over the LIVE registry: bare it hands
 *  over to /setup, with an id it registers + tests + persists AND switches this session, a key that
 *  cannot be typed here is refused instead of landing in the transcript, and a missing key parks the
 *  command until it is stored elsewhere — then finishes on its own. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import { saveCredential } from "../../src/providers/auth.ts";
import { cmdConnect, cmdModels, type ProviderCmdCtx } from "../../src/tui/providers-cmd.ts";
import type { ModeManager } from "../../src/core/modes.ts";
import type { Renderer } from "../../src/tui/renderer.ts";

let home: string; let cwd: string; let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rovecode-tuiconnect-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiconnect-cwd-"));
  savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** the smallest ctx cmdConnect actually touches: a live registry, a note sink and the mode slot */
function harness(env: Record<string, string> = {}, opts: { pickOne?: unknown } = {}) {
  const reg = new ProviderRegistry(cwd, { env, throttleMs: 0 });
  const notes: string[] = [];
  const state = { provider: "none", model: "" };
  let slot = { provider: "none", model: "" };
  let pushed = 0;
  const ctx: ProviderCmdCtx = {
    rt: { providers: reg } as unknown as ProviderCmdCtx["rt"],
    modes: { setModel: (m: { provider: string; model: string }) => { slot = m; }, modelFor: () => slot, separate: false, mode: "act" } as unknown as ModeManager,
    state,
    renderer: {
      addSystemNote: (t: string) => { notes.push(t); },
      pickOne: opts.pickOne ?? (async () => null),
    } as unknown as Renderer,
    pushStatus: () => { pushed++; },
  };
  return { ctx, notes, state, reg, text: () => notes.join("\n"), pushes: () => pushed };
}

const userFile = () => JSON.parse(readFileSync(join(home, "providers.json"), "utf8")) as { default?: string; providers?: Record<string, { noKey?: boolean; keyEnv?: string }> };
const tick = () => new Promise((r) => setTimeout(r, 5));

test("bare /connect hands over to the guided /setup (the picker opens; Esc cancels it)", async () => {
  let asked = 0;
  const h = harness({}, { pickOne: async () => { asked++; return null; } });
  await cmdConnect(h.ctx, "   ");
  expect(asked).toBe(1);
  expect(h.text()).toContain("setup cancelled");
});

test("/connect <id> --no-test: registered, default persisted, and THIS session switches", async () => {
  const h = harness({ ANTHROPIC_API_KEY: "sk-env" });
  await cmdConnect(h.ctx, "anthropic --model claude-opus-5 --no-test");
  expect(userFile().default).toBe("anthropic/claude-opus-5");
  expect(h.state).toEqual({ provider: "anthropic", model: "claude-opus-5" });
  expect(h.pushes()).toBeGreaterThan(0);
  expect(h.text()).toContain("already has a key (env ANTHROPIC_API_KEY)");
  expect(h.text()).toContain("Done. Tell me what you want done"); // the TUI's closing line, not the CLI's
});

test("/connect runs the one test call through the live registry and reports it", async () => {
  const h = harness({ ANTHROPIC_API_KEY: "sk-env" });
  const probed: string[] = [];
  h.reg.probe = async (id: string, model?: string) => { probed.push(`${id}/${model}`); return { ok: true, model: model ?? "", detail: "ok in 9 ms (5 in / 1 out tokens)" }; };
  await cmdConnect(h.ctx, "anthropic");
  expect(probed).toEqual(["anthropic/claude-opus-5"]);
  expect(h.text()).toContain("ok in 9 ms");
  expect(h.state.model).toBe("claude-opus-5");
});

test("a failed test call still switches the session — the config is what was asked for", async () => {
  const h = harness({ ANTHROPIC_API_KEY: "sk-bad" });
  h.reg.probe = async (_id: string, model?: string) => ({ ok: false, model: model ?? "", detail: "HTTP 401: bad key" });
  await cmdConnect(h.ctx, "anthropic");
  expect(h.text()).toContain("HTTP 401");
  expect(h.text()).toContain("/provider test anthropic");
  expect(userFile().default).toBe("anthropic/claude-opus-5");
  expect(h.state.provider).toBe("anthropic");
});

test("/connect <id> <url> --no-key registers a local server and needs nothing else", async () => {
  const h = harness();
  await cmdConnect(h.ctx, "lab http://127.0.0.1:8000/v1 --no-key --model qwen --no-test");
  expect(h.text()).toContain("lab registered (openai protocol, http://127.0.0.1:8000/v1, no key)");
  expect(userFile().providers!.lab).toMatchObject({ noKey: true });
  expect(h.state).toEqual({ provider: "lab", model: "qwen" });
});

test("--key and --key-stdin are refused here: a key on this line would sit in the transcript", async () => {
  for (const flag of ["--key", "--key-stdin"]) {
    const h = harness();
    await cmdConnect(h.ctx, `openai ${flag}`);
    expect(h.text()).toContain("no hidden prompt in here");
    expect(h.text()).toContain("rovecode auth set openai");
    expect(existsSync(join(home, "providers.json"))).toBe(false);
  }
});

test("a usage error is reported as /connect, not as the CLI spelling", async () => {
  const h = harness();
  await cmdConnect(h.ctx, "openai --nope");
  expect(h.text()).toContain("unknown flag --nope");
  expect(h.text()).toContain("usage: /connect");
  expect(h.text()).not.toContain("rovecode connect [");
});

test("no key: the command parks with the hand-off, then finishes itself when the key lands", async () => {
  const h = harness();
  h.reg.probe = async (id: string, model?: string) => ({ ok: true, model: model ?? "", detail: "ok in 7 ms" });
  await cmdConnect(h.ctx, "openai --model gpt-x");
  expect(h.text()).toContain("I need the key for openai");
  expect(h.text()).toContain("rovecode auth set openai");
  expect(existsSync(join(home, "providers.json"))).toBe(false); // nothing persisted while it waits
  expect(h.state.provider).toBe("none");

  // the key arrives from another terminal; the registry notices on its next read
  saveCredential("openai", "sk-from-elsewhere", "OPENAI_API_KEY");
  h.reg.snapshot();
  await tick();

  expect(userFile().default).toBe("openai/gpt-x");
  expect(h.state).toEqual({ provider: "openai", model: "gpt-x" });
  expect(h.text()).toContain("ok in 7 ms");
  expect(h.text()).not.toContain("sk-from-elsewhere");
});

// ---------- /connect (bare) → the guided flow, simplified ----------

/** the guided flow as the surface sees it: a picker, then question cards */
function guided(env: Record<string, string> = {}, pick: string | null = "1") {
  const reg = new ProviderRegistry(cwd, { env, throttleMs: 0 });
  const notes: string[] = [];
  const asked: string[] = [];
  let slot = { provider: "none", model: "" };
  const state = { provider: "none", model: "" };
  const ctx: ProviderCmdCtx = {
    rt: { providers: reg } as unknown as ProviderCmdCtx["rt"],
    modes: { setModel: (m: { provider: string; model: string }) => { slot = m; }, modelFor: () => slot, separate: false, mode: "act" } as unknown as ModeManager,
    state,
    renderer: {
      addSystemNote: (t: string) => { notes.push(t); },
      pickOne: async () => pick,
      askQuestion: async (q: { question: string }) => { asked.push(q.question); return { text: "some-model" }; },
    } as unknown as Renderer,
    pushStatus: () => {},
  };
  return { ctx, notes, asked, state, reg, text: () => notes.join("\n") };
}

test("a provider that ships a default model is never asked about it — pick, and it is connected", async () => {
  const h = guided({ ANTHROPIC_API_KEY: "sk-env" }); // pick "1" = anthropic, defaultModel claude-opus-5
  h.reg.probe = async (id: string, model?: string) => ({ ok: true, model: model ?? "", detail: "ok in 8 ms" });
  await cmdConnect(h.ctx, "");
  expect(h.asked).toEqual([]); // ONE interaction: the picker. No model card, no key card.
  expect(h.text()).toContain("model → anthropic/claude-opus-5");
  expect(h.text()).toContain("ok in 8 ms");
  expect(userFile().default).toBe("anthropic/claude-opus-5");
  expect(h.state).toEqual({ provider: "anthropic", model: "claude-opus-5" });
});

test("an endpoint with no default model is still asked — there is nothing to assume", async () => {
  const h = guided({ OPENAI_API_KEY: "sk-env" }, "2"); // openai has no defaultModel in the built-in table
  h.reg.probe = async (id: string, model?: string) => ({ ok: true, model: model ?? "", detail: "ok" });
  await cmdConnect(h.ctx, "");
  expect(h.asked).toEqual(["Which model id on openai?"]);
  expect(userFile().default).toBe("openai/some-model");
});

// ---------- /models is a picker, not a wall of ids ----------

/** a surface whose picker records what it was offered and answers with a fixed choice */
function picker(env: Record<string, string> = {}, choose: (items: { value: string; label: string }[]) => string | null = () => null) {
  const reg = new ProviderRegistry(cwd, { env, throttleMs: 0 });
  const notes: string[] = [];
  const offered: { value: string; label: string }[][] = [];
  let slot = { provider: "anthropic", model: "claude-opus-5" };
  const state = { provider: "anthropic", model: "claude-opus-5" };
  const ctx: ProviderCmdCtx = {
    rt: { providers: reg } as unknown as ProviderCmdCtx["rt"],
    modes: { setModel: (m: { provider: string; model: string }) => { slot = m; }, modelFor: () => slot, separate: false, mode: "act" } as unknown as ModeManager,
    state,
    renderer: {
      addSystemNote: (t: string) => { notes.push(t); },
      pickOne: async (items: { value: string; label: string }[]) => { offered.push(items); return choose(items); },
    } as unknown as Renderer,
    pushStatus: () => {},
  };
  return { ctx, notes, offered, state, reg, text: () => notes.join("\n") };
}

test("/models offers every configured provider's ids, marks the current one and puts it first", async () => {
  const h = picker({ ANTHROPIC_API_KEY: "k", GROQ_API_KEY: "k" });
  h.reg.models = async (id: string) => ({ ok: true as const, models: id === "anthropic" ? ["claude-opus-5", "claude-sonnet-5"] : ["llama-3.3"], source: "file" as const });
  await cmdModels(h.ctx, "");
  const items = h.offered[0]!;
  expect(items.map((i) => i.value).sort()).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "groq/llama-3.3"]);
  expect(items[0]!.value).toBe("anthropic/claude-opus-5");   // the one you are on, first
  expect(items[0]!.label).toContain("*");
});

test("/models picking one switches THIS session; Esc changes nothing", async () => {
  const h = picker({ ANTHROPIC_API_KEY: "k" }, (items) => items.find((i) => i.value.endsWith("sonnet-5"))!.value);
  h.reg.models = async () => ({ ok: true as const, models: ["claude-opus-5", "claude-sonnet-5"], source: "file" as const });
  await cmdModels(h.ctx, "");
  expect(h.state).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  expect(existsSync(join(home, "providers.json"))).toBe(false); // no --save: the session only

  const esc = picker({ ANTHROPIC_API_KEY: "k" });               // choose() returns null
  esc.reg.models = async () => ({ ok: true as const, models: ["claude-opus-5", "claude-sonnet-5"], source: "file" as const });
  await cmdModels(esc.ctx, "");
  expect(esc.state).toEqual({ provider: "anthropic", model: "claude-opus-5" });
});

test("/models --save persists the pick as the default", async () => {
  const h = picker({ ANTHROPIC_API_KEY: "k" }, (items) => items.find((i) => i.value.endsWith("sonnet-5"))!.value);
  h.reg.models = async () => ({ ok: true as const, models: ["claude-opus-5", "claude-sonnet-5"], source: "file" as const });
  await cmdModels(h.ctx, "--save");
  expect(JSON.parse(readFileSync(join(home, "providers.json"), "utf8")).default).toBe("anthropic/claude-sonnet-5");
});

test("one broken provider reports itself and the rest of the list still opens", async () => {
  const h = picker({ ANTHROPIC_API_KEY: "k", GROQ_API_KEY: "k" }, (items) => items[0]!.value);
  h.reg.models = async (id: string) => id === "groq"
    ? { ok: false as const, error: "HTTP 500 from the endpoint" }
    : { ok: true as const, models: ["claude-opus-5"], source: "file" as const };
  await cmdModels(h.ctx, "");
  expect(h.text()).toContain("groq: HTTP 500 from the endpoint");
  expect(h.offered[0]!.map((i) => i.value)).toEqual(["anthropic/claude-opus-5"]);
});

test("nothing configured: it says so and never opens an empty picker", async () => {
  const h = picker();
  await cmdModels(h.ctx, "");
  expect(h.offered).toEqual([]);
  expect(h.text()).toContain("no provider is configured yet");
});
