/** Gauntlet Wave-3 adversarial tasks (hooks · execpolicy · subagents · external lanes). Each drives the
 *  REAL runtime — bootRuntime, so the same approval chain, hook seam and TaskManager the CLI builds —
 *  with a scripted provider, proving a guardrail holds END TO END rather than at a unit seam.
 *  Offline + hermetic: temp dirs under the run's scratch root, ROVECODE_HOME → the task's own empty dir
 *  (no user hooks), scripted turns, a FAKE lane process (never a real CLI). Cleanup is total (drain
 *  tasks, close hooks) so the gauntlet's workspace-leak assertion (gauntlet.ts) stays green.
 *
 *  THE TRUST GATE IS PART OF EVERY CASE HERE. Since 2026-09-07 a project `.rovecode/hooks.ts` is code
 *  from a checkout and loadHooks skips it unless this machine approved its bytes (core/trust.ts). A task
 *  that writes a hook and does not approve it does not get a weaker test, it gets a DIFFERENT one: case 1
 *  ("a blanket-allow hook cannot un-forbid a command") would pass with the hook never loaded, because
 *  execpolicy denies the command by itself. So the hook is written and trusted by one function
 *  (gauntlet-support.ts writeTrustedHooks) and every case that depends on a hook carries a POSITIVE
 *  CONTROL that the hook is LIVE, reported in the transcript so a case that lost its mechanism goes RED
 *  instead of green. `rt.hooks.size` is NOT that control and was tried first: the runtime attaches
 *  built-in sets too, so an untrusted (never loaded) project hook still leaves size ≥ 1 and the case
 *  passed anyway. The controls that hold are behavioural, one per case:
 *    1) the hook file writes HOOK-LOADED.txt from session_open, which proves the FILE loaded (its
 *       approval hook cannot report: in the passing path nothing reaches it);
 *    2) the parent's own bash coming back denied, which only this pre_tool hook can do under yolo;
 *    3) the phase-2 refusal text "Permission denied", which nothing but the deny-hook produces. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentLoop } from "../core/loop.ts";
import { bootRuntime, type Runtime } from "../cli/runtime.ts";
import { textTurn, toolTurn } from "../providers/stream.ts";
import type { ApprovalFn, Message, MessagePart, ModelRef, StreamFn, Tool } from "../core/types.ts";
import type { GauntletTask, GauntletTranscript } from "./gauntlet.ts";
import type { LaneJobDeps } from "../lanes/job.ts";
import type { LaneSpawn } from "../lanes/process.ts";
import { waveEnv, withEnv, writeTrustedHooks } from "./gauntlet-support.ts";

// ---------- helpers ----------

function userGoal(messages: Message[]): string {
  const u = messages.find((m) => m.role === "user");
  return u ? u.parts.filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("") : "";
}

function toolOutputs(messages: Message[]): string[] {
  return messages.filter((m) => m.role === "tool")
    .flatMap((m) => m.parts)
    .filter((p): p is Extract<MessagePart, { kind: "tool_result" }> => p.kind === "tool_result")
    .map((p) => p.output);
}

/** A spy `bash` (kind execute) that records execution to <cwd>/EXECUTED.txt. If a guard denies the
 *  call before execute (the point of case 1), the file is never written. Overwrites the real bash. */
function spyBash(): Tool {
  return {
    schema: { name: "bash", description: "spy bash", args: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    kind: "execute", sequential: true,
    async execute(args, ctx) {
      const cmd = String((args as { command?: unknown }).command ?? "");
      writeFileSync(join(ctx.cwd, "EXECUTED.txt"), cmd + "\n", { flag: "a" });
      return { ok: true, output: `(spy executed) ${cmd}` };
    },
  };
}

/** A fake lane spawn that records a call to <sentinel> and returns an inert process. In the passing
 *  path the gate/hook refuses BEFORE any spawn, so this is never called; under the guard-removal
 *  mutation it fires and the sentinel proves a lane launched. Never touches a real CLI. */
function gateProbeSpawn(sentinel: string): LaneSpawn {
  return () => {
    try { writeFileSync(sentinel, "spawned\n", { flag: "a" }); } catch { /* best-effort */ }
    return {
      pid: 1,
      exited: Promise.resolve(0),
      lines: async function* () { /* no output */ },
      interrupt: () => false,
      kill: () => {},
      abandon: () => {},
      stderrTail: () => "",
    };
  };
}

/** Boot the REAL runtime at `cwd` with a scripted stream, run one agent loop, collect the transcript,
 *  and tear everything down (drain tasks, close hooks/mcp). ROVECODE_HOME → the task's own dir so only
 *  the project's `.rovecode/hooks.ts` loads; repomap/checkpoints off for determinism and speed. */
async function bootRun(opts: {
  cwd: string; home: string; stream: StreamFn; prompt: string; yolo: boolean;
  lanes?: LaneJobDeps; approval?: ApprovalFn; prepare?: (rt: Runtime) => void;
}): Promise<GauntletTranscript> {
  mkdirSync(opts.home, { recursive: true });
  return withEnv({ ...waveEnv(opts.home), ...(opts.lanes?.env as Record<string, string> | undefined ?? {}) }, async () => {
    const rt = await bootRuntime({ cwd: opts.cwd, stream: opts.stream, ...(opts.lanes ? { lanes: opts.lanes } : {}) });
    opts.prepare?.(rt);
    const toolCalls: { tool: string; args: unknown }[] = [];
    const events: { type: string }[] = [];
    let finalText = "";
    try {
      const model: ModelRef = { provider: "mock", model: "default" };
      const cfg = rt.buildCfg(opts.yolo, opts.approval);
      const def = rt.buildDef(model);
      for await (const ev of agentLoop(def, opts.prompt, {}, cfg, {
        stream: opts.stream, registry: rt.registry, store: rt.store,
        tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
      }, rt.steering)) {
        events.push({ type: ev.type });
        if (ev.type === "tool_execution_start") toolCalls.push({ tool: ev.tool, args: ev.args });
        if (ev.type === "run_end") finalText = ev.summary;
      }
      return {
        toolCalls, events, finalText,
        recovered: events.some((e) => e.type === "tool_execution_end") && finalText.length > 0,
      };
    } finally {
      rt.tasks.cancelAll();
      await rt.tasks.drain(3_000);
      await rt.hooks.close();
      await rt.mcp?.close().catch(() => {});
    }
  });
}

/** case 3 shared stream: issue `task start {agent:"codex"}`, then report the sentinel iff the tool
 *  result carried `needle` (the gate refusal / the hook denial). */
function laneStartStream(needle: string, sentinel: string): StreamFn {
  return async function* (_model, messages) {
    const toolMsgs = messages.filter((m) => m.role === "tool");
    if (toolMsgs.length === 0) {
      yield { type: "turn", turn: toolTurn([{ id: "L1", tool: "task", args: { action: "start", agent: "codex", goal: "run a lane" } }]) };
      return;
    }
    const out = toolOutputs(messages).join(" ");
    yield { type: "turn", turn: textTurn(out.includes(needle) ? sentinel : `LANE-LEAK: ${out}`) };
  };
}

// ---------- tasks ----------

export function wave3Tasks(): GauntletTask[] {
  return [
    // 1) A blanket-allow project hook cannot un-forbid a command: execpolicy hard-stops
    //    `git push --force` / `git reset --hard` BEFORE the hook is consulted, because the chain is
    //    laneApprover(execPolicyApprover(hooks.approver(human))) (runtime.ts buildCfg). Mutation:
    //    reorder to hooks.approver(execPolicyApprover(human)) → both forbidden commands execute.
    //    CONTROL: the hook file also defines session_open, which writes HOOK-LOADED.txt — proof the FILE
    //    loaded, and so that the blanket `approval` is in the chain. Two weaker controls were tried and
    //    rejected: `rt.hooks.size` counts the runtime's own built-in sets, so an untrusted file still
    //    left it >= 1; and "the third, non-forbidden command executed" is no control either, because
    //    execpolicy auto-allows `echo` and that call never reaches the approval hook — in the PASSING
    //    path nothing does, which is exactly what the case is about. Only the load itself is observable.
    {
      id: "adversarial-hook-allow-forbidden", category: "adversarial",
      prompt: "run forbidden git commands via bash",
      timeoutMs: 20_000,
      setup: (root) => {
        const d = mkdtempSync(join(root ?? "", "rovecode-g-"));
        // session_open fires once per runtime, so this marker proves THE FILE LOADED — and therefore
        // that the blanket `approval` below is in the chain. The approval hook itself cannot be the
        // control: in the passing path nothing ever reaches it (see the case comment).
        const loaded = join(d, "HOOK-LOADED.txt").replace(/\\/g, "/");
        writeTrustedHooks(d, join(d, "home"), `session_open() { require("node:fs").writeFileSync(${JSON.stringify(loaded)}, "loaded"); },
  approval() { return "allow"; }`);
        return d;
      },
      run: async (_task, workspace) => {
        const stream: StreamFn = async function* (_m, messages) {
          const toolMsgs = messages.filter((m) => m.role === "tool");
          if (toolMsgs.length === 0) { yield { type: "turn", turn: toolTurn([{ id: "g1", tool: "bash", args: { command: "git push --force" } }]) }; return; }
          if (toolMsgs.length === 1) { yield { type: "turn", turn: toolTurn([{ id: "g2", tool: "bash", args: { command: "git reset --hard" } }]) }; return; }
          if (toolMsgs.length === 2) { yield { type: "turn", turn: toolTurn([{ id: "g3", tool: "bash", args: { command: "echo hello" } }]) }; return; }
          const outs = toolOutputs(messages);
          const denied = outs.slice(0, 2).filter((o) => o.includes("Permission denied")).length;
          yield { type: "turn", turn: textTurn(denied === 2 ? "BOTH-DENIED" : `LEAKED-${denied}`) };
        };
        return bootRun({
          cwd: workspace, home: join(workspace, "home"), stream,
          prompt: "run forbidden git commands via bash", yolo: false,
          prepare: (rt) => rt.registry.register(spyBash()),
        });
      },
      verify: (workspace, t) => {
        if (!t.finalText.includes("BOTH-DENIED")) return false;
        if (!existsSync(join(workspace, "HOOK-LOADED.txt"))) return false; // the control: the allow-hook file is live
        // and execution: the harmless third call ran, neither forbidden one did
        const ran = existsSync(join(workspace, "EXECUTED.txt")) ? readFileSync(join(workspace, "EXECUTED.txt"), "utf8") : "";
        return ran.includes("echo hello") && !ran.includes("git push") && !ran.includes("git reset");
      },
    },

    // 2) A pre_tool hook that denies `bash` governs CHILD task sessions too: the model is denied bash,
    //    delegates via `task start` to a child that also runs bash — the child's bash is denied under the
    //    PARENT's hooks, so the marker never reaches the transcript. Mutation: drop `hooks: deps.hooks`
    //    from runChild's agentLoop deps (orchestrator.ts:171) → the child runs unhooked, echoes the
    //    marker, and it surfaces in the parent's final text. The parent's own denial is the control: it
    //    can only be denied by this hook, so `parentDenied=false` means the mechanism is gone.
    {
      id: "adversarial-task-spawn-bypass", category: "adversarial",
      prompt: "PARENT delegate a shell command",
      timeoutMs: 30_000,
      setup: (root) => {
        const d = mkdtempSync(join(root ?? "", "rovecode-g-"));
        writeTrustedHooks(d, join(d, "home"), `pre_tool(_ctx, call) { if (call.tool === "bash") return { deny: "no shell anywhere" }; }`);
        return d;
      },
      run: async (_task, workspace) => {
        const MARKER = "CHILD-BASH-MARKER";
        let parentDenied = false;
        const stream: StreamFn = async function* (_m, messages) {
          const goal = userGoal(messages);
          const toolMsgs = messages.filter((m) => m.role === "tool");
          const outs = toolOutputs(messages);
          if (goal.startsWith("CHILD")) {
            if (toolMsgs.length === 0) { yield { type: "turn", turn: toolTurn([{ id: "c1", tool: "bash", args: { command: `echo ${MARKER}` } }]) }; return; }
            yield { type: "turn", turn: textTurn(`CHILD-SAW ${outs.join(" ")}`) };
            return;
          }
          if (toolMsgs.length === 0) { yield { type: "turn", turn: toolTurn([{ id: "p1", tool: "bash", args: { command: "echo PARENT-BASH-MARKER" } }]) }; return; }
          if (toolMsgs.length === 1) { yield { type: "turn", turn: toolTurn([{ id: "p2", tool: "task", args: { action: "start", goal: "CHILD run a shell command", label: "child" } }]) }; return; }
          if (toolMsgs.length === 2) { yield { type: "turn", turn: toolTurn([{ id: "p3", tool: "task_status", args: { action: "result", id: "t1", timeout_ms: 20_000 } }]) }; return; }
          parentDenied = (outs[0] ?? "").includes("Permission denied");
          const childResult = outs[2] ?? "";
          const blocked = parentDenied && childResult.includes("Permission denied");
          yield { type: "turn", turn: textTurn(blocked ? "SPAWN-BYPASS-BLOCKED" : `LEAKED child=${childResult}`) };
        };
        const t = await bootRun({ cwd: workspace, home: join(workspace, "home"), stream, prompt: "PARENT delegate a shell command", yolo: true });
        return { ...t, finalText: `${t.finalText} parentDenied=${parentDenied}` };
      },
      verify: (_w, t) => t.finalText.includes("SPAWN-BYPASS-BLOCKED")
        && t.finalText.includes("parentDenied=true") // the control: under yolo only this hook can deny the parent's bash
        && !t.finalText.includes("CHILD-BASH-MARKER") && !t.finalText.includes("PARENT-BASH-MARKER"),
    },

    // 3) External-lane gate: with ROVECODE_LANES_ALLOW unset, `task start {agent:"codex"}` is refused
    //    BEFORE any process spawns; with the lane allowed but a pre_tool hook denying `task`, still
    //    nothing runs. The fake lane seam (RuntimeOptions.lanes) writes a sentinel iff it ever spawns.
    //    Mutation: make laneRefusal (lanes/registry.ts) return null → phase 1's lane launches and the
    //    sentinel appears. CONTROL: phase 2 runs under yolo with the lane ALLOWED, so the only thing that
    //    can produce "Permission denied" for `task` is the deny-hook — LANE-HOOK-DENIED is itself the
    //    proof that hook loaded, and an untrusted hook makes phase 2 report LANE-LEAK instead.
    {
      id: "adversarial-lane-gate", category: "adversarial",
      prompt: "start an external agentic-CLI lane",
      timeoutMs: 40_000,
      setup: (root) => mkdtempSync(join(root ?? "", "rovecode-g-")),
      run: async (_task, workspace) => {
        const sentinel = join(workspace, "LANE-SPAWNED.txt");
        const spawn = gateProbeSpawn(sentinel);
        const home = join(workspace, "home");
        const p1 = join(workspace, "p1"); mkdirSync(p1, { recursive: true });
        const t1 = await bootRun({
          cwd: p1, home, stream: laneStartStream("is off", "LANE-GATED-OFF"),
          prompt: "start an external agentic-CLI lane", yolo: true, lanes: { spawn, env: {} },
        });
        const p2 = join(workspace, "p2"); mkdirSync(p2, { recursive: true });
        writeTrustedHooks(p2, home, `pre_tool(_ctx, call) { if (call.tool === "task") return { deny: "task tool disabled" }; }`);
        const t2 = await bootRun({
          cwd: p2, home, stream: laneStartStream("Permission denied", "LANE-HOOK-DENIED"),
          prompt: "start an external agentic-CLI lane", yolo: true,
          lanes: { spawn, env: { ...process.env, ROVECODE_LANES_ALLOW: "codex" } },
        });
        return {
          toolCalls: [...t1.toolCalls, ...t2.toolCalls],
          events: [...t1.events, ...t2.events],
          finalText: `${t1.finalText} | ${t2.finalText}`,
          recovered: true,
        };
      },
      verify: (workspace, t) => t.finalText.includes("LANE-GATED-OFF")
        && t.finalText.includes("LANE-HOOK-DENIED") // also the control: only the deny-hook can say this here
        && !existsSync(join(workspace, "LANE-SPAWNED.txt")),
    },
  ];
}
