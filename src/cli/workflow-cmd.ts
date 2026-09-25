/** `rovecode workflow run <file.ts> [--resume <runId>] [--json]` (F3, sdk-blueprint.md §4).
 *
 *  The file's default export is a WorkflowSpec (defineWorkflow). Steps ride the runtime's
 *  TaskManager, so every running step appears on the Mission Control agent tree (/ui,
 *  GET /events) while the workflow runs. Gates ask on the TTY; off a TTY a gate REJECTS
 *  (a headless workflow must be gate-free — asking nobody would hang forever). */

import { join, resolve } from "node:path";
import { defineWorkflow, listWorkflowRuns, runWorkflow, type WorkflowExecutor, type WorkflowSpec } from "../workflow/engine.ts";
import { askLine } from "./setup.ts";

export async function cmdWorkflow(words: string[]): Promise<number> {
  const [action, ...rest] = words;
  const cwd = process.cwd();
  const dir = join(cwd, ".rovecode", "workflows");

  if (action === "list") {
    const runs = listWorkflowRuns(dir);
    if (process.argv.includes("--json")) { console.log(JSON.stringify({ runs }, null, 2)); return 0; }
    if (runs.length === 0) { console.log(`no workflow runs in ${dir}`); return 0; }
    for (const r of runs) console.log(`${r.runId}  done: ${r.done.length > 0 ? r.done.join(", ") : "(none)"}`);
    return 0;
  }

  if (action !== "run" || rest[0] === undefined) {
    console.error("usage: rovecode workflow run <file.ts> [--resume <runId>] [--json] | rovecode workflow list");
    return 2;
  }

  const file = resolve(cwd, rest[0]);
  let spec: WorkflowSpec;
  try {
    const mod = (await import(file)) as { default?: WorkflowSpec };
    if (!mod.default) throw new Error("the file must `export default defineWorkflow({…})`");
    spec = defineWorkflow(mod.default);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const resumeIdx = process.argv.indexOf("--resume");
  const resumeId = resumeIdx !== -1 ? process.argv[resumeIdx + 1] : undefined;
  const asJson = process.argv.includes("--json");

  const { bootRuntime } = await import("./runtime.ts");
  const rt = await bootRuntime();
  const exit = async (code: number): Promise<never> => {
    rt.tasks.cancelAll();
    await rt.tasks.drain(2_000);
    await rt.hooks.close();
    await rt.mcp?.close().catch(() => {});
    // cmdRun's lesson: runtime keeps the event loop alive (watchers, MCP); return
    // the code and the process never exits. One-shot commands end the process.
    return process.exit(code);
  };
  const why = rt.noProviderReason();
  if (why !== null && process.env.ROVECODE_MOCK !== "1") { console.error(`error: ${why}`); return exit(2); }

  const tty = process.stdin.isTTY === true;
  const exec: WorkflowExecutor = {
    runAgent: async (step) => {
      const start = rt.tasks.start(
        { agent: step.agent ?? "main", goal: step.goal },
        { label: `${spec.name}/${step.name}` },
      );
      if (!start.ok) return { ok: false, summary: start.reason };
      const info = await rt.tasks.result(start.id);
      if (!info) return { ok: false, summary: "task vanished" };
      return {
        ok: info.status === "done",
        summary: info.summary ?? info.error ?? info.status,
        ...(info.usage !== undefined ? { usage: info.usage } : {}),
      };
    },
    askGate: async (prompt) => {
      if (!tty) { console.error(`gate '${prompt}': no TTY — rejected (run workflows with gates interactively)`); return false; }
      const a = (await askLine(`gate [${spec.name}]: ${prompt} [y/N] `)).trim().toLowerCase();
      return a === "y" || a === "yes";
    },
    cancelAgent: () => { rt.tasks.cancelAll(); },
  };

  const emit = (e: { type: string } & Record<string, unknown>): void => {
    if (asJson) { console.log(JSON.stringify(e)); return; }
    if (e.type === "workflow_started") console.log(`workflow ${e.name} (${e.runId}) — ${e.steps} steps`);
    else if (e.type === "step_started") console.log(`  ▸ ${e.step} (attempt ${e.attempt})`);
    else if (e.type === "step_done") console.log(`  ✓ ${e.step} — ${String(e.summary ?? "").slice(0, 120)}`);
    else if (e.type === "step_failed") console.error(`  ✗ ${e.step} — ${String(e.error ?? "").slice(0, 120)}`);
    else if (e.type === "gate_waiting") { /* askGate prints the prompt */ }
    else if (e.type === "workflow_done") console.log(`workflow ${e.status} (${e.runId})`);
  };

  const result = await runWorkflow(spec, exec, {
    dir,
    emit,
    ...(resumeId !== undefined ? { runId: resumeId } : {}),
  });
  if (asJson) console.log(JSON.stringify({ runId: result.runId, status: result.status, steps: result.steps, usage: result.usage }, null, 2));
  return exit(result.status === "done" ? 0 : 1);
}
