/** What a RUNNING lane has actually done (#47 follow-up): tool calls made, files written, tokens
 *  burned — folded from the same LaneEvents the log ring renders, so nothing new is parsed and nothing
 *  parsed is thrown away. Today job.ts collapses the whole stream into a log-tail string; this keeps the
 *  structure beside it so a surface can show "12 calls · 3 files · 5.3k in / 900 out" while the CLI is
 *  still running, instead of one log line whose meaning depends on which CLI produced it.
 *
 *  Three rules, each of which is a way this could lie:
 *
 *  1. A CALL IS COUNTED ONCE. Two of the four CLIs report the same call twice — codex emits
 *     `item.started` then `item.completed` for one `command_execution`, opencode updates one tool part
 *     from `running` to `completed` — so a fold that counted events would climb at twice the rate for
 *     those two and nobody would notice, because there is no independent number to compare it against.
 *     Dedupe is by the adapter's own call id (`callId`: claude's `tool_use.id`, codex's `item.id`,
 *     opencode's `callID`). An event with no id counts as its own call, which is the honest reading for
 *     agy, whose stream carries no ids at all.
 *
 *  2. A FILE IS "WRITTEN" ONLY WHEN THE CLI SAID SO. `edit` events are issued at the tool CALL for
 *     claude (a `tool_use` block), so a path appearing in one means the model asked, not that anything
 *     changed — a refused, failed or hallucinated edit looks identical. Only an event carrying
 *     `wrote: true` counts, which each adapter sets exactly where its own CLI confirms the write
 *     (claude: a `tool_result` for that call id without `is_error`; codex: a `file_change` item whose
 *     status is completed; opencode: a tool part whose state is `completed`). agy confirms nothing —
 *     its `step_update` carries no result and its own header records that `status: SUCCESS` is not
 *     proof of work — so an agy lane reports 0 files written LIVE, and that is the truthful answer to
 *     "what do we know right now" rather than a guess dressed as a count.
 *
 *  3. THE PATCH IS THE ONLY PROOF AT THE END. When the lane finishes, its worktree diff names the files
 *     that really changed (`filesFromPatch`), which no stream can contradict: it is the tree. job.ts
 *     replaces the live list with that one, so a finished lane's count is measured, and the live count
 *     is understood as "what the CLI has told us so far". For agy this is the only count it ever gets.
 *
 *  4. A MEASURED WRITE IS NOT A LANDED WRITE. Every lane writes into its OWN worktree, and only a lane
 *     that finished has its patch merged back into the parent tree. So "the diff names these files" and
 *     "these files changed in your repo" are different claims, and three reachable cases separate them:
 *     a cancelled lane, a failed one, and — the one that is easy to miss — a lane that finished cleanly
 *     whose patch would not apply, because a concurrent task had already touched the same lines. That
 *     last one still reports `ok`, so status alone cannot tell you it landed. `applied` carries the
 *     answer from the code that did the applying: absent while the lane runs (nothing has been offered
 *     to the tree yet), true once the merge-back succeeded, false when the writes stayed in a worktree
 *     that was then deleted. Anything reading `filesWritten` as "your repo changed" must read this too.
 *
 *  Usage is folded through events.ts addUsage and stays ABSENT when the CLI reported none — the same
 *  rule the OTel lane spans keep (telemetry/otel-lanes.ts): a lane that burned tokens we failed to read
 *  must not look identical to one that burned none. */

import type { TokenUsage } from "../core/types.ts";
import { addUsage } from "./events.ts";
import type { LaneEvent } from "./types.ts";

/** Paths kept by name; past this only the count grows (a thousand-file refactor must not be held in
 *  memory per lane, and no surface shows more than a handful). */
export const MAX_TRACKED_FILES = 100;

export interface LaneProgress {
  /** distinct tool calls the CLI has reported (deduped by call id; see rule 1) */
  toolCalls: number;
  /** files the CLI CONFIRMED it wrote, sorted, at most MAX_TRACKED_FILES of them (see rule 2) */
  filesWritten: readonly string[];
  /** how many confirmed writes there were in total — ≥ filesWritten.length once the cap is hit */
  filesWrittenTotal: number;
  /** absent when the CLI reported no usage at all (see the header) */
  usage?: TokenUsage;
  /** whether these files reached the PARENT tree (rule 4): absent while the lane is still running,
   *  `true` once its patch merged back, `false` when it was cancelled, failed, or finished with a patch
   *  that would not apply. Not derivable from status — a done lane's patch can still fail to apply. */
  applied?: boolean;
}

/** The running fold. One per lane; the runner owns it and hands out snapshots. */
export class LaneTally {
  private readonly calls = new Set<string>();
  /** calls with no id of their own — counted, not deduped (agy) */
  private anonymousCalls = 0;
  private readonly files = new Set<string>();
  private filesTotal = 0;
  private usage: TokenUsage | undefined;

  /** Fold one event. Anything that is not a tool call, a confirmed write or usage is ignored — a `log`,
   *  `progress`, `ask`, `done` or `fail` event tells us nothing countable, and guessing from their text
   *  is how a counter starts drifting. */
  add(ev: LaneEvent): void {
    switch (ev.kind) {
      case "edit":
        this.countCall(ev.callId);
        if (ev.wrote === true && !this.files.has(ev.path)) {
          this.filesTotal += 1;
          if (this.files.size < MAX_TRACKED_FILES) this.files.add(ev.path);
        }
        return;
      case "bash":
      case "tool":
        this.countCall(ev.callId);
        return;
      case "usage":
        this.usage = addUsage(this.usage, ev.usage);
        return;
      default:
        return;
    }
  }

  private countCall(callId: string | undefined): void {
    if (callId === undefined || callId === "") this.anonymousCalls += 1;
    else this.calls.add(callId);
  }

  /** An immutable snapshot — safe to hand to a surface that keeps it across frames. */
  snapshot(): LaneProgress {
    return {
      toolCalls: this.calls.size + this.anonymousCalls,
      filesWritten: [...this.files].sort(),
      filesWrittenTotal: this.filesTotal,
      ...(this.usage ? { usage: { ...this.usage } } : {}),
    };
  }

  /** Replace the live file list with the measured one (job.ts, once the worktree diff exists). */
  withFiles(paths: readonly string[]): LaneProgress {
    const sorted = [...new Set(paths)].sort();
    return {
      ...this.snapshot(),
      filesWritten: sorted.slice(0, MAX_TRACKED_FILES),
      filesWrittenTotal: sorted.length,
    };
  }
}

/** Files a unified diff actually changes — the proof at the end (rule 3).
 *
 *  Reads the `diff --git a/<x> b/<y>` headers rather than the `+++` lines, because a deletion's `+++` is
 *  `/dev/null` and a rename's two sides differ: `b/` is the path that exists after the patch, `a/` the
 *  one that existed before, and a delete is only visible under `a/`. Quoted paths (git quotes anything
 *  with a space or a non-ASCII byte) are unquoted; a header we cannot read is skipped rather than
 *  guessed at, so a strange path is missing from the list instead of poisoning it. */
export function filesFromPatch(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    const rest = line.slice("diff --git ".length);
    const pair = splitDiffPair(rest);
    if (pair === null) continue;
    const [a, b] = pair;
    const path = b === "/dev/null" ? a : b;
    if (path !== "" && path !== "/dev/null") out.add(path);
  }
  return [...out].sort();
}

/** `a/x b/y` → ["x", "y"], honouring git's quoting; null when the halves cannot be told apart. */
function splitDiffPair(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const close = findQuoteEnd(rest);
    if (close === -1) return null;
    const first = unquote(rest.slice(0, close + 1));
    const tail = rest.slice(close + 1).trimStart();
    const second = tail.startsWith('"') ? unquote(tail) : tail;
    return [strip(first), strip(second)];
  }
  // unquoted: split on " b/" so a path containing a space still resolves (git only quotes when it must,
  // but a repository can carry `a/my file b/my file`)
  const at = rest.indexOf(" b/");
  if (at === -1) {
    const sp = rest.indexOf(" ");
    return sp === -1 ? null : [strip(rest.slice(0, sp)), strip(rest.slice(sp + 1))];
  }
  return [strip(rest.slice(0, at)), strip(rest.slice(at + 1))];
}

const findQuoteEnd = (s: string): number => {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
};

const unquote = (s: string): string => {
  const inner = s.startsWith('"') ? s.slice(1, s.lastIndexOf('"')) : s;
  return inner.replace(/\\(.)/g, "$1");
};

/** drop the `a/` or `b/` prefix git puts on both halves */
const strip = (p: string): string => (/^[ab]\//.test(p) ? p.slice(2) : p);
