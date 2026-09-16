/** context-report: the breakdown, and the drift between our estimate and the provider's own count. */
import { describe, expect, it } from "bun:test";
import { contextReport, drift, DRIFT_TOLERANCE } from "../../src/core/context-report.ts";
import { renderContext } from "../../src/cli/context-cmd.ts";
import type { Message, TokenUsage } from "../../src/core/types.ts";

const CURRENT = { provider: "anthropic", model: "claude-sonnet-5" };
const PRICED = { contextWindow: 1_000_000, pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 } };

let seq = 0;
function msg(role: Message["role"], parts: Message["parts"], usage?: TokenUsage, origin?: { provider: string; model: string }): Message {
  seq += 1;
  return { id: `m${seq}`, role, parts, parentId: null, createdAt: seq, ...(usage ? { usage } : {}), ...(origin ? { origin } : {}) };
}
const text = (t: string) => [{ kind: "text" as const, text: t }];

describe("contextReport", () => {
  it("splits the window by what a reader thinks in, not by wire role", () => {
    const messages = [
      msg("user", text("please fix the failing test")),
      msg("assistant", [
        { kind: "text", text: "looking at the auth flow" },
        { kind: "tool_call", id: "c1", tool: "read", args: { path: "src/auth.ts" } },
      ]),
      msg("user", [{ kind: "tool_result", callId: "c1", ok: true, output: "export function auth() {}" }]),
    ];
    const r = contextReport({ messages, current: CURRENT, lookup: () => PRICED, system: "you are rovecode", toolSchemas: '{"read":{}}' });

    expect(r.slices.map((s) => s.label)).toEqual([
      "system prompt", "tool schemas", "your messages", "assistant replies", "tool calls", "tool results",
    ]);
    expect(r.estimated).toBe(r.slices.reduce((n, s) => n + s.tokens, 0));
    expect(r.slices.every((s) => s.tokens > 0)).toBe(true);
    // shares are of the estimate and sum to 1
    expect(r.slices.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1, 6);
  });

  it("reports the window, what is left, and never a negative remainder", () => {
    const big = "word ".repeat(4000);
    const r = contextReport({ messages: [msg("user", text(big))], current: CURRENT, lookup: () => ({ contextWindow: 100 }) });
    expect(r.window).toBe(100);
    expect(r.remaining).toBe(0);
    expect(r.fraction!).toBeGreaterThan(1);
    expect(r.nearLimit).toBe(true);
  });

  it("says the window is unknown rather than inventing one", () => {
    const r = contextReport({ messages: [msg("user", text("hi"))], current: CURRENT, lookup: () => undefined });
    expect(r.window).toBeUndefined();
    expect(r.remaining).toBeUndefined();
    expect(r.fraction).toBeUndefined();
    expect(r.costUsd).toBeUndefined();
    expect(renderContext(r, "s1").join("\n")).toContain("not in the catalog");
  });

  it("prices each turn at the model that produced it and counts what it could not price", () => {
    const messages = [
      msg("assistant", text("a"), { input: 1_000_000, output: 0 }, CURRENT),
      msg("assistant", text("b"), { input: 1_000_000, output: 0 }, { provider: "who", model: "what" }),
    ];
    const r = contextReport({ messages, current: CURRENT, lookup: (ref) => (ref.provider === "anthropic" ? PRICED : undefined) });
    expect(r.costUsd).toBeCloseTo(2, 6); // 1M input at $2/MTok, the unknown model excluded
    expect(r.unpricedTurns).toBe(1);
    expect(r.totals.input).toBe(2_000_000);
  });

  it("counts cache traffic in the totals — an agentic prompt is mostly cache reads", () => {
    const r = contextReport({
      messages: [msg("assistant", text("x"), { input: 10, output: 5, cacheRead: 90_000, cacheWrite: 1_000 })],
      current: CURRENT,
      lookup: () => PRICED,
    });
    expect(r.totals.cacheRead).toBe(90_000);
    expect(r.totals.cacheWrite).toBe(1_000);
    // 10 in + 5 out + 90k read + 1k write, at 2 / 10 / 0.2 / 2.5 per MTok
    expect(r.costUsd).toBeCloseTo((10 * 2 + 5 * 10 + 90_000 * 0.2 + 1_000 * 2.5) / 1e6, 9);
  });

  it("names images instead of pretending they are free", () => {
    const r = contextReport({
      messages: [msg("user", [{ kind: "image", mediaType: "image/png", data: "iVBOR" } as never])],
      current: CURRENT,
      lookup: () => PRICED,
    });
    expect(r.images).toBe(1);
    expect(renderContext(r, "s1").join("\n")).toContain("image tokens are provider-specific");
  });
});

describe("drift", () => {
  it("compares the provider's prompt count against our estimate of the same point", () => {
    const messages = [
      msg("user", text("hello there, this is the prompt")),
      msg("assistant", text("hi"), { input: 8, output: 1 }),
    ];
    const d = drift(messages)!;
    expect(d.reported).toBe(8);
    expect(d.estimated).toBeGreaterThan(0);
    expect(d.delta).toBe(d.reported - d.estimated);
    expect(d.fraction).toBeCloseTo(Math.abs(d.delta) / d.reported, 9);
  });

  it("counts cache reads and writes as part of the prompt the model saw", () => {
    const messages = [msg("user", text("x")), msg("assistant", text("y"), { input: 10, output: 1, cacheRead: 5_000, cacheWrite: 100 })];
    expect(drift(messages)!.reported).toBe(5_110);
  });

  it("flags a disagreement past the tolerance and stays quiet inside it", () => {
    const prompt = "token ".repeat(100);
    const near = contextReport({
      messages: [msg("user", text(prompt)), msg("assistant", text("ok"), { input: 100, output: 1 })],
      current: CURRENT,
      lookup: () => PRICED,
    });
    // o200k counts "token " as one token, so 100 words ≈ 100 tokens: inside tolerance
    expect(near.drift!.fraction).toBeLessThanOrEqual(DRIFT_TOLERANCE);
    expect(near.drift!.beyondTolerance).toBe(false);

    const far = contextReport({
      messages: [msg("user", text(prompt)), msg("assistant", text("ok"), { input: 400, output: 1 })],
      current: CURRENT,
      lookup: () => PRICED,
    });
    expect(far.drift!.beyondTolerance).toBe(true);
    expect(far.drift!.delta).toBeGreaterThan(0);
    expect(renderContext(far, "s1").join("\n")).toContain("reads low");
  });

  it("is absent when nothing reported a prompt, and skips turns that reported none", () => {
    expect(drift([])).toBeUndefined();
    expect(drift([msg("user", text("a")), msg("assistant", text("b"))])).toBeUndefined();
    expect(drift([msg("assistant", text("b"), { input: 0, output: 5 })])).toBeUndefined();
    const mixed = [msg("user", text("a")), msg("assistant", text("b"), { input: 7, output: 1 }), msg("assistant", text("c"), { input: 0, output: 3 })];
    expect(drift(mixed)!.reported).toBe(7);
  });
});

describe("renderContext", () => {
  it("prints the bar, the slices and an honest cost line", () => {
    const r = contextReport({
      messages: [msg("user", text("hello")), msg("assistant", text("hi"), { input: 5, output: 2 })],
      current: CURRENT,
      lookup: () => PRICED,
    });
    const out = renderContext(r, "abc123").join("\n");
    expect(out).toContain("session abc123 · anthropic/claude-sonnet-5");
    expect(out).toContain("your messages");
    expect(out).toContain("billed");
    expect(out).toMatch(/cost {5}\$0\.\d{4}/);
  });

  it("says so when no turn has reported usage", () => {
    const r = contextReport({ messages: [msg("user", text("hello"))], current: CURRENT, lookup: () => PRICED });
    expect(renderContext(r, "s").join("\n")).toContain("no turn reported usage yet");
  });
});

describe("rovecode context", () => {
  it("reads the newest session, refuses an unknown id, and prints JSON on demand", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SessionStore } = await import("../../src/core/session.ts");
    const { cmdContext } = await import("../../src/cli/context-cmd.ts");

    const cwd = mkdtempSync(join(tmpdir(), "rovecode-ctx-"));
    const store = new SessionStore(join(cwd, ".rovecode", "sessions"), "older");
    store.append(msg("user", text("first session")));
    const newer = new SessionStore(join(cwd, ".rovecode", "sessions"), "newer");
    newer.append(msg("user", text("count these tokens please")));
    newer.append(msg("assistant", text("done"), { input: 40, output: 2, cacheRead: 1000 }));

    const lines: string[] = [];
    const errs: string[] = [];
    const deps = { cwd, currentRef: () => CURRENT, log: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };

    expect(await cmdContext([], deps)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("session newer"); // the newest, not "older"
    expect(out).toContain("drift");
    expect(out).toContain("1,040"); // the provider's prompt: 40 input + 1000 cache read

    lines.length = 0;
    expect(await cmdContext(["--json"], deps)).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.session).toBeString();
    expect(parsed.drift.reported).toBe(1040);
    expect(parsed.slices.length).toBeGreaterThan(0);

    lines.length = 0;
    expect(await cmdContext(["nope"], deps)).toBe(1);
    expect(errs.join("\n")).toContain("no session nope here");
  });

  it("says there is nothing to report rather than failing on an empty directory", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { cmdContext } = await import("../../src/cli/context-cmd.ts");
    const errs: string[] = [];
    const code = await cmdContext([], { cwd: mkdtempSync(join(tmpdir(), "rovecode-ctx-empty-")), currentRef: () => CURRENT, log: () => {}, err: (l) => errs.push(l) });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("no sessions here");
  });
});

describe("contextBudgetFor", () => {
  it("follows the window instead of spending a fifth of it", async () => {
    const { contextBudgetFor, DEFAULT_CONTEXT_BUDGET, MIN_CONTEXT_BUDGET } = await import("../../src/core/context-report.ts");
    // 1M window, 128k answer: the history may use what is left, not a flat 200k
    expect(contextBudgetFor({ window: 1_000_000, maxOutput: 128_000 })).toBe(1_000_000 - 128_000 - 24_000);
    // 200k window, 64k answer: smaller than the old flat default, which used to overflow it
    expect(contextBudgetFor({ window: 200_000, maxOutput: 64_000 })).toBe(112_000);
    expect(contextBudgetFor({ window: 200_000, maxOutput: 64_000 })).toBeLessThan(DEFAULT_CONTEXT_BUDGET);
    // unknown window keeps the old behaviour rather than guessing
    expect(contextBudgetFor({})).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(contextBudgetFor({ window: 0 })).toBe(DEFAULT_CONTEXT_BUDGET);
    // a window too small for the floor gets a share of itself, never more than it holds
    const tiny = contextBudgetFor({ window: 32_000, maxOutput: 8_000 });
    expect(tiny).toBeLessThan(32_000);
    expect(tiny).toBeGreaterThan(0);
    expect(contextBudgetFor({ window: 60_000 })).toBeLessThanOrEqual(60_000);
    // an explicit override wins over everything
    expect(contextBudgetFor({ window: 1_000_000, maxOutput: 128_000, override: 50_000 })).toBe(50_000);
    expect(contextBudgetFor({ window: 1_000_000, override: 0 })).toBeGreaterThan(MIN_CONTEXT_BUDGET);
  });
});

describe("the cost line tells three silences apart", () => {
  it("says nothing was billed, rather than blaming the catalog", () => {
    const r = contextReport({ messages: [msg("user", text("hello"))], current: CURRENT, lookup: () => PRICED });
    const out = renderContext(r, "s").join("\n");
    expect(out).toContain("nothing has been billed in this session yet");
    expect(out).not.toContain("no pricing for");
  });

  it("blames the catalog only when tokens were actually billed at an unpriced model", () => {
    const r = contextReport({
      messages: [msg("assistant", text("x"), { input: 100, output: 10 })],
      current: CURRENT,
      lookup: () => ({ contextWindow: 1000 }), // window known, pricing absent
    });
    expect(renderContext(r, "s").join("\n")).toContain("no pricing for anthropic/claude-sonnet-5");
  });
});
