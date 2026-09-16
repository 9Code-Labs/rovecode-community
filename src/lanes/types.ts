/** External agentic-CLI lanes (port #47): the adapter contract between rovecode's TaskManager and a
 *  headless coding CLI — claude code, codex, opencode, antigravity (`agy`). Source: the user's own
 *  notes, sextant docs/agentic-clis.md §1 (adapter = command() + parse() + resume()) and §3 (the
 *  event → lane mapping table); flags verified against the official docs on 2026-09-02.
 *  A lane is a JOB of core/tasks.ts (TaskInfo.kind "external"), never a second loop (ADR-003/013):
 *  the CLI's JSONL stdout becomes LaneEvents, the events become TaskInfo updates, the process rides
 *  the executor's tree-kill path (lanes/process.ts over core/win-job.ts), and the lane works in its
 *  OWN git worktree whose diff merges back as a patch — exactly like an isolated child. */

import type { TokenUsage } from "../core/types.ts";
import type { LaneProgress } from "./progress.ts";

export type AdapterId = "claude" | "codex" | "opencode" | "agy";
export const ADAPTER_IDS: readonly AdapterId[] = ["claude", "codex", "opencode", "agy"];
export const isAdapterId = (s: unknown): s is AdapterId =>
  typeof s === "string" && (ADAPTER_IDS as readonly string[]).includes(s);

export interface LaneTask { goal: string; label?: string }

export interface LaneOpts {
  /** the lane's working directory — its OWN isolated worktree, never the parent tree */
  cwd: string;
  /** claude: `--allowedTools` rules ("Read", "Bash(npm test)"); the other CLIs have no allowlist flag */
  allowlist?: string[];
  /** claude: pass `--bare` (the table's CI shape — auth is STRICTLY `ANTHROPIC_API_KEY`; the CLI's own
   *  login is never read). Default true; the registry sets false when the lane env has no key so the
   *  lane runs on the CLI's login instead (verified 2026-09-03: `--bare` without a key exits 1 at once,
   *  `apiKeySource: "none"`; without `--bare` the same CLI reads its OAuth login). */
  bare?: boolean;
  /** claude: the lane env carries `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, the documented headless
   *  login; the process seam keeps it). Label only — the card's auth word becomes `oauth token` instead of
   *  `cli login`; under `--bare` the word stays `bare` (`--help`: strictly ANTHROPIC_API_KEY, the token is never read). */
  oauthToken?: boolean;
  /** codex: `--sandbox`; default workspace-write (danger-full-access is deliberately not offered) */
  sandbox?: "read-only" | "workspace-write";
  /** wall-clock cutter enforced by the runner; agy also receives it as `--print-timeout` */
  timeoutMs: number;
  model?: string;
  /** agy ONLY: an explicit allow-all adds `--dangerously-skip-permissions`; default = the soft-deny path */
  allowAll?: boolean;
  /** codex: `-o/--output-last-message` target; default = a file under the OS temp dir */
  lastMessageFile?: string;
  /** opencode: `--attach <url>` of a running `opencode serve` */
  attach?: string;
  /** continue a previous lane session (`--resume` / `exec resume` / `-s` / `--conversation`) */
  resume?: string;
}

export interface LaneCommand { bin: string; args: string[]; env?: Record<string, string>; stdin?: string; cwd: string }

/** The lane DSL (agentic-clis.md §1/§3): what the crew board and the TaskInfo updates consume. */
export type LaneEvent =
  | { kind: "log"; text: string }
  /** `wrote` means the CLI CONFIRMED this write (a tool result, a completed change) — never merely that
   *  the path appeared in a tool's arguments. lanes/progress.ts counts files on that flag alone. */
  | { kind: "edit"; path: string; op: "edit" | "write" | "delete"; callId?: string; wrote?: true }
  | { kind: "bash"; command: string; output?: string; exitCode?: number; callId?: string }
  /** a tool that is neither a file edit nor a shell command (read, grep, todo, a CLI's own) — kept as a
   *  COUNTABLE event rather than folded into `log`, so "12 tool calls" includes the twenty greps a lane
   *  really made instead of silently reading zero */
  | { kind: "tool"; name: string; detail?: string; callId?: string }
  | { kind: "ask"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "done"; summary: string; sessionId?: string }
  | { kind: "fail"; error: string; sessionId?: string }
  | { kind: "usage"; usage: TokenUsage };

export interface LaneParseState {
  /** lines that were not JSON objects with a `type` — skipped and counted, never thrown */
  garbage: number;
  /** the CLI's own session/thread/conversation id, for resume() */
  sessionId?: string;
  /** the last agent text seen: the summary fallback when the terminal event carries none */
  lastText?: string;
  /** adapter scratch (pending tool ids and their paths, partial text, dedupe keys) */
  scratch: Record<string, unknown>;
}
export const newParseState = (): LaneParseState => ({ garbage: 0, scratch: {} });

export interface AgentAdapter {
  id: AdapterId;
  /** SIGINT finishes the current turn for this CLI: the runner interrupts first, kills after a grace */
  interruptFirst: boolean;
  /** dry-run-able argv — EXACTLY the flags of agentic-clis.md §2, no process started */
  command(task: LaneTask, opts: LaneOpts): LaneCommand;
  /** one stdout line → zero or more lane events; garbage is skipped and counted, never thrown */
  parse(line: string, st: LaneParseState): LaneEvent[];
  /** continue the CLI's own session with a follow-up prompt */
  resume?(sessionId: string, followUp: string, opts: LaneOpts): LaneCommand;
  /** the lane's OWN permission flags, stated on the approval card BEFORE the lane starts */
  permissionSummary(opts: LaneOpts): string;
  /** attached to a `done` whose worktree diff is EMPTY (agy: soft-deny exits 0 having done nothing) */
  emptyDiffNote?: string;
}

export interface LaneResult {
  status: "done" | "failed" | "cancelled";
  /** what the lane did, folded from its own events (lanes/progress.ts) — present on every outcome,
   *  including a cancel, because "it made 9 calls and wrote 2 files before you stopped it" is exactly
   *  what a cancelled lane should still be able to tell you */
  progress: LaneProgress;
  /** the CLI's final message (done); empty otherwise */
  summary: string;
  error?: string;
  usage?: TokenUsage;
  sessionId?: string;
  /** null = the process had not exited when the runner gave up waiting (abandoned pipe) */
  exitCode: number | null;
  /** bounded tail of the rendered event log (runner LOG_RING lines) */
  log: string[];
  garbage: number;
}
