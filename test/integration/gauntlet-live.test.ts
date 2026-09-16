/** `rovecode gauntlet --live` wiring (eval/gauntlet-runner.ts runTaskLive): the live twin of runTask
 *  drives the PRODUCT's agent definition — the runtime's system prompt including the model profile
 *  section (providers/profiles.ts) with the identity sentence naming the scratch WORKSPACE — through the
 *  runtime's stream seam, with the workspace as the tool cwd, honors runGauntlet's timeout signal, and
 *  reports the provider's token usage per task. A scripted StreamFn stands in for the real provider so
 *  the wiring is proven without a key. Also pins the permission-rule order both runners share. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { evaluatePermissions } from "../../src/core/tools.ts";
import { LIVE_TASK_TIMEOUT_MS, gauntletRules, liveGauntletTasks, runTaskLive } from "../../src/eval/gauntlet-runner.ts";
import { basicTasks, reportResults, runGauntlet } from "../../src/eval/gauntlet.ts";
import { GLM_53_PROFILE } from "../../src/providers/profiles.ts";
import { textTurn } from "../../src/providers/stream.ts";
import type { Message, ModelRef, StreamFn } from "../../src/core/types.ts";

const GLM: ModelRef = { provider: "kaesra", model: "zai-org/glm-5.3-flash" };

/** isolate the tests from the developer's ROVECODE_PROFILE and ~/.rovecode/profiles */
async function isolated(run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "rovecode-home-"));
  const prevProfile = process.env.ROVECODE_PROFILE, prevHome = process.env.ROVECODE_HOME;
  delete process.env.ROVECODE_PROFILE;
  process.env.ROVECODE_HOME = home;
  try { await run(home); } finally {
    if (prevProfile === undefined) delete process.env.ROVECODE_PROFILE; else process.env.ROVECODE_PROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("liveGauntletTasks: every scripted task except loop-guard, each with the live timeout", () => {
  const tasks = liveGauntletTasks();
  const ids = tasks.map((t) => t.id);
  expect(ids).toEqual([
    "basic-question", "basic-file-create", "basic-tool-usage",
    "coding-bugfix", "coding-feature",
    "failure-tool-error", "failure-invalid-args",
    "adversarial-huge-output", "adversarial-permission-bypass",
  ]);
  for (const t of tasks) expect(t.timeoutMs).toBeGreaterThanOrEqual(LIVE_TASK_TIMEOUT_MS);
});

test("gauntletRules: the permission-bypass deny is evaluated LAST (last match wins), so /etc/passwd is denied and the workspace stays writable; other tasks allow everything", () => {
  const bypass = gauntletRules("adversarial-permission-bypass");
  expect(evaluatePermissions(bypass, "file.write", "/etc/passwd").effect).toBe("deny");
  expect(evaluatePermissions(bypass, "file.write", "/tmp/ws/hello.txt").effect).toBe("allow");
  expect(evaluatePermissions(bypass, "shell.exec", "ls").effect).toBe("allow");
  expect(evaluatePermissions(gauntletRules("basic-file-create"), "file.write", "/etc/passwd").effect).toBe("allow");
});

test("runTaskLive sends the product prompt (base + GLM profile section, identity sentence naming the WORKSPACE, no repo context chunks), sums usage, and the report shows tokens", () => isolated(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-runtime-"));
  const seen: Message[][] = [];
  const stream: StreamFn = async function* (_model, messages) {
    seen.push(messages);
    yield { type: "turn", turn: { ...textTurn("PONG"), usage: { input: 11, output: 5 } } };
  };
  try {
    const rt = createRuntime({ cwd, stream });
    const task = basicTasks().find((t) => t.id === "basic-question")!;
    const workspace = mkdtempSync(join(tmpdir(), "rovecode-g-"));
    try {
      const transcript = await runTaskLive(task, workspace, rt, GLM);
      expect(transcript.finalText).toContain("PONG");
      expect(transcript.usage).toEqual({ input: 11, output: 5 });
      const sys = seen[0]![0]!;
      expect(sys.role).toBe("system");
      const sysText = sys.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
      expect(sysText.startsWith(`You are Rovecode, an interactive coding agent in ${workspace}.`)).toBe(true);
      expect(sysText).not.toContain(cwd); // never the developer's checkout: an absolute path the model forms lands in the scratch dir
      expect(sysText).toContain(GLM_53_PROFILE.promptSection.slice(0, 60));
      // the live gauntlet measures the PRODUCT prompt, so it carries the design section too; order is
      // base -> profile -> design (cli/runtime.ts buildDef), and the scratch workspace has no
      // design.json, so it is the "choose a direction first" variant
      expect(sysText).toContain(GLM_53_PROFILE.promptSection);
      expect(sysText.indexOf(GLM_53_PROFILE.promptSection)).toBeLessThan(sysText.indexOf("# Interface design"));
      expect(sysText.endsWith("No design direction is recorded yet (.rovecode/design.json). The next interface work in this project starts with the proposal above.")).toBe(true);
      expect(sysText).not.toContain("You are being evaluated");
      expect(sysText).not.toContain("# Project context");
      expect(sysText).not.toContain("# Repo map");
    } finally { rmSync(workspace, { recursive: true, force: true }); }
    // through runGauntlet: usage reaches the result line
    const results = await runGauntlet({ tasks: [task], runner: (t, w, signal) => runTaskLive(t, w, rt, GLM, signal) });
    expect(results[0]!.pass).toBe(true);
    expect(results[0]!.usage).toEqual({ input: 11, output: 5 });
    expect(reportResults(results)).toMatch(/PASS {2}basic-question .*11\/5 tok/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}));

test("a task that outlives its timeout is ABORTED: the live loop's provider call sees the signal, the run settles before the leak scan, the result is a plain timeout (no workspace leak, no unhandled rejection)", () => isolated(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-runtime-"));
  let sawAbort = false;
  const stream: StreamFn = async function* (_model, _messages, options) {
    await new Promise<void>((resolve) => {
      const s = options?.signal;
      if (!s) return; // no signal threaded → hang forever (the test would time out — that is the failure mode under test)
      if (s.aborted) resolve(); else s.addEventListener("abort", () => resolve(), { once: true });
    });
    sawAbort = true;
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
  };
  try {
    const rt = createRuntime({ cwd, stream });
    const task = { ...basicTasks().find((t) => t.id === "basic-question")!, timeoutMs: 300 };
    const t0 = Date.now();
    const results = await runGauntlet({ tasks: [task], runner: (t, w, signal) => runTaskLive(t, w, rt, GLM, signal) });
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.detail).toMatch(/^timeout 300ms/);
    expect(results[0]!.detail).not.toMatch(/workspace leak/);
    expect(sawAbort).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000); // settled promptly after the abort, well inside the settle window
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}));

test("runTaskLive refuses a runtime without a provider stream", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-runtime-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const task = basicTasks()[0]!;
    await expect(runTaskLive(task, cwd, rt, GLM)).rejects.toThrow(/no provider stream/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
