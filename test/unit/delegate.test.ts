/** delegate tool + external CLI agent adapters (agents/external.ts). No real CLIs: the runner seam
 *  stubs process execution; the one live case uses `bun -e` (present by definition — the harness
 *  runs on it). */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_AGENTS, buildArgv, loadAgentSpecs, parseAgentOutput, runExternalAgent } from "../../src/agents/external.ts";
import { delegateTool } from "../../src/tools/delegate.ts";
import type { ToolContext } from "../../src/core/types.ts";

const ctx: ToolContext = { sessionId: "s", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } };

// ---------- output parsing ----------

test("claude-json: result + cost + turns; is_error flips ok upstream", () => {
  const out = parseAgentOutput("claude-json", JSON.stringify({ result: "done it", is_error: false, total_cost_usd: 0.0123, num_turns: 4 }), "");
  expect(out).toEqual({ text: "done it", costUsd: 0.0123, turns: 4 });
  expect(parseAgentOutput("claude-json", JSON.stringify({ result: "boom", is_error: true }), "").isError).toBe(true);
});

test("codex-jsonl: the LAST completed agent_message wins; partial lines are ignored", () => {
  const stdout = [
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}',
    '{"type":"item.completed","item":{"type":', // truncated tail
  ].join("\n");
  expect(parseAgentOutput("codex-jsonl", stdout, "").text).toBe("final answer");
});

test("fallbacks: malformed claude-json reads as text; text format trims stdout, then stderr", () => {
  expect(parseAgentOutput("claude-json", "not json", "").text).toBe("not json");
  expect(parseAgentOutput("text", "  out  \n", "").text).toBe("out");
  expect(parseAgentOutput("text", "", "  err  ").text).toBe("err");
});

// ---------- spec loading ----------

test("agents.json: project overrides builtin, malformed entries drop with a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-delegate-"));
  try {
    mkdirSync(join(dir, ".rovecode"));
    writeFileSync(join(dir, ".rovecode", "agents.json"), JSON.stringify({
      agents: {
        claude: { command: ["my-claude", "go", "{prompt}"], format: "text", note: "wrapped" },
        broken: { command: "nope", format: "text" },
        badfmt: { command: ["x"], format: "yaml" },
      },
    }));
    const { specs, warnings } = loadAgentSpecs(dir);
    expect(specs["claude"]!.command[0]).toBe("my-claude");        // project wins over the builtin
    expect(specs["codex"]).toBeDefined();                          // builtins survive
    expect(specs["broken"]).toBeUndefined();
    expect(specs["badfmt"]).toBeUndefined();
    expect(warnings.length).toBe(2);
    expect(warnings.every((w) => w.includes("agents."))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the tool ----------

test("delegate: unknown agent names what exists; missing binary fails closed with the PATH verdict", async () => {
  const tool = delegateTool({
    cwd: process.cwd(),
    specs: { ghost: { command: ["not-on-path-xyz-rovecode", "{prompt}"], format: "text" } },
    runner: async () => ({ code: 0, stdout: "x", stderr: "" }),
  });
  const unknown = await tool.execute({ agent: "nope", prompt: "hi" }, ctx);
  expect(unknown.ok).toBe(false);
  expect(unknown.output).toContain("unknown agent");
  const missing = await tool.execute({ agent: "ghost", prompt: "hi" }, ctx);
  expect(missing.ok).toBe(false);
  expect(missing.output).toContain("not available");
  expect(missing.output).toContain("not-on-path-xyz-rovecode");
});

test("delegate: argv template substitution, ok result carries the meta line (exit · seconds · cost)", async () => {
  let seen: readonly string[] = [];
  const tool = delegateTool({
    cwd: process.cwd(),
    specs: { fake: { command: ["bun", "--print", "{prompt}"], format: "text" } },
    runner: async (argv) => { seen = argv; return { code: 0, stdout: "  the answer  ", stderr: "" }; },
  });
  const r = await tool.execute({ agent: "fake", prompt: "do the thing" }, ctx);
  expect(r.ok).toBe(true);
  expect(seen).toEqual(["bun", "--print", "do the thing"]);
  expect(r.output).toContain("fake finished (exit 0 ·");
  expect(r.output).toContain("the answer");
});

test("delegate: non-zero exit is ok:false with the parsed text; the run never throws", async () => {
  const tool = delegateTool({
    cwd: process.cwd(),
    specs: { fake: { command: ["bun", "-e", "x"], format: "text" } },
    runner: async () => ({ code: 2, stdout: "", stderr: "it broke" }),
  });
  const r = await tool.execute({ agent: "fake", prompt: "x" }, ctx);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("FAILED");
  expect(r.output).toContain("it broke");
});

test("delegate live: promptVia stdin reaches the process (claude shape through bun -e)", async () => {
  const tool = delegateTool({
    cwd: process.cwd(),
    specs: {
      fakeclaude: {
        command: ["bun", "-e", "let s='';for await(const c of Bun.stdin.stream())s+=new TextDecoder().decode(c);console.log(JSON.stringify({result:'got:'+s,is_error:false,num_turns:1}))"],
        format: "claude-json",
        promptVia: "stdin",
      },
    },
  });
  const r = await tool.execute({ agent: "fakeclaude", prompt: "hello-orchestrator" }, ctx);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("got:hello-orchestrator");
  expect(r.output).toContain("1 turns");
}, 30_000);

test("builtins ship the known CLIs; every one parses to a known format", () => {
  expect(Object.keys(BUILTIN_AGENTS).sort()).toEqual(["aider", "antigravity", "claude", "codex", "copilot", "cursor", "gemini", "opencode", "qwen"]);
  expect(BUILTIN_AGENTS["claude"]!.promptVia).toBe("stdin");
  for (const s of Object.values(BUILTIN_AGENTS)) expect(["claude-json", "codex-jsonl", "opencode-jsonl", "text"]).toContain(s.format);
});

test("opencode-jsonl: the answer is the text parts joined; other event types are ignored", () => {
  const stdout = [
    '{"type":"step_start","timestamp":1}',
    '{"type":"text","part":{"type":"text","text":"hello "}}',
    '{"type":"tool_use","part":{"type":"tool","tool":"bash"}}',
    '{"type":"text","part":{"type":"text","text":"world"}}',
    '{"type":"step_finish"}',
  ].join("\n");
  expect(parseAgentOutput("opencode-jsonl", stdout, "").text).toBe("hello world");
  expect(parseAgentOutput("opencode-jsonl", "garbage", "raw err").text).toBe("garbage"); // no events → text fallback
});

test("argv prompt over the ceiling fails before spawn (argv is not the place for a novel)", async () => {
  const r = await runExternalAgent(
    { command: ["bun", "-e", "x"], format: "text" },
    "x".repeat(100_001),
    { cwd: process.cwd() },
  );
  expect(r.ok).toBe(false);
  expect(r.text).toContain("argv ceiling");
});

// ---------- the tasks path (crew board) ----------

import { TaskManager } from "../../src/core/tasks.ts";

test("delegate via TaskManager: the delegation is a board task; the tool returns its settled result", async () => {
  const runs: { spec: unknown; prompt: string }[] = [];
  const tm = new TaskManager({
    deps: () => null,
    runExternal: async (spec, prompt) => { runs.push({ spec, prompt }); return { ok: true, text: "external answer", exitCode: 0, durationMs: 5, costUsd: 0.01 }; },
  });
  const tool = delegateTool({ cwd: process.cwd(), tasks: tm, specs: { fake: { command: ["bun", "-e", "x"], format: "text" } } });
  const r = await tool.execute({ agent: "fake", prompt: "build it" }, ctx);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("fake finished (task t1)");
  expect(r.output).toContain("external answer");
  expect(runs[0]!.prompt).toBe("build it");
  const t = tm.list()[0]!;
  expect(t.agent).toBe("fake");
  expect(t.status).toBe("done");
  expect(t.usage?.costUsd).toBe(0.01);
});

test("delegate via TaskManager: a failing agent lands as a failed task, ok:false to the model", async () => {
  const tm = new TaskManager({ deps: () => null, runExternal: async () => ({ ok: false, text: "it exploded", exitCode: 3, durationMs: 2 }) });
  const tool = delegateTool({ cwd: process.cwd(), tasks: tm, specs: { fake: { command: ["bun", "-e", "x"], format: "text" } } });
  const r = await tool.execute({ agent: "fake", prompt: "x" }, ctx);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("FAILED");
  expect(tm.list()[0]!.status).toBe("failed");
});

test("delegate via TaskManager: aborting the run cancels the delegation", async () => {
  const ac = new AbortController();
  let sawAbort = false;
  const tm = new TaskManager({
    deps: () => null,
    runExternal: async (_s, _p, o) => {
      await new Promise<void>((r) => { o.signal.addEventListener("abort", () => { sawAbort = true; r(); }, { once: true }); });
      return { ok: false, text: "aborted", exitCode: 143, durationMs: 1 };
    },
  });
  const tool = delegateTool({ cwd: process.cwd(), tasks: tm, specs: { fake: { command: ["bun", "-e", "x"], format: "text" } } });
  const p = tool.execute({ agent: "fake", prompt: "long work" }, { ...ctx, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  expect(r.ok).toBe(false);
  expect(sawAbort).toBe(true);
  expect(tm.list()[0]!.status).toBe("cancelled");
});

// ---------- the model passthrough (delegate `model` arg → the CLI's own -m/--model) ----------

test("the model arg becomes the CLI's own flag BEFORE the prompt — never smuggled into the prompt text", async () => {
  let seen: readonly string[] = [];
  const tool = delegateTool({
    cwd: process.cwd(),
    specs: { fake: { command: ["bun", "run", "{prompt}"], format: "text", modelFlag: "-m" } },
    runner: async (argv) => { seen = argv; return { code: 0, stdout: "ok", stderr: "" }; },
  });
  const r = await tool.execute({ agent: "fake", prompt: "do it", model: "combo/aglm/glm-5.3-flash" }, ctx);
  expect(r.ok).toBe(true);
  expect(seen).toEqual(["bun", "run", "-m", "combo/aglm/glm-5.3-flash", "do it"]);
});

test("stdin-prompt agents get the model flag at the end of argv (the prompt is not in argv)", () => {
  const spec = { command: ["claude", "-p", "--output-format", "json"], format: "claude-json" as const, promptVia: "stdin" as const, modelFlag: "--model" };
  expect(buildArgv(spec, "the prompt", "fable-5")).toEqual({ argv: ["claude", "-p", "--output-format", "json", "--model", "fable-5"], stdinPrompt: "the prompt" });
  expect(buildArgv({ command: ["x", "{prompt}"], format: "text", modelFlag: "-m" }, "P", "m").argv).toEqual(["x", "-m", "m", "P"]);
  expect(buildArgv({ command: ["x", "{prompt}"], format: "text" }, "P", "m").argv).toEqual(["x", "P"]); // no modelFlag → no flag
});

test("a spec without modelFlag refuses a model instead of dropping it silently", async () => {
  const tool = delegateTool({
    cwd: process.cwd(),
    specs: { fake: { command: ["bun", "-e", "x"], format: "text" } },
    runner: async () => ({ code: 0, stdout: "x", stderr: "" }),
  });
  const r = await tool.execute({ agent: "fake", prompt: "x", model: "m1" }, ctx);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("no modelFlag");
});

test("an agents.json override of a builtin inherits modelFlag/promptVia it did not say", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-delegate-inherit-"));
  try {
    mkdirSync(join(dir, ".rovecode"));
    writeFileSync(join(dir, ".rovecode", "agents.json"), JSON.stringify({
      agents: { opencode: { command: ["opencode", "run", "--pure", "{prompt}"], format: "opencode-jsonl" } },
    }));
    const { specs } = loadAgentSpecs(dir);
    expect(specs["opencode"]!.modelFlag).toBe("-m");            // inherited from the builtin
    expect(specs["opencode"]!.command).toContain("--pure");     // the override's own word stands
    expect(specs["claude"]!.promptVia).toBe("stdin");           // untouched builtin
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
