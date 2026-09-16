/** The child's request on the WIRE: a task child's provider request must carry its registry's tool schemas. The REAL
 *  provider stack (createRuntime WITHOUT a stream override: providerStream → tool middleware → retry → router) talks to a
 *  loopback OpenAI-compatible server that records every request's `tools[].function.name`; the root starts `explore`
 *  (tools: read, grep) and then `main`. Before the fix (orchestrator runChild omitted LoopDeps.tools) every child request
 *  carried NO tools — a native-tool-calling model could call nothing, whatever the allow-list said; the scripted streams
 *  in the other tests ignore `tools`, which is why nobody saw it. Hermetic: env scrubbed of ROVECODE_* and *_API_KEY,
 *  ROVECODE_HOME + cwd under tmpdir, checkpoints/repo-map off, loopback only, ROVECODE_MOCK unset (a provider IS configured). */

import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { agentLoop } from "../../src/core/loop.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import type { RunEvent } from "../../src/core/types.ts";

afterEach(() => resetExecutor());

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (t !== undefined) clearTimeout(t); });
}

interface WireRequest { who: "ROOT" | "CHILD"; agent: string; model: string; tools: string[]; toolMsgs: number }
interface OpenAiMsg { role: string; content?: string | null }
interface OpenAiTool { type?: string; function?: { name: string }; name?: string }

/** scripted loopback provider: ROOT → start explore, start main, wait t1, wait t2, done; CHILD → text at once */
function scriptedServer(requests: WireRequest[]): ReturnType<typeof Bun.serve> {
  const tc = (id: string, name: string, args: unknown): Record<string, unknown> => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  return Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = await req.json() as { model: string; messages: OpenAiMsg[]; tools?: OpenAiTool[] };
      // the FIRST user message is the run's goal; task completion notes land later as further user messages (steering)
      const goal = String(body.messages.find((m) => m.role === "user")?.content ?? "");
      const who = goal.startsWith("ROOT") ? "ROOT" : "CHILD";
      const toolMsgs = body.messages.filter((m) => m.role === "tool").length;
      requests.push({ who, agent: who === "ROOT" ? "-" : goal.split(" ")[1] ?? "?", model: body.model, tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "?"), toolMsgs });
      let message: Record<string, unknown> = { content: `${who} done` };
      let finish = "stop";
      if (who === "ROOT") {
        const call = toolMsgs === 0 ? tc("r1", "task", { action: "start", agent: "explore", goal: "CHILD explore look around", label: "explore" })
          : toolMsgs === 1 ? tc("r2", "task", { action: "start", agent: "main", goal: "CHILD main look around", label: "main" })
          : toolMsgs === 2 ? tc("r3", "task_status", { action: "result", id: "t1", timeout_ms: 20_000 })
          : toolMsgs === 3 ? tc("r4", "task_status", { action: "result", id: "t2", timeout_ms: 20_000 })
          : null;
        if (call) { message = { content: null, tool_calls: [call] }; finish = "tool_calls"; }
      }
      return Response.json({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    },
  });
}

/** the child tool table's core (cli/runtime.ts childRegistry) and tools ONLY the root registry holds */
const CHILD_TABLE_CORE = ["read", "edit", "write", "bash", "glob", "grep", "ls", "task", "task_status"];
const ROOT_ONLY = ["web_fetch", "memory_edit", "todo_write", "todo_read", "ask_user"];
const SCRUB = (k: string): boolean => /^ROVECODE_/i.test(k) || /_API_KEY$/i.test(k);

test("WIRE: a definition's child request carries exactly its allow-list (explore → tools [read, grep]); `main`'s carries the child table and never a root-only tool; the root keeps the full registry; every request streams over the run's endpoint and model", async () => {
  const saved: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (SCRUB(k) && v !== undefined) { saved[k] = v; delete process.env[k]; }
  const home = mkdtempSync(join(tmpdir(), "rovecode-agents-wire-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-agents-wire-cwd-"));
  const requests: WireRequest[] = [];
  const server = scriptedServer(requests);
  try {
    mkdirSync(join(cwd, ".rovecode", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".rovecode", "agents", "explore.md"), "---\ndescription: explorer\ntools: read, grep\n---\nYou are the explorer.\n", "utf8");
    Object.assign(process.env, {
      ROVECODE_HOME: home, ROVECODE_NO_CHECKPOINTS: "1", ROVECODE_NO_REPOMAP: "1",
      ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: "gpt-4o-mini",
    });
    const rt = createRuntime({ cwd, sessionId: "agents-wire-fix" }); // NO stream override: the real provider stack over the loopback
    try {
      expect(rt.stream).not.toBeNull();
      expect(rt.agents.agents.map((a) => a.name)).toEqual(["explore"]);
      const def = rt.buildDef({ provider: rt.provider!.id, model: "gpt-4o-mini" });
      const cfg = rt.buildCfg(true);
      const events: RunEvent[] = [];
      await deadline((async () => {
        for await (const ev of agentLoop(def, "ROOT go", {}, cfg, { stream: rt.stream!, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd }, rt.steering)) events.push(ev);
      })(), 60_000, "root run");
      expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
      expect(rt.tasks.list().map((t) => [t.agent, t.status])).toEqual([["explore", "done"], ["main", "done"]]);
      const explore = requests.filter((r) => r.who === "CHILD" && r.agent === "explore");
      const main = requests.filter((r) => r.who === "CHILD" && r.agent === "main");
      const root = requests.filter((r) => r.who === "ROOT");
      expect([explore.length >= 1, main.length >= 1, root.length >= 5]).toEqual([true, true, true]);
      for (const r of explore) expect(r.tools).toEqual(["read", "grep"]); // MUTATION: `tools` dropped from runChild's LoopDeps → []
      for (const r of main) {
        expect(r.tools).toEqual(expect.arrayContaining(CHILD_TABLE_CORE));
        for (const n of ROOT_ONLY) expect(r.tools).not.toContain(n);
      }
      for (const r of root) expect(r.tools).toEqual(expect.arrayContaining([...CHILD_TABLE_CORE, ...ROOT_ONLY]));
      expect([...new Set(requests.map((r) => r.model))]).toEqual(["gpt-4o-mini"]); // children stream over the run's endpoint and model
    } finally {
      rt.tasks.cancelAll();
      await deadline(rt.tasks.drain(3_000), 5_000, "drain");
      await deadline(rt.hooks.close(), 5_000, "hooks close");
    }
  } finally {
    server.stop(true);
    for (const k of Object.keys(process.env)) if (SCRUB(k)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
