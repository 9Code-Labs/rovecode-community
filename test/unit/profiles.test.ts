/** Model profiles (providers/profiles.ts): which model ids get the GLM-5.3 profile, how rovecode's one
 *  effort dial maps onto GLM's three words, the request fields the endpoint wants, the two resolvers
 *  (ROVECODE_PROFILE forces the PROMPT section only; the wire follows the model id), the persona-free
 *  `glm-5.3-plain` variant, the .rovecode/profiles/<id>.md override that replaces the prompt section, and
 *  the two prompt texts themselves (the Sonnet 5 persona and the harness working agreement). */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLM_53_AGENT_CONTRACT, GLM_53_MODEL_RE, GLM_53_PLAIN_PROFILE, GLM_53_PROFILE, PROFILES, SONNET_5_PERSONA, SONNET_5_VOICE, profileFor, profileHint, profileOverridePaths, profilePromptSection, profileWire, wireProfileFor } from "../../src/providers/profiles.ts";
import type { ModelRef } from "../../src/core/types.ts";

const GLM: ModelRef = { provider: "kaesra", model: "zai-org/glm-5.3-flash" };
const CLAUDE: ModelRef = { provider: "anthropic", model: "claude-opus-5" };
const GPT: ModelRef = { provider: "openai", model: "gpt-5" };

test("GLM_53_MODEL_RE accepts the family under any vendor prefix, date suffix or :variant/:tag suffix, and nothing else", () => {
  const yes = ["glm-5.3", "glm-5.3-flash", "zai-org/glm-5.3-flash", "z-ai/glm-5.3", "z-ai/glm-5.3-20260816", "GLM-5.3-Flash", "zai:glm-5.3", "z-ai/glm-5.3:free", "glm-5.3:latest", "glm-5.3-flash:q4"];
  const no = ["glm-5.2", "glm-5.32", "glm-5", "glm-5-turbo", "glm-5.3x", "glm-5.30", "claude-sonnet-5", "gpt-5", "xglm-5.3", "zai-org/glm-5.2-flash", "glm-5.3.1"];
  for (const id of yes) expect(GLM_53_MODEL_RE.test(id)).toBe(true);
  for (const id of no) expect(GLM_53_MODEL_RE.test(id)).toBe(false);
});

test("profileFor / wireProfileFor: by model id when ROVECODE_PROFILE is unset — the provider is not consulted; the plain variant matches nothing by itself", () => {
  expect(profileFor(GLM, {})?.id).toBe("glm-5.3");
  expect(wireProfileFor(GLM, {})?.id).toBe("glm-5.3");
  expect(profileFor({ provider: "openrouter", model: "z-ai/glm-5.3:free" }, {})?.id).toBe("glm-5.3");
  expect(profileFor({ provider: "zai", model: "glm-5.3" }, {})?.id).toBe("glm-5.3");
  expect(profileFor(CLAUDE, {})).toBeNull();
  expect(wireProfileFor(CLAUDE, {})).toBeNull();
  expect(profileFor({ provider: "kaesra", model: "zai-org/glm-5.2" }, {})).toBeNull();
  expect(PROFILES.map((p) => p.id)).toEqual(["glm-5.3", "glm-5.3-plain"]);
  expect(GLM_53_PLAIN_PROFILE.matches(GLM)).toBe(false);
});

test("ROVECODE_PROFILE: off-words drop every profile on both resolvers; an id forces the PROMPT profile onto any model but never the wire; glm-5.3-plain is the opt-in persona-free variant; an unknown id means none plus a hint", () => {
  for (const off of ["off", "OFF", "0", "false", "none", "no", " off "]) {
    expect(profileFor(GLM, { ROVECODE_PROFILE: off })).toBeNull();
    expect(wireProfileFor(GLM, { ROVECODE_PROFILE: off })).toBeNull();
  }
  expect(profileFor(CLAUDE, { ROVECODE_PROFILE: "glm-5.3" })?.id).toBe("glm-5.3");
  expect(profileFor(GPT, { ROVECODE_PROFILE: "GLM-5.3" })?.id).toBe("glm-5.3");
  expect(wireProfileFor(GPT, { ROVECODE_PROFILE: "glm-5.3" })).toBeNull(); // gpt-5 must not receive GLM fields
  expect(wireProfileFor(GLM, { ROVECODE_PROFILE: "glm-5.3" })?.id).toBe("glm-5.3"); // the real GLM still does
  // the plain variant: agreement only for the prompt, the GLM wire still by model id
  expect(profileFor(GLM, { ROVECODE_PROFILE: "glm-5.3-plain" })?.id).toBe("glm-5.3-plain");
  expect(profileFor(GLM, { ROVECODE_PROFILE: "glm-5.3-plain" })?.promptSection).toBe(GLM_53_AGENT_CONTRACT);
  expect(wireProfileFor(GLM, { ROVECODE_PROFILE: "glm-5.3-plain" })?.id).toBe("glm-5.3");
  expect(profileWire(GLM, true, { ROVECODE_PROFILE: "glm-5.3-plain" }).tool_stream).toBe(true);
  expect(profileFor(GLM, { ROVECODE_PROFILE: "sonnet" })).toBeNull(); // a typo is "no profile", never a different one
  expect(wireProfileFor(GLM, { ROVECODE_PROFILE: "sonnet" })?.id).toBe("glm-5.3"); // …but the wire still follows the model id
  expect(profileHint({ ROVECODE_PROFILE: "sonnet" })).toContain("names no profile");
  expect(profileHint({ ROVECODE_PROFILE: "sonnet" })).toContain("glm-5.3, glm-5.3-plain");
  expect(profileHint({ ROVECODE_PROFILE: "glm-5.3-plain" })).toBeNull();
  expect(profileHint({ ROVECODE_PROFILE: "off" })).toBeNull();
  expect(profileHint({})).toBeNull();
  expect(profileHint({ ROVECODE_PROFILE: "" })).toBeNull();
});

test("GLM effort words: off/unset send nothing (endpoint default max), low stays low, medium rounds UP to high, high means max — identical on both GLM profiles", () => {
  for (const p of [GLM_53_PROFILE, GLM_53_PLAIN_PROFILE]) {
    expect(p.reasoningEffort(undefined)).toBeNull();
    expect(p.reasoningEffort("off")).toBeNull();
    expect(p.reasoningEffort("low")).toBe("low");
    expect(p.reasoningEffort("medium")).toBe("high");
    expect(p.reasoningEffort("high")).toBe("max");
  }
});

test("GLM wire fields: thinking enabled with clear_thinking false, Z.ai's temperature/top_p, tool_stream only when streaming; nothing for other models, nothing when off, nothing for a FORCED non-GLM model", () => {
  expect(profileWire(GLM, true, {})).toEqual({ thinking: { type: "enabled", clear_thinking: false }, temperature: 1, top_p: 0.95, tool_stream: true });
  expect(profileWire(GLM, false, {})).toEqual({ thinking: { type: "enabled", clear_thinking: false }, temperature: 1, top_p: 0.95 });
  expect(GLM_53_PLAIN_PROFILE.wire({ streaming: true })).toEqual(GLM_53_PROFILE.wire({ streaming: true }));
  expect(profileWire(CLAUDE, true, {})).toEqual({});
  expect(profileWire(GLM, true, { ROVECODE_PROFILE: "off" })).toEqual({});
  expect(profileWire(GPT, true, { ROVECODE_PROFILE: "glm-5.3" })).toEqual({});
  expect(profileWire(GLM, true, { ROVECODE_PROFILE: "glm-5.3" }).tool_stream).toBe(true);
});

test("profilePromptSection: project override beats user override beats the built-in; an empty file disables the section", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-prof-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-prof-home-"));
  try {
    expect(profileOverridePaths(GLM_53_PROFILE, cwd, home)).toEqual([join(cwd, ".rovecode", "profiles", "glm-5.3.md"), join(home, "profiles", "glm-5.3.md")]);
    expect(profilePromptSection(GLM_53_PROFILE, cwd, home)).toBe(GLM_53_PROFILE.promptSection);
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "glm-5.3.md"), "# User rules\nfrom home\n");
    expect(profilePromptSection(GLM_53_PROFILE, cwd, home)).toBe("# User rules\nfrom home");
    mkdirSync(join(cwd, ".rovecode", "profiles"), { recursive: true });
    writeFileSync(join(cwd, ".rovecode", "profiles", "glm-5.3.md"), "\n# Project rules\nfrom the repo\n\n");
    expect(profilePromptSection(GLM_53_PROFILE, cwd, home)).toBe("# Project rules\nfrom the repo");
    writeFileSync(join(cwd, ".rovecode", "profiles", "glm-5.3.md"), "   \n");
    expect(profilePromptSection(GLM_53_PROFILE, cwd, home)).toBe("");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the GLM profile's section is persona, then voice examples, then the working agreement, blank-line separated; the plain variant is the agreement alone", () => {
  expect(GLM_53_PROFILE.promptSection).toBe(`${SONNET_5_PERSONA}\n\n${SONNET_5_VOICE}\n\n${GLM_53_AGENT_CONTRACT}`);
  expect(GLM_53_PROFILE.promptSection.startsWith("# ")).toBe(true);
  expect(GLM_53_PLAIN_PROFILE.promptSection).toBe(GLM_53_AGENT_CONTRACT);
});

test("the working agreement: markdown sections, 700-1500 words, no model or vendor names, ASCII punctuation, no shouting", () => {
  const s = GLM_53_AGENT_CONTRACT;
  expect(s.startsWith("# ")).toBe(true);
  const words = s.split(/\s+/).filter(Boolean).length;
  expect(words).toBeGreaterThanOrEqual(700);
  expect(words).toBeLessThanOrEqual(1500); // 1485 with # Planning (2026-09-19); the ceiling is a brake on drift, not a target
  expect(s).not.toMatch(/claude|anthropic|sonnet|opus|\bglm\b|z\.ai|zhipu|openai|gpt/i);
  expect(s).not.toMatch(/[–—‘’“”…]/); // en/em dash, curly quotes, ellipsis
  expect(s).not.toMatch(/\b(CRITICAL|MUST|NEVER|ALWAYS|IMPORTANT)\b/); // calm register: no shouted rules
  // the protocol facts a smaller model needs, in the section's own words
  expect(s).toMatch(/read/); expect(s).toMatch(/edit/); expect(s).toMatch(/hash/i);
  expect(s).toMatch(/concurrent|parallel|independent calls together/i);
  expect(s).toMatch(/verif/i);
  expect(s).toMatch(/Edit rejected/);
  expect(s).toMatch(/context compacted/); // the compaction note the shipped runtime really emits (keep-window marker)
});

test("the working agreement says to FINISH: a # Finishing section with the read-it-back rule and the blocked-part rule; no sentence that turns are scarce; the recap example shows the implied part done, not offered", () => {
  const s = GLM_53_AGENT_CONTRACT;
  // the only unconditional "keep going" used to be about subagents; this section is about the task itself
  expect(s).toContain("\n# Finishing\n");
  expect(s.indexOf("# Finishing")).toBeGreaterThan(s.indexOf("# Scope and quality"));   // read right after minimality, as its counterweight
  expect(s.indexOf("# Finishing")).toBeLessThan(s.indexOf("# Questions and permissions"));
  expect(s).toContain("A reply without a tool call ends the run.");
  expect(s).toContain("read it back: if it says what you will do, could do, or would do next, do that instead.");
  expect(s).toContain("finish every other part in full and name the blocked one and why; leaving a part out is the user's decision, not yours.");
  expect(s).toContain("Stop when the request is complete, or when the next step needs an answer only the user can give.");
  // minimality stays exactly where it was: the bug was minimality WITHOUT a completion rule
  expect(s).toContain("Change what was asked and what it strictly requires.");
  // the brake is gone: nothing tells the model its turns are scarce
  expect(s).not.toMatch(/bounded number of turns/);
  expect(s).not.toMatch(/spends one of/);
  // the worked recap — the strongest teacher in the prompt — no longer hands an implied part back as a menu item
  expect(s).not.toContain("say so if you want the flag documented");
  expect(s).toContain("README: the flag is listed under export.");
});

test("the working agreement PLANS and DELEGATES: a # Planning section between Shell and Scope with the todo discipline and the workflow split; the reporting section no longer carries duplicate todo mechanics", () => {
  const s = GLM_53_AGENT_CONTRACT;
  expect(s).toContain("\n# Planning\n");
  expect(s.indexOf("# Planning")).toBeGreaterThan(s.indexOf("# Shell"));
  expect(s.indexOf("# Planning")).toBeLessThan(s.indexOf("# Scope and quality"));
  // plan first, specific items, real thresholds
  expect(s).toContain("A non-trivial request gets a plan before the first edit.");
  expect(s).toContain("not vague phases");
  expect(s).toContain("Three or more steps get a list; a single straightforward task does not.");
  // follow the plan: one in_progress, completed means verified, rewrite on change, reminder stays unmentioned
  expect(s).toContain("The list is then followed, not posted.");
  expect(s).toContain("Exactly one item `in_progress` at a time; `completed` only when that item's verification passed, never on intent");
  expect(s).toContain("<plan-reminder>");
  // the workflow split: independent parts to concurrent subagents, dependent parts kept, combined result verified
  expect(s).toContain("A wide request becomes a workflow instead of one long solo run.");
  expect(s).toContain("`isolated` when the part edits files");
  expect(s).toContain("issue independent starts together in one turn and they run concurrently");
  expect(s).toContain("verify the combined work, not the summaries.");
  // the mechanics live in # Planning now; the reporting section keeps compaction + the subagent note only
  expect(s).not.toContain("For three or more steps keep a `todo_write` list");
  expect(s).toContain("A sub-agent started with `task` sees only its `goal`");
});

test("the Sonnet 5 persona: 600-900 words, names the role, is a CLOSED role (stays Sonnet 5 when asked, no sincerity break, never the underlying vendor), ASCII punctuation, calm register", () => {
  const s = SONNET_5_PERSONA;
  expect(s.startsWith("# ")).toBe(true);
  const words = s.split(/\s+/).filter(Boolean).length;
  expect(words).toBeGreaterThanOrEqual(600);
  expect(words).toBeLessThanOrEqual(900);
  expect(s).toMatch(/Claude Sonnet 5/);
  expect(s).toMatch(/Anthropic/);
  expect(s).toMatch(/Stay in role as Claude Sonnet 5/); // closed role: it does not break character on an identity question
  expect(s).not.toMatch(/persona running on|do not claim to be Anthropic's own weights/); // the old sincerity clause is gone
  expect(s).not.toMatch(/\/status/); // the persona never points the user at the real model id; /status is the harness's own channel
  expect(s).not.toMatch(/\bglm\b|z\.ai|zhipu/i);
  expect(s).not.toMatch(/[–—‘’“”…]/);
  expect(s).not.toMatch(/\b(CRITICAL|MUST|NEVER|ALWAYS|IMPORTANT)\b/);
  expect(s).not.toMatch(/anchorHash|Edit rejected/); // the working agreement's protocol is not restated here
});

test("the voice examples block: real captured quotes, the three test anchors, language-neutral framing, ASCII punctuation, no underlying vendor", () => {
  const s = SONNET_5_VOICE;
  expect(s.startsWith("# Voice examples")).toBe(true);
  const words = s.split(/\s+/).filter(Boolean).length;
  expect(words).toBeGreaterThanOrEqual(150);
  expect(words).toBeLessThanOrEqual(360);
  expect(s).toContain("Ben Claude Sonnet 5'im");
  expect(s).toContain("Selam kanka");
  expect(s).toContain("[...new Set(dizi)]");
  expect(s).toContain("sessizce NaN veriyor");            // the bug-fix "correct the wrong premise" exemplar
  expect(s).toMatch(/mirror the user's/i);                // framed as mirror-the-language, not answer-in-Turkish
  expect(s).not.toMatch(/\bglm\b|z\.ai|zhipu/i);
  expect(s).not.toMatch(/[–—‘’“”…]/);
});
