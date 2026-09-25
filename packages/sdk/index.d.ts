/** @rovecode-labs/sdk — public type surface.
 *  The runtime types (RunEvent, TaskInfo…) live in the rovecode source tree; here they are
 *  structural aliases so the SDK is usable without the AGPL source checkout. Shapes are
 *  pinned by test/unit/sdk-client.test.ts in rovecode-community. */

export type TaskId = string;
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** The agent loop's event union (run_start, turn_start, tool_call_*, turn_end, run_end, …). */
export type RunEvent = { type: string; [key: string]: unknown };
export type StreamFn = (...args: never[]) => unknown;
export type ApprovalFn = (req: unknown) => Promise<unknown> | unknown;

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
  /** project root; default process.cwd() */
  cwd?: string;
  /** inject a provider stream (mockStream for tests); null = offline, omitted = resolve from config */
  stream?: StreamFn | null;
  /** pre-approve everything (deny rules still hold) */
  yolo?: boolean;
  /** approval callback; omitted = policy-only like the headless server */
  approval?: ApprovalFn;
}

export interface SessionHandle {
  readonly id: string;
  prompt(goal: string, opts?: { signal?: AbortSignal }): AsyncGenerator<SdkEvent, void>;
}

export interface SessionSummary {
  id: string;
  [key: string]: unknown;
}

export interface TaskInfo {
  id: TaskId;
  label: string;
  agent: string;
  goal: string;
  status: TaskStatus;
  depth: number;
  parent?: TaskId;
  [key: string]: unknown;
}

export interface WaitOptions {
  timeoutMs?: number;
}

export interface RovecodeClient {
  readonly cwd: string;
  session: {
    create(opts?: { id?: string }): Promise<SessionHandle>;
    list(): SessionSummary[];
  };
  task: {
    start(sessionId: string, req: { agent?: string; goal: string; label?: string; isolated?: boolean }):
      { ok: true; id: TaskId } | { ok: false; reason: string };
    list(sessionId: string): TaskInfo[];
    wait(sessionId: string, id: TaskId, opts?: WaitOptions): Promise<TaskInfo | undefined>;
    cancel(sessionId: string, id: TaskId): boolean;
  };
  agent: { tree(sessionId: string): AgentNode[] };
  events: { subscribe(fn: (e: SdkEvent) => void): () => void };
  close(): Promise<void>;
}

/** tasks.ts TaskInfo → AgentNode (parent edge: StartOptions.caller). */
export declare function agentTree(tasks: TaskInfo[]): AgentNode[];

/** One client = one engine. Boots the same runtime the CLI boots; close() releases it. */
export declare function createClient(opts?: ClientOptions): Promise<RovecodeClient>;

/** Scripted provider stream for tests — no keys, no network. */
export declare function mockStream(script: { turns: unknown[] }): StreamFn;

/** Turn builders for mockStream scripts. */
export declare function textTurn(text: string): unknown;
export declare function toolTurn(calls: unknown[], opts?: { text?: string }): unknown;
