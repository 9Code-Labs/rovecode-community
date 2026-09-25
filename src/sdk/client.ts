/** @rovecode/sdk — local-mode client (Faz F1, docs/design/sdk-blueprint.md §2-3).
 *
 *  ONE interface over the harness core, two planned transports: "local" imports the core
 *  in-process (this file), "remote" will speak HTTP/SSE to `rovecode serve` against the same
 *  types. The client is render-only and loop-free: every run goes through the ONE agentLoop
 *  via bootRuntime (ADR-003), exactly like cmdRun — the SDK adds a contract, not a second engine.
 *
 *  Event model: RunEvent stays untouched (session replay purity); the SDK unions it with
 *  `agent_tree_update`, synthesized from TaskManager.subscribe — the tree is derived state,
 *  not transcript, so it never enters the session JSONL. */

import { join } from "node:path";
import type { ApprovalFn, ModelRef, RunEvent, StreamFn } from "../core/types.ts";
import type { RunConfig } from "../core/types.ts";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { listSessions, SessionStore, type SessionSummary } from "../core/session.ts";
import type { TaskId, TaskInfo, TaskStatus, WaitOptions } from "../core/tasks.ts";
import { bootRuntime, type Runtime } from "../cli/runtime.ts";
import { SkillStore } from "../skills/index.ts";
import { openScopedMemory } from "../memory/scope.ts";
import type { BlockName, BlockEditResult } from "../memory/blocks.ts";
import { buildLearningGraph, type LearningGraph } from "../learning/graph.ts";
import { draftSkillFromSession, learningNudges, saveSkillDraft, type LearningNudge, type SkillDraft } from "../learning/draft.ts";

/** A node in the live subagent tree (TaskManager flattened, parent edge explicit). */
export interface AgentNode {
  id: TaskId;
  parent: TaskId | null;
  label: string;
  agent: string;
  goal: string;
  status: TaskStatus;
  depth: number;
  isolated: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

export type SdkEvent = RunEvent | { type: "agent_tree_update"; sessionId: string; tree: AgentNode[] };

export interface ClientOptions {
  cwd?: string;
  /** test seam — injected stream wins over provider resolution; null forces "no provider" */
  stream?: StreamFn | null;
  /** permission level: true = "auto" (yolo). Default "ask" + the approval callback. */
  yolo?: boolean;
  /** the SDK's human-equivalent: a request the rules mark "prompt" lands here */
  approval?: ApprovalFn;
}

export interface SessionHandle {
  readonly id: string;
  /** Run one prompt; yields the loop's events verbatim plus agent_tree_update. */
  prompt(goal: string, opts?: { signal?: AbortSignal }): AsyncGenerator<SdkEvent, void>;
}

export interface RovecodeClient {
  readonly cwd: string;
  session: {
    create(opts?: { id?: string }): Promise<SessionHandle>;
    list(): SessionSummary[];
  };
  task: {
    start(sessionId: string, req: { agent?: string; goal: string; label?: string; isolated?: boolean }): { ok: true; id: TaskId } | { ok: false; reason: string };
    list(sessionId: string): TaskInfo[];
    wait(sessionId: string, id: TaskId, opts?: WaitOptions): Promise<TaskInfo | undefined>;
    cancel(sessionId: string, id: TaskId): boolean;
  };
  agent: { tree(sessionId: string): AgentNode[] };
  events: { subscribe(fn: (e: SdkEvent) => void): () => void };
  /** learning surface (Hermes-inspired, pattern-level): the graph of what the agent has
   *  learned (skills + memory chunks), skills drafted from session transcripts, and nudges
   *  pointing at repeated work worth persisting. Drafts are PROPOSALS — save is explicit. */
  learn: {
    graph(): LearningGraph;
    draftSkill(sessionId: string): SkillDraft | null;
    saveSkill(draft: SkillDraft, opts?: { overwrite?: boolean }): { ok: true; path: string } | { ok: false; reason: string };
    nudges(opts?: { last?: number; minRepeat?: number }): LearningNudge[];
  };
  /** the scoped memory blocks (MEMORY = project, USER = home) the agent reads each run */
  memory: {
    read(block: BlockName): string;
    add(block: BlockName, text: string): BlockEditResult;
  };
  close(): Promise<void>;
}

/** tasks.ts TaskInfo → sdk AgentNode (parent edge: StartOptions.caller). */
export function agentTree(tasks: TaskInfo[]): AgentNode[] {
  return tasks.map((t) => ({
    id: t.id, parent: t.parent ?? null, label: t.label, agent: t.agent, goal: t.goal,
    status: t.status, depth: t.depth, isolated: t.isolated, createdAt: t.createdAt,
    ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
    ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
    ...(t.summary !== undefined ? { summary: t.summary } : {}),
    ...(t.error !== undefined ? { error: t.error } : {}),
  }));
}

/** Push-queue: producers push, one consumer drains via async iteration. */
class EventQueue {
  private buf: SdkEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(e: SdkEvent): void {
    if (this.closed) return;
    this.buf.push(e);
    this.wake?.();
  }
  close(): void { this.closed = true; this.wake?.(); }
  async *drain(): AsyncGenerator<SdkEvent, void> {
    for (;;) {
      const e = this.buf.shift();
      if (e !== undefined) { yield e; continue; }
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}

export async function createClient(opts: ClientOptions = {}): Promise<RovecodeClient> {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsRoot = join(cwd, ".rovecode", "sessions");
  const runtimes = new Map<string, Runtime>();
  const listeners = new Set<(e: SdkEvent) => void>();
  const broadcast = (e: SdkEvent): void => { for (const fn of listeners) fn(e); };

  async function runtimeFor(id: string): Promise<Runtime> {
    const hit = runtimes.get(id);
    if (hit) return hit;
    const rtOpts = { cwd, sessionId: id, ...(opts.stream !== undefined ? { stream: opts.stream } : {}) };
    const rt = await bootRuntime(rtOpts);
    // background-task status flips become tree events, even between prompts
    rt.tasks.subscribe(() => {
      broadcast({ type: "agent_tree_update", sessionId: id, tree: agentTree(rt.tasks.list()) });
    });
    runtimes.set(id, rt);
    return rt;
  }

  function requireRuntime(id: string): Runtime {
    const rt = runtimes.get(id);
    if (!rt) throw new Error(`unknown session '${id}' — session.create() it first (SDK v1 tracks live sessions only)`);
    return rt;
  }

  // the learning/memory surface reads STORES, not a booted loop — a live session's runtime
  // (plugin skills included) wins, else a fresh SkillStore / scoped BlockStore over cwd
  function learnStores(): { skillStore: SkillStore; blocks: import("../memory/blocks.ts").BlockStore } {
    const live = [...runtimes.values()][0];
    if (live) return { skillStore: live.skillStore, blocks: live.blockStore };
    return {
      skillStore: new SkillStore(cwd),
      blocks: openScopedMemory({ cwd, sessionsDir: sessionsRoot, sessionId: "__learn__" }).blocks,
    };
  }

  return {
    cwd,
    session: {
      async create(createOpts: { id?: string } = {}): Promise<SessionHandle> {
        const id = createOpts.id ?? `sdk-${Date.now().toString(36)}`;
        const rt = await runtimeFor(id);
        const why = rt.noProviderReason();
        if (why !== null && rt.stream === null) throw new Error(`no provider: ${why}`);
        return {
          id,
          async *prompt(goal: string, pOpts: { signal?: AbortSignal } = {}): AsyncGenerator<SdkEvent, void> {
            const stream = rt.stream;
            if (stream === null) { yield { type: "run_end", status: "error", summary: rt.noProviderReason() ?? "no provider configured" }; return; }
            const model: ModelRef = rt.provider
              ? { provider: rt.provider.id, model: process.env.ROVECODE_MODEL ?? rt.provider.defaultModel ?? "gpt-4o-mini" }
              : { provider: "mock", model: "default" };
            const ac = new AbortController();
            const follow = (): void => ac.abort();
            if (pOpts.signal?.aborted) ac.abort();
            else pOpts.signal?.addEventListener("abort", follow, { once: true });
            rt.tasks.bindRun(ac.signal);
            const level = opts.yolo === true ? "auto" : "ask";
            const cfg: RunConfig = rt.buildCfg(level, opts.approval);
            const queue = new EventQueue();
            // tree updates that land DURING the prompt join its stream, so a consumer
            // of `for await (ev of session.prompt(…))` sees the whole picture
            const unsub = rt.tasks.subscribe(() => {
              queue.push({ type: "agent_tree_update", sessionId: id, tree: agentTree(rt.tasks.list()) });
            });
            // the loop runs CONCURRENTLY, pushing into the queue the generator drains:
            // loop events and background tree updates interleave in real time. The queue
            // is unbounded (events are small); the loop's own backpressure story is for
            // the wire, not for a local consumer.
            let failure: unknown;
            const run = (async (): Promise<void> => {
              try {
                for await (const ev of agentLoop(rt.buildDef(model), goal, {}, cfg, {
                  stream, registry: rt.registry, store: rt.store,
                  tools: rt.registry.list().map((t) => t.schema),
                  guard: rt.guard, planReminder: rt.planReminder, cwd: rt.cwd,
                  signal: ac.signal, hooks: rt.hooks,
                }, rt.steering)) {
                  broadcast(ev);
                  queue.push(ev);
                }
              } catch (e) {
                failure = e;
              } finally {
                queue.close();
              }
            })();
            try {
              yield* queue.drain();
            } finally {
              unsub();
              await run;
              pOpts.signal?.removeEventListener("abort", follow);
            }
            if (failure !== undefined) throw failure;
          },
        };
      },
      list(): SessionSummary[] { return listSessions(sessionsRoot); },
    },
    task: {
      start(sessionId, req) {
        const rt = requireRuntime(sessionId);
        return rt.tasks.start(
          { agent: req.agent ?? "main", goal: req.goal, isolated: req.isolated === true },
          { ...(req.label !== undefined ? { label: req.label } : {}) },
        );
      },
      list(sessionId) { return requireRuntime(sessionId).tasks.list(); },
      wait(sessionId, id, waitOpts) { return requireRuntime(sessionId).tasks.result(id, waitOpts); },
      cancel(sessionId, id) { return requireRuntime(sessionId).tasks.cancel(id) !== undefined; },
    },
    agent: {
      tree(sessionId) { return agentTree(requireRuntime(sessionId).tasks.list()); },
    },
    events: {
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    },
    learn: {
      graph() {
        const { skillStore, blocks } = learnStores();
        return buildLearningGraph({ skillStore, blocks });
      },
      draftSkill(sessionId) {
        return draftSkillFromSession(new SessionStore(sessionsRoot, sessionId));
      },
      saveSkill(draft, saveOpts) {
        return saveSkillDraft(cwd, draft, saveOpts);
      },
      nudges(nudgeOpts) {
        const { skillStore } = learnStores();
        return learningNudges({ sessionsRoot, skillStore, ...(nudgeOpts?.last !== undefined ? { last: nudgeOpts.last } : {}), ...(nudgeOpts?.minRepeat !== undefined ? { minRepeat: nudgeOpts.minRepeat } : {}) });
      },
    },
    memory: {
      read(block) { return learnStores().blocks.liveText(block); },
      add(block, text) { return learnStores().blocks.add(block, text); },
    },
    async close(): Promise<void> {
      for (const rt of runtimes.values()) {
        rt.tasks.cancelAll();
        await rt.tasks.drain(2_000);
        await rt.hooks.close();
        await rt.mcp?.close().catch(() => {});
      }
      runtimes.clear();
      listeners.clear();
    },
  };
}
