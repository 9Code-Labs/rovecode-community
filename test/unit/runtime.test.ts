import { test, expect } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { tokenScaleFor } from "../../src/core/token-scale.ts";
import { contextBudgetFor } from "../../src/core/context-report.ts";
import type { ApprovalFn, StreamFn } from "../../src/core/types.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { GLM_53_AGENT_CONTRACT, GLM_53_PROFILE } from "../../src/providers/profiles.ts";
import { designPromptSection } from "../../src/design/rules.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "rovecode-runtime-"));
}

test("createRuntime builds stores under <cwd>/.rovecode/sessions/<id> — on disk only once the session holds an entry", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, sessionId: "sess-1", stream: null });
  expect(rt.cwd).toBe(cwd);
  expect(rt.sessionId).toBe("sess-1");
  expect(rt.store.id).toBe("sess-1");
  // Booting a runtime used to leave `<sessions>/<id>/meta.json` and an empty `memory/` behind whether or not
  // anything was ever said: 27 hollow session directories in this repo alone. The sessions ROOT may exist
  // (recall and todo tools are bound to it); the session's own directory appears with its first entry.
  expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-1"))).toBe(false);
  rt.store.append({ id: "u1", role: "user", parts: [{ kind: "text", text: "hello" }], parentId: null, createdAt: Date.now() });
  expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-1", "meta.json"))).toBe(true);
  expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-1", "entries.jsonl"))).toBe(true);
  // BlockStore path: <sessions>/<sessionId>/memory — created by the first memory commit, not by boot
  expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-1", "memory"))).toBe(false);
  rmSync(cwd, { recursive: true, force: true });
});

test("createRuntime registers the full CLI tool set", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const names = rt.registry.list().map((t) => t.schema.name).sort();
  // ports #17 recall, #22 glob/grep/ls, #26 task (spawn) + task_status (read — MED-2 split), #31 web_fetch, #56 web_search, #55 bash_list/bash_output/bash_kill, #32 todo_read/todo_write,
  // #33 ask_user (every surface; headless fail closed at execute); eval_cell must stay ABSENT while ROVECODE_EVAL_CELL is unset (port #18 flag door)
  // provider_list (read) + provider_edit (custom → tool.provider_edit, prompted): the live provider registry (tools/provider.ts)
  // design_audit (read — self-checking must never prompt) + design_direction (custom → tool.design_direction, prompted): the design protocol (design/rules.ts)
  expect(names).toEqual(["ask_user", "bash", "bash_kill", "bash_list", "bash_output", "design_audit", "design_direction", "edit", "glob", "grep", "ls", "memory_edit", "provider_edit", "provider_list", "read", "recall", "skill_view", "skills_list", "task", "task_status", "todo_read", "todo_write", "web_fetch", "web_search", "write"]);
  const kinds = Object.fromEntries(rt.registry.list().map((t) => [t.schema.name, t.kind]));
  expect(kinds["task"]).toBe("spawn");        // gated rules prompt once per start
  expect(kinds["task_status"]).toBe("read");  // gated rules allow: never prompts, headless-safe
  expect(kinds["provider_list"]).toBe("read");   // never prompts; plan mode keeps it
  expect(kinds["provider_edit"]).toBe("custom"); // tool.provider_edit → prompt (rule below), denied in plan mode
  rmSync(cwd, { recursive: true, force: true });
});

test("systemPrompt includes base text, memory index, and rebuilds skills index per call", () => {
  const cwd = tmpCwd();
  // pre-seed memory BEFORE construction: BlockStore snapshot is frozen at session start
  const memDir = join(cwd, ".rovecode", "sessions", "sess-2", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "MEMORY.md"), "remember the milk");
  const rt = createRuntime({ cwd, sessionId: "sess-2", stream: null });

  const p1 = rt.systemPrompt();
  expect(p1).toContain(`You are Rovecode, an interactive coding agent in ${cwd}.`);
  expect(p1).toContain("# Memory");
  expect(p1).toContain("remember the milk");
  expect(p1).not.toContain("runtime-skill-x");

  // add a project skill after construction: a rescan must surface it on the next call
  const skillDir = join(cwd, ".rovecode", "skills", "runtime-skill-x");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: runtime-skill-x\ndescription: test skill\nversion: 1.0.0\n---\n\nbody\n");
  rt.skillStore.scan();
  const p2 = rt.systemPrompt();
  expect(p2).toContain("# Skills");
  expect(p2).toContain("runtime-skill-x");
  rmSync(cwd, { recursive: true, force: true });
});

test("buildDef returns main agent with wildcard tools and the runtime prompt", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const def = rt.buildDef({ provider: "p", model: "m-1" });
  expect(def.name).toBe("main");
  expect(def.tools).toEqual(["*"]);
  expect(def.model).toEqual({ provider: "p", model: "m-1", effort: "auto" }); // buildDef stamps the runtime's thinking dial onto every ref; "auto" = the provider's own default
  // no profile matches "m-1", so the prompt is base + the working agreement every profile-less model gets + the always-on design section
  expect(def.systemPrompt).toBe(`${rt.systemPrompt()}\n\n${GLM_53_AGENT_CONTRACT}\n\n${designPromptSection(cwd)}`);
  rmSync(cwd, { recursive: true, force: true });
});

test("buildCfg gated: repl defaults with memory/skill allows and prompt gates", async () => {
  const cwd = tmpCwd();
  // The 1M-window branch below needs a configured provider. This test used to get one from the developer's
  // exported ANTHROPIC_API_KEY — "this box's default model" — and passed on that machine only; the moment
  // test/helpers/isolate-home.ts started clearing provider variables it fell back to the flat 200_000 and
  // failed, which is exactly the dependency the preload exists to surface. So the key is set here, on purpose,
  // and removed again before the parts of the test that do not need it.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  const rt = createRuntime({ cwd, stream: null });
  const seen: string[] = [];
  const approval: ApprovalFn = async (req) => { seen.push(req.tool); return "once"; };
  const cfg = rt.buildCfg(false, approval);
  try {
    expect(cfg.maxTurns).toBe(60);
    // the budget follows the model's window now: anthropic's default model has a 1M window and a 128k answer,
    // so the history gets what is left. A model the catalog does not know still falls back to the flat 200_000.
    // It is then divided by the model's measured token scale, because the budget is compared against an
    // estimate our tokenizer produces and this model's own tokenizer counts more (core/token-scale.ts).
    const ref = rt.providers.defaultRef() ?? { provider: "mock", model: "default" };
    expect(ref.provider).toBe("anthropic");   // the branch under test really is the 1M one
    expect(cfg.contextBudgetTokens).toBe(
      contextBudgetFor({ window: 1_000_000, maxOutput: 128_000, scale: tokenScaleFor(ref).charScale }),
    );
    expect(cfg.contextBudgetTokens).toBeGreaterThan(200_000);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
  expect(cfg.compactionThreshold).toBe(0.8);
  expect(cfg.parallelTools).toBe(true);
  expect(cfg.permissionRules).toEqual([
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.external", resource: "*", effect: "prompt" }, // the workspace boundary (core/workspace.ts): a path OUTSIDE the cwd asks; inside, this rule is never consulted
    { action: "memory.write", resource: "*", effect: "allow" },
    { action: "tool.skill_view", resource: "*", effect: "allow" },
    { action: "tool.skills_list", resource: "*", effect: "allow" },
    // no tool.mcp_list rule: mcp_list is kind:"read" → covered by the file.read allow
    { action: "file.write", resource: "*", effect: "prompt" },
    { action: "shell.exec", resource: "*", effect: "prompt" },
    { action: "spawn", resource: "*", effect: "prompt" },
    { action: "tool.mcp_call", resource: "*", effect: "prompt" },  // port #3: MCP execution is gated
    { action: "tool.provider_edit", resource: "*", effect: "prompt" }, // providers.json / default-model writes ask first
    { action: "tool.design_direction", resource: "*", effect: "prompt" }, // .rovecode/design.json: the once-per-project design identity
    // ...but `get` only READS that file: allowed, and it must come after the prompt rule (last match wins).
    // The two modes are told apart by the tool's own resource() (tools/design.ts), not by the tool name.
    { action: "tool.design_direction", resource: "get", effect: "allow" },
    { action: "net.fetch", resource: "*", effect: "prompt" },      // port #31: web_fetch prompts unless a host is explicitly allowed
  ]);
  // port #9: the passed approver is WRAPPED by execPolicyApprover (shell prompts
  // refined by policy; everything else delegates). Non-shell requests must reach
  // the inner approver unchanged.
  expect(typeof cfg.approval).toBe("function");
  expect(cfg.approval).not.toBe(approval);
  const verdict = await cfg.approval!({ tool: "write", args: { path: "x" }, revisedArgs: { path: "x" }, reason: "file.write x" });
  expect(verdict).toBe("once");
  expect(seen.length).toBe(1);
  rmSync(cwd, { recursive: true, force: true });
});

test("buildCfg yolo: allow-all and no approval even when one is passed", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const cfg = rt.buildCfg(true, async () => "deny");
  expect(cfg.permissionRules).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  expect(cfg.approval).toBeUndefined();
  rmSync(cwd, { recursive: true, force: true });
});

test("provider resolution: env provider populates provider/stream/defaultModel; overrides win", () => {
  const saved = {
    base: process.env.ROVECODE_BASE_URL, key: process.env.ROVECODE_API_KEY, model: process.env.ROVECODE_MODEL,
  };
  try {
    process.env.ROVECODE_BASE_URL = "https://example.test/v1";
    process.env.ROVECODE_API_KEY = "k-test";
    process.env.ROVECODE_MODEL = "test-model-9";
    const cwd = tmpCwd();
    const rt = createRuntime({ cwd });
    expect(rt.provider?.id).toBe("custom");
    expect(rt.provider?.baseUrl).toBe("https://example.test/v1");
    expect(rt.stream).not.toBeNull();
    expect(rt.defaultModel).toBe("test-model-9");
    // explicit stream override beats the provider-derived stream
    const fake: StreamFn = async function* () { yield { type: "turn", turn: textTurn("hi") }; };
    const rt2 = createRuntime({ cwd, stream: fake });
    expect(rt2.stream).toBe(fake);
    // explicit null forces "no stream" while provider stays reported
    const rt3 = createRuntime({ cwd, stream: null });
    expect(rt3.stream).toBeNull();
    expect(rt3.provider?.id).toBe("custom");
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    if (saved.base === undefined) delete process.env.ROVECODE_BASE_URL; else process.env.ROVECODE_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.ROVECODE_API_KEY; else process.env.ROVECODE_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.ROVECODE_MODEL; else process.env.ROVECODE_MODEL = saved.model;
  }
});

test("setBlockStore rebinds the memory the SYSTEM PROMPT reads (critic MEDIUM-1)", () => {
  const cwd = tmpCwd();
  try {
    const rt = createRuntime({ cwd, stream: null });
    expect(rt.systemPrompt()).not.toContain("NEW-SESSION-FACT");
    // renderForPrompt uses the frozen-at-load snapshot, so seed the dir first,
    // then hand the runtime a FRESH store over it (exactly what /resume does)
    const dirB = join(cwd, "other-session-memory");
    const { BlockStore } = require("../../src/memory/blocks.ts") as typeof import("../../src/memory/blocks.ts");
    new BlockStore(dirB).add("memory", "NEW-SESSION-FACT");
    rt.setBlockStore(new BlockStore(dirB));
    expect(rt.systemPrompt()).toContain("NEW-SESSION-FACT");
    expect(rt.blockStore.liveText("memory")).toContain("NEW-SESSION-FACT");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- model profiles (providers/profiles.ts) ride into buildDef ----------

test("buildDef appends the GLM-5.3 profile section after the base prompt, leaves other models bare, honors ROVECODE_PROFILE, the .rovecode/profiles/glm-5.3.md override (incl. an empty one) and a cwd override for the identity sentence", () => {
  const cwd = tmpCwd();
  const home = mkdtempSync(join(tmpdir(), "rovecode-home-"));
  const prevProfile = process.env.ROVECODE_PROFILE, prevHome = process.env.ROVECODE_HOME;
  const prevDesign = process.env.ROVECODE_DESIGN;
  delete process.env.ROVECODE_PROFILE;
  process.env.ROVECODE_HOME = home; // never read the developer's real ~/.rovecode/profiles
  // this test is about the PROFILE section's exact composition, so the always-on design section is
  // switched off to keep the byte-equality assertions readable; it has its own wiring test
  // (test/integration/design-wiring.test.ts), including that it sits AFTER the profile section
  process.env.ROVECODE_DESIGN = "off";
  try {
    const rt = createRuntime({ cwd, stream: null });
    const glm = { provider: "kaesra", model: "zai-org/glm-5.3-flash" };
    const claude = { provider: "anthropic", model: "claude-opus-5" };
    expect(rt.buildDef(glm).systemPrompt).toBe(`${rt.systemPrompt()}\n\n${GLM_53_PROFILE.promptSection}`);
    // a model without a profile is not bare: it gets the vendor-neutral working agreement (the GLM
    // profile carries the same text after its persona) — only GLM used to receive it, Claude and GPT
    // got one sentence, and the quality gap showed
    expect(rt.buildDef(claude).systemPrompt).toBe(`${rt.systemPrompt()}\n\n${GLM_53_AGENT_CONTRACT}`);
    expect(rt.buildDef({ provider: "openai", model: "gpt-5" }).systemPrompt).toBe(`${rt.systemPrompt()}\n\n${GLM_53_AGENT_CONTRACT}`);
    // the identity sentence can name another directory (live gauntlet); indexes and the section are unchanged
    const elsewhere = rt.buildDef(glm, { cwd: "Z:/scratch" }).systemPrompt as string;
    expect(elsewhere.startsWith("You are Rovecode, an interactive coding agent in Z:/scratch.")).toBe(true);
    expect(elsewhere.endsWith(GLM_53_PROFILE.promptSection)).toBe(true);
    expect(elsewhere).not.toContain(cwd);
    expect(rt.systemPrompt("Z:/scratch").startsWith("You are Rovecode, an interactive coding agent in Z:/scratch.")).toBe(true);
    // the project override REPLACES the built-in text (trimmed) — iterate without a rebuild
    mkdirSync(join(cwd, ".rovecode", "profiles"), { recursive: true });
    writeFileSync(join(cwd, ".rovecode", "profiles", "glm-5.3.md"), "# Custom rules\nbe brief\n");
    expect(rt.buildDef(glm).systemPrompt).toBe(`${rt.systemPrompt()}\n\n# Custom rules\nbe brief`);
    // an EMPTY override drops the section AND the separator: byte-equal to a profile-less prompt
    writeFileSync(join(cwd, ".rovecode", "profiles", "glm-5.3.md"), "  \n");
    expect(rt.buildDef(glm).systemPrompt).toBe(rt.systemPrompt());
    // kill switch
    writeFileSync(join(cwd, ".rovecode", "profiles", "glm-5.3.md"), "# Custom rules\nbe brief\n");
    process.env.ROVECODE_PROFILE = "off";
    expect(rt.buildDef(glm).systemPrompt).toBe(`${rt.systemPrompt()}\n\n${GLM_53_AGENT_CONTRACT}`); // profile off = no persona, but the working agreement stays
    // forced onto a model it was not written for: the prompt section only (the wire follows the model id)
    process.env.ROVECODE_PROFILE = "glm-5.3";
    expect(rt.buildDef(claude).systemPrompt).toBe(`${rt.systemPrompt()}\n\n# Custom rules\nbe brief`);
  } finally {
    if (prevProfile === undefined) delete process.env.ROVECODE_PROFILE; else process.env.ROVECODE_PROFILE = prevProfile;
    if (prevDesign === undefined) delete process.env.ROVECODE_DESIGN; else process.env.ROVECODE_DESIGN = prevDesign;
    if (prevHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
