import { test, expect } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ApprovalFn, StreamFn } from "../../src/core/types.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { GLM_53_PROFILE } from "../../src/providers/profiles.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "rovecode-runtime-"));
}

test("createRuntime builds stores under <cwd>/.rovecode/sessions/<id>", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, sessionId: "sess-1", stream: null });
  expect(rt.cwd).toBe(cwd);
  expect(rt.sessionId).toBe("sess-1");
  expect(rt.store.id).toBe("sess-1");
  expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-1"))).toBe(true);
  // BlockStore path: <sessions>/<sessionId>/memory
  expect(existsSync(join(cwd, ".rovecode", "sessions", "sess-1", "memory"))).toBe(true);
  rmSync(cwd, { recursive: true, force: true });
});

test("createRuntime registers the full CLI tool set", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const names = rt.registry.list().map((t) => t.schema.name).sort();
  // ports #17 recall, #22 glob/grep/ls, #26 task (spawn) + task_status (read — MED-2 split), #31 web_fetch, #32 todo_read/todo_write,
  // #33 ask_user (every surface; headless fail closed at execute); eval_cell must stay ABSENT while ROVECODE_EVAL_CELL is unset (port #18 flag door)
  // provider_list (read) + provider_edit (custom → tool.provider_edit, prompted): the live provider registry (tools/provider.ts)
  expect(names).toEqual(["ask_user", "bash", "edit", "glob", "grep", "ls", "memory_edit", "provider_edit", "provider_list", "read", "recall", "skill_view", "skills_list", "task", "task_status", "todo_read", "todo_write", "web_fetch", "write"]);
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
  expect(def.model).toEqual({ provider: "p", model: "m-1", effort: "off" }); // buildDef stamps the runtime's thinking dial onto every ref
  expect(def.systemPrompt).toBe(rt.systemPrompt());
  rmSync(cwd, { recursive: true, force: true });
});

test("buildCfg gated: repl defaults with memory/skill allows and prompt gates", async () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  const seen: string[] = [];
  const approval: ApprovalFn = async (req) => { seen.push(req.tool); return "once"; };
  const cfg = rt.buildCfg(false, approval);
  expect(cfg.maxTurns).toBe(60);
  expect(cfg.contextBudgetTokens).toBe(200_000);
  expect(cfg.compactionThreshold).toBe(0.8);
  expect(cfg.parallelTools).toBe(true);
  expect(cfg.permissionRules).toEqual([
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "memory.write", resource: "*", effect: "allow" },
    { action: "tool.skill_view", resource: "*", effect: "allow" },
    { action: "tool.skills_list", resource: "*", effect: "allow" },
    // no tool.mcp_list rule: mcp_list is kind:"read" → covered by the file.read allow
    { action: "file.write", resource: "*", effect: "prompt" },
    { action: "shell.exec", resource: "*", effect: "prompt" },
    { action: "spawn", resource: "*", effect: "prompt" },
    { action: "tool.mcp_call", resource: "*", effect: "prompt" },  // port #3: MCP execution is gated
    { action: "tool.provider_edit", resource: "*", effect: "prompt" }, // providers.json / default-model writes ask first
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
  delete process.env.ROVECODE_PROFILE;
  process.env.ROVECODE_HOME = home; // never read the developer's real ~/.rovecode/profiles
  try {
    const rt = createRuntime({ cwd, stream: null });
    const glm = { provider: "kaesra", model: "zai-org/glm-5.3-flash" };
    const claude = { provider: "anthropic", model: "claude-opus-5" };
    expect(rt.buildDef(glm).systemPrompt).toBe(`${rt.systemPrompt()}\n\n${GLM_53_PROFILE.promptSection}`);
    expect(rt.buildDef(claude).systemPrompt).toBe(rt.systemPrompt());
    expect(rt.buildDef({ provider: "openai", model: "gpt-5" }).systemPrompt).toBe(rt.systemPrompt());
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
    expect(rt.buildDef(glm).systemPrompt).toBe(rt.systemPrompt());
    // forced onto a model it was not written for: the prompt section only (the wire follows the model id)
    process.env.ROVECODE_PROFILE = "glm-5.3";
    expect(rt.buildDef(claude).systemPrompt).toBe(`${rt.systemPrompt()}\n\n# Custom rules\nbe brief`);
  } finally {
    if (prevProfile === undefined) delete process.env.ROVECODE_PROFILE; else process.env.ROVECODE_PROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
