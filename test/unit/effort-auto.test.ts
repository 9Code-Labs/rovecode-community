/** "modelin gercek performansini kullanamiyoruz" — three places the harness was leaving capability on
 *  the table, each pinned so it cannot quietly come back:
 *  1. The default effort was "off", and "off" is sent to Anthropic as an explicit `thinking: disabled`
 *     — the Claude 5 family thinks by itself (adaptive, high) unless told not to, and we told it not to.
 *     "auto" sends nothing and lets the provider's default stand; it is the runtime default now.
 *  2. max_tokens defaulted to a flat 4096 for every model; a long page of UI or a plan was cut off
 *     mid-sentence and the model was blamed. buildDef now takes the catalog's maxOutput, capped.
 *  3. Only GLM received the working agreement; Claude and GPT got "Be concise." The agreement names no
 *     vendor, so every profile-less model gets it. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicMaxTokens, anthropicThinking } from "../../src/providers/stream.ts";
import { GLM_53_PROFILE } from "../../src/providers/profiles.ts";
import { parseEffort, THINKING_EFFORTS } from "../../src/core/types.ts";
import { createRuntime, MAX_OUTPUT_CAP } from "../../src/cli/runtime.ts";

test("auto is a level, parses, and is first in the list the /effort picker shows", () => {
  expect(THINKING_EFFORTS[0]).toBe("auto");
  expect(parseEffort("auto")).toBe("auto");
  expect(parseEffort("AUTO ")).toBe("auto");
});

test("auto sends NO thinking field on either Anthropic shape; off still disables explicitly", () => {
  expect(anthropicThinking("auto", "effort")).toEqual({});
  expect(anthropicThinking("auto", "budget")).toEqual({});
  expect(anthropicThinking(undefined, "effort")).toEqual({});
  expect(anthropicThinking("off", "effort")).toEqual({ thinking: { type: "disabled" } });
  expect(anthropicThinking("high", "effort")).toEqual({ output_config: { effort: "high" } });
});

test("the GLM profile maps auto to 'send nothing' like off — the endpoint keeps its own default", () => {
  expect(GLM_53_PROFILE.reasoningEffort("auto")).toBeNull();
  expect(GLM_53_PROFILE.reasoningEffort("off")).toBeNull();
  expect(GLM_53_PROFILE.reasoningEffort("high")).toBe("max");
});

test("the runtime's default dial is auto unless ROVECODE_EFFORT says otherwise", () => {
  const prev = process.env.ROVECODE_EFFORT;
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-effort-"));
  try {
    delete process.env.ROVECODE_EFFORT;
    expect(createRuntime({ cwd, stream: null }).effort).toBe("auto");
    process.env.ROVECODE_EFFORT = "low";
    expect(createRuntime({ cwd, stream: null }).effort).toBe("low");
    process.env.ROVECODE_EFFORT = "typo";
    expect(createRuntime({ cwd, stream: null }).effort).toBe("auto"); // a typo keeps the default, never reads as off
  } finally {
    if (prev === undefined) delete process.env.ROVECODE_EFFORT; else process.env.ROVECODE_EFFORT = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildDef gives a catalogued model the catalog's output room (capped), and leaves an explicit maxTokens alone", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-maxtok-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const known = rt.buildDef({ provider: "anthropic", model: "claude-sonnet-4-5" }).model!;
    // models.dev knows this model's maxOutput; whatever it is, it lands, bounded by the cap
    expect(known.maxTokens).toBeDefined();
    expect(known.maxTokens!).toBeGreaterThan(4096);
    expect(known.maxTokens!).toBeLessThanOrEqual(MAX_OUTPUT_CAP);
    expect(rt.buildDef({ provider: "anthropic", model: "claude-sonnet-4-5", maxTokens: 1234 }).model!.maxTokens).toBe(1234);
    // an unknown model gets no maxTokens from buildDef, and the wire falls back to the 8192 floor
    const unknown = rt.buildDef({ provider: "p", model: "m-1" }).model!;
    expect(unknown.maxTokens).toBeUndefined();
    expect(anthropicMaxTokens(unknown)).toBe(8192);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a thinking budget still adds room on top of the model's max_tokens", () => {
  expect(anthropicMaxTokens({ provider: "anthropic", model: "x", maxTokens: 8192, effort: "high" })).toBeGreaterThan(8192);
});
