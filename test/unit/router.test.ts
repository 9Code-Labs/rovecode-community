/** Port #14 tests: role resolution precedence, chain advance on scripted 429/5xx,
 *  no-fallback-on-success, exhausted chain → error stopReason (never throws). */

import { test, expect } from "bun:test";
import {
  MODEL_ROLES,
  classifyStreamError,
  createRouter,
  parseModelChain,
  parseModelRef,
  roleTableFromEnv,
  servedBy,
  type RouterNote,
} from "../../src/providers/router.ts";
import { textTurn } from "../../src/providers/stream.ts";
import type { AssistantTurn, Message, ModelRef, StreamEvent, StreamFn } from "../../src/core/types.ts";

const messages: Message[] = [];

const ref = (provider: string, model: string): ModelRef => ({ provider, model });
const err = (msg: string): AssistantTurn => ({ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: msg });

/** Scripted seam: per-model turn queues (last turn repeats), records call order. */
function scripted(script: Record<string, AssistantTurn[]>, calls: string[]): StreamFn {
  const cursor = new Map<string, number>();
  return async function* (model): AsyncGenerator<StreamEvent> {
    const key = `${model.provider}/${model.model}`;
    calls.push(key);
    const turns = script[key] ?? [err(`HTTP 404: no script for ${key}`)];
    const i = cursor.get(key) ?? 0;
    cursor.set(key, i + 1);
    yield { type: "turn", turn: turns[Math.min(i, turns.length - 1)]! };
  };
}

async function run(
  fn: StreamFn,
  model: ModelRef,
  options?: Parameters<StreamFn>[2],
): Promise<{ events: StreamEvent[]; turn: AssistantTurn }> {
  const events: StreamEvent[] = [];
  let turn: AssistantTurn | null = null;
  for await (const ev of fn(model, messages, options)) {
    events.push(ev);
    if (ev.type === "turn") turn = ev.turn;
  }
  expect(turn).not.toBeNull(); // wrapper always yields a terminal turn, never throws
  return { events, turn: turn! };
}

// ---------- role resolution precedence ----------

const table = {
  default: [ref("kaesra", "zai-org/glm-5.3-flash"), ref("openai", "gpt-4o-mini")],
  plan: ref("anthropic", "claude-sonnet"),
} as const;

test("configured role wins over default", () => {
  const r = createRouter({ roles: table });
  expect(r.resolve("plan")).toEqual(ref("anthropic", "claude-sonnet"));
});

test("unconfigured role falls back to the default chain head", () => {
  const r = createRouter({ roles: table });
  expect(r.resolve("commit")).toEqual(ref("kaesra", "zai-org/glm-5.3-flash"));
  expect(r.resolve("smol")).toEqual(r.resolve("default"));
});

test("unknown role name falls back to default", () => {
  const r = createRouter({ roles: table });
  expect(r.resolve("no-such-role")).toEqual(ref("kaesra", "zai-org/glm-5.3-flash"));
  expect(r.chain("no-such-role")).toEqual(r.chain("default"));
});

test("explicit request selector wins over the role table", () => {
  const r = createRouter({ roles: table });
  expect(r.resolve("plan", "groq/llama-3.3")).toEqual(ref("groq", "llama-3.3"));
  expect(r.resolve("plan", ref("xai", "grok-4"))).toEqual(ref("xai", "grok-4"));
  // bare selector (no slash) inherits the role chain head's provider
  expect(r.resolve("default", "gpt-4o")).toEqual(ref("kaesra", "gpt-4o"));
});

test("chain() returns the full ordered chain; single ModelRef normalizes to a chain", () => {
  const r = createRouter({ roles: table });
  expect(r.chain("default")).toEqual([ref("kaesra", "zai-org/glm-5.3-flash"), ref("openai", "gpt-4o-mini")]);
  expect(r.chain("plan")).toEqual([ref("anthropic", "claude-sonnet")]);
});

test("selector parsing: first-slash split keeps model-id slashes; comma lists become chains", () => {
  expect(parseModelRef("kaesra/zai-org/glm-5.3-flash", "x")).toEqual(ref("kaesra", "zai-org/glm-5.3-flash"));
  expect(parseModelRef("gpt-4o-mini", "openai")).toEqual(ref("openai", "gpt-4o-mini"));
  expect(parseModelChain(" a/m1 , b/m2 ,, ", "x")).toEqual([ref("a", "m1"), ref("b", "m2")]);
});

test("roleTableFromEnv: env chains parsed per role, default falls back to the provided ref", () => {
  const fallback = ref("kaesra", "zai-org/glm-5.3-flash");
  const roles = roleTableFromEnv(fallback, {
    ROVECODE_MODEL_SMOL: "kaesra/zai-org/glm-5.3-flash, openai/gpt-4o-mini",
    ROVECODE_MODEL_PLAN: "anthropic/claude-sonnet",
  });
  expect(roles.default).toEqual([fallback]);
  expect(roles.smol).toEqual([ref("kaesra", "zai-org/glm-5.3-flash"), ref("openai", "gpt-4o-mini")]);
  expect(roles.plan).toEqual([ref("anthropic", "claude-sonnet")]);
  expect(roles.commit).toBeUndefined();
  const r = createRouter({ roles });
  expect(r.resolve("smol")).toEqual(fallback);
  expect(MODEL_ROLES).toContain("task");
});

// ---------- failure classification (seam error text: "HTTP <status>: ...") ----------

test("classifyStreamError: 429 and 5xx retryable, other 4xx not, transport errors retryable", () => {
  expect(classifyStreamError("HTTP 429: rate limited")).toEqual({ status: 429, retryable: true });
  expect(classifyStreamError("HTTP 503: overloaded")).toEqual({ status: 503, retryable: true });
  expect(classifyStreamError("HTTP 400: bad request")).toEqual({ status: 400, retryable: false });
  expect(classifyStreamError("HTTP 404: not found")).toEqual({ status: 404, retryable: false });
  expect(classifyStreamError("fetch failed")).toEqual({ retryable: true });
  expect(classifyStreamError(undefined)).toEqual({ retryable: true });
});

// ---------- fallback wrapper ----------

const twoChain = { default: [ref("p", "primary"), ref("s", "secondary")] };

test("chain advances on scripted 429 with a note; final turn comes from the fallback model", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: twoChain, onNote: (n) => notes.push(n) });
  const wrapped = r.wrap(scripted({ "p/primary": [err("HTTP 429: rate limited")], "s/secondary": [textTurn("ok")] }, calls));
  const { turn } = await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/primary", "s/secondary"]);
  expect(turn.stopReason).toBe("end_turn");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ chain: "default", from: ref("p", "primary"), to: ref("s", "secondary") });
  expect(notes[0]!.reason).toContain("429");
});

test("chain advances on 5xx too", async () => {
  const calls: string[] = [];
  const r = createRouter({ roles: twoChain });
  const wrapped = r.wrap(scripted({ "p/primary": [err("HTTP 503: overloaded")], "s/secondary": [textTurn("ok")] }, calls));
  const { turn } = await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/primary", "s/secondary"]);
  expect(turn.stopReason).toBe("end_turn");
});

test("no fallback on success: single call, no notes", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: twoChain, onNote: (n) => notes.push(n) });
  const wrapped = r.wrap(scripted({ "p/primary": [textTurn("first try")] }, calls));
  const { turn } = await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/primary"]);
  expect(turn.stopReason).toBe("end_turn");
  expect(notes).toHaveLength(0);
});

test("non-retryable 400 does NOT advance (gemini-cli retry.ts:193-194)", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: twoChain, onNote: (n) => notes.push(n) });
  const wrapped = r.wrap(scripted({ "p/primary": [err("HTTP 400: bad request")] }, calls));
  const { turn } = await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/primary"]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("400");
  expect(notes).toHaveLength(0);
});

test("aborted signal never advances the chain (retry.ts:337-339)", async () => {
  const calls: string[] = [];
  const r = createRouter({ roles: twoChain });
  const wrapped = r.wrap(scripted({ "p/primary": [err("The operation was aborted.")] }, calls));
  const ac = new AbortController();
  ac.abort();
  const { turn } = await run(wrapped, r.resolve("default"), { signal: ac.signal });
  expect(calls).toEqual(["p/primary"]);
  expect(turn.stopReason).toBe("error");
});

test("exhausted chain yields error stopReason (never throws), notes each hop, last note to=null", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: twoChain, onNote: (n) => notes.push(n) });
  const wrapped = r.wrap(
    scripted({ "p/primary": [err("HTTP 429: rate limited")], "s/secondary": [err("HTTP 500: boom")] }, calls),
  );
  const { turn } = await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/primary", "s/secondary"]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("exhausted");
  expect(turn.error).toContain("HTTP 500: boom");
  expect(notes).toHaveLength(2);
  expect(notes[1]!.to).toBeNull();
});

test("sticky (default): later calls start at the survivor; exhaustion resets to the head", async () => {
  const calls: string[] = [];
  const r = createRouter({ roles: twoChain });
  const wrapped = r.wrap(
    scripted(
      { "p/primary": [err("HTTP 429: rate limited"), textTurn("primary recovered")], "s/secondary": [textTurn("ok"), err("HTTP 429: also limited")] },
      calls,
    ),
  );
  const head = createRouter({ roles: twoChain }).resolve("default");
  const first = await run(wrapped, head);
  expect(first.turn.stopReason).toBe("end_turn"); // failover p → s
  const second = await run(wrapped, head); // sticky: starts at s, which now 429s → exhausted
  expect(second.turn.stopReason).toBe("error");
  const third = await run(wrapped, head); // reset: back to p, which has recovered
  expect(third.turn.stopReason).toBe("end_turn");
  expect(calls).toEqual(["p/primary", "s/secondary", "s/secondary", "p/primary"]);
});

test("sticky: false restarts every call at the requested model", async () => {
  const calls: string[] = [];
  const r = createRouter({ roles: twoChain, sticky: false });
  const wrapped = r.wrap(scripted({ "p/primary": [err("HTTP 429: rate limited")], "s/secondary": [textTurn("ok")] }, calls));
  await run(wrapped, r.resolve("default"));
  await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/primary", "s/secondary", "p/primary", "s/secondary"]);
});

test("model outside every chain (no looseFallback) is a singleton: provider error untouched, no note", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: twoChain, onNote: (n) => notes.push(n) });
  const loose = ref("x", "y");
  const wrapped = r.wrap(scripted({ "x/y": [err("HTTP 429: rate limited")] }, calls));
  const { turn } = await run(wrapped, loose);
  expect(calls).toEqual(["x/y"]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("HTTP 429: rate limited"); // LOW/MED-4: no exhausted-rewrite
  expect(notes).toHaveLength(0);
});

test("looseFallback: a model outside every chain gets the default chain as its fallback pool", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: twoChain, looseFallback: true, onNote: (n) => notes.push(n) });
  const loose = ref("x", "y");
  const wrapped = r.wrap(scripted({ "x/y": [err("HTTP 429: rate limited")], "p/primary": [textTurn("ok")] }, calls));
  const { turn } = await run(wrapped, loose);
  expect(calls).toEqual(["x/y", "p/primary"]); // requested model stays the primary (MED-3)
  expect(turn.stopReason).toBe("end_turn");
  expect(notes).toEqual([{ chain: "x/y", from: loose, to: ref("p", "primary"), reason: "HTTP 429: rate limited" }]);
});

test("single-candidate chain: retryable failure surfaces the provider error verbatim (LOW/MED-4)", async () => {
  const calls: string[] = [];
  const notes: RouterNote[] = [];
  const r = createRouter({ roles: { default: ref("p", "only") }, onNote: (n) => notes.push(n) });
  const wrapped = r.wrap(scripted({ "p/only": [err("HTTP 429: rate limited")] }, calls));
  const { turn } = await run(wrapped, r.resolve("default"));
  expect(calls).toEqual(["p/only"]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("HTTP 429: rate limited");
  expect(turn.error).not.toContain("exhausted");
  expect(notes).toHaveLength(0); // no misleading advance note either
});

test("servedBy tags the candidate that produced each terminal turn (HIGH-2)", async () => {
  const r = createRouter({ roles: twoChain });
  // fallback: the surviving turn is tagged with the SERVING candidate, not the requested one
  const fell = await run(
    r.wrap(scripted({ "p/primary": [err("HTTP 429: rate limited")], "s/secondary": [textTurn("ok")] }, [])),
    r.resolve("default"),
  );
  expect(servedBy(fell.turn)).toEqual(ref("s", "secondary"));
  // no fallback: tagged with the primary
  const direct = await run(r.wrap(scripted({ "p/primary": [textTurn("ok")] }, [])), r.resolve("default"));
  expect(servedBy(direct.turn)).toEqual(ref("p", "primary"));
  // exhausted: tagged with the last candidate attempted
  const dead = await run(
    r.wrap(scripted({ "p/primary": [err("HTTP 429: a")], "s/secondary": [err("HTTP 500: b")] }, [])),
    r.resolve("default"),
  );
  expect(dead.turn.error).toContain("exhausted");
  expect(servedBy(dead.turn)).toEqual(ref("s", "secondary"));
  // an unwrapped stream's turn carries no tag
  expect(servedBy(textTurn("plain"))).toBeUndefined();
});

test("text_delta events pass through live before the terminal turn", async () => {
  const r = createRouter({ roles: twoChain });
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "hel" };
    yield { type: "text_delta", text: "lo" };
    yield { type: "turn", turn: textTurn("hello") };
  };
  const { events, turn } = await run(r.wrap(stream), r.resolve("default"));
  expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2);
  expect(turn.stopReason).toBe("end_turn");
});

test("a throwing wrapped stream is folded into the never-throw seam and can still fail over", async () => {
  const calls: string[] = [];
  const r = createRouter({ roles: twoChain });
  const inner = scripted({ "s/secondary": [textTurn("ok")] }, calls);
  const stream: StreamFn = (model, msgs, options) => {
    if (model.provider === "p") {
      calls.push("p/primary");
      // eslint-disable-next-line require-yield
      return (async function* (): AsyncGenerator<StreamEvent> {
        throw new Error("socket hang up");
      })();
    }
    return inner(model, msgs, options);
  };
  const { turn } = await run(r.wrap(stream), r.resolve("default"));
  expect(calls).toEqual(["p/primary", "s/secondary"]);
  expect(turn.stopReason).toBe("end_turn"); // transport throw → retryable → advanced
});
