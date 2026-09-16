/** The verify gate: a run that changed files runs the project's own check before it is allowed to end "done".
 *
 *  Why: "done" is the model's silence (loop.ts, the finish check). The finish check catches the model stopping
 *  right after a failure it could see. This catches the failure it could NOT see — the edit landed, the tests it
 *  never ran are red. The check's failing part goes back to the model ONCE, the same way the finish check's
 *  message does; then the run ends with working code or with an honest "check failed: …" on run_end.
 *
 *  What is here: the runner (bounded by its own timeout, the run's abort, the executor's 10k clip), the
 *  failing-part extraction, the nudge text and the one-clause rendering. What is NOT here: deciding WHICH
 *  command runs. That is core/verify.ts (resolveVerify: configuration or an unambiguous script, never a guess),
 *  taken here as an injected function — this file never reads settings itself. No resolution = the gate does
 *  not run and run_end says "not verified: no check configured". Silence about an unverified change is the
 *  bug the finish check exists for; it is not reintroduced here.
 *
 *  Blind spot, stated rather than hidden: the gate keys on RunOutstanding.writes (successful edit/write calls).
 *  A run that changed files only through `bash` (sed, git apply, a generator) has writes 0 and is not verified —
 *  and not reported either, because a bash call that changed nothing (ls, grep, cat) looks identical from here
 *  and "not verified" on every lookup would be the noise the finish check was careful to avoid. */

import type { RunOutstanding } from "./types.ts";
import { resolveVerify, recordVerifyTiming } from "./verify.ts";

/** what the resolver (core/verify.ts) answers, in the shape this file needs: the commands to run in order,
 *  uninterpreted (targeting — "typecheck plus the tests that import the changed files" — is the resolver's
 *  business, this runner never has to understand a command); what it saw and refused, each with its reason;
 *  and, when there is nothing to run, why. */
export interface VerifyResolution {
  commands: string[];
  refused?: string[];
  /** where the commands came from ("settings", "inferred", "none") */
  source?: string;
  /** one sentence from the resolver: the file and key the answer came from, or why there is none */
  reason?: string;
}
export type VerifyResolver = (cwd: string) => VerifyResolution | null;

/** the seam, one direction: this file asks core/verify.ts, never the other way round. `resolveVerify` reads
 *  settings and the project's manifests and decides; nothing here second-guesses it. */
export const resolveForGate: VerifyResolver = (cwd) => {
  const plan = resolveVerify(cwd);
  return { commands: plan.commands, refused: plan.refused, source: plan.source, reason: plan.reason };
};

/** what one check cost, for the doctor row and the "on by default?" question (core/verify.ts timing file) */
export function noteVerifyCost(cwd: string, o: VerifyOutcome): void {
  try { if (o.ran > 0) recordVerifyTiming(cwd, o.command, o.ms); } catch { /* a timing file that cannot be written is not the run's problem */ }
}

export interface VerifyOutcome {
  /** the command that decided the outcome: the failing one, or the last one when all passed */
  command: string;
  ok: boolean;
  code: number;
  timedOut: boolean;
  ms: number;
  /** the failing part of the output — never the whole log (failingPart); "" when ok */
  failure: string;
  /** how many of the resolved commands ran (a failure stops the list) */
  ran: number;
}

/** run one command through the same executor `bash` uses; injectable for tests */
export type Exec = (cmd: string, cwd: string, signal: AbortSignal) => Promise<{ code: number; text: string }>;

export const VERIFY_TIMEOUT_MS = 120_000;
export const FAILURE_CHARS = 3_000;
const TAIL_LINES = 40;
const EARLIER_LINES = 20;

const defaultExec: Exec = async (cmd, cwd, signal) => {
  const { getExecutor } = await import("./executor.ts");
  return getExecutor().run(cmd, cwd, signal);
};

/** The part of a check's output that says what failed: the last 40 lines (test runners summarize at the end),
 *  preceded by up to 20 earlier lines that name a failure, clipped from the FRONT to `cap` chars so the summary
 *  survives. Never the whole log — 4 000 lines of test output back to the model is the same as no information. */
export function failingPart(text: string, cap = FAILURE_CHARS): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  const earlier = lines.slice(0, tailStart).filter((l) => /\b(fail|failed|failing|error|not ok|assert(ion)?|exception|panic)\b|✗|×|✘/i.test(l));
  const picked = earlier.length > EARLIER_LINES ? [...earlier.slice(0, EARLIER_LINES), `… ${earlier.length - EARLIER_LINES} more lines naming a failure`] : earlier;
  const parts = [...picked];
  if (picked.length > 0 && tailStart > 0) parts.push("…");
  parts.push(...lines.slice(tailStart));
  let out = parts.join("\n");
  if (out.length > cap) out = `[… ${out.length - cap} chars clipped]\n${out.slice(out.length - cap)}`;
  return out;
}

/** Run the resolved commands in order, stopping at the first failure. Bounded by `timeoutMs` (its own clock,
 *  combined with the run's abort). A timeout or an abort ends the command through the executor's kill path and
 *  is reported as ok:false — a timed-out check is a failed check, not a passed one. An executor that cannot run
 *  at all (no rung configured, bash missing) is a failure with that message, never a throw. */
export async function runVerify(
  res: VerifyResolution, cwd: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; exec?: Exec; clock?: () => number } = {},
): Promise<VerifyOutcome> {
  const exec = opts.exec ?? defaultExec;
  const clock = opts.clock ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const started = clock();
  let ran = 0;
  let last = res.commands[0] ?? "";
  for (const command of res.commands) {
    last = command;
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    if (opts.signal?.aborted) ac.abort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    let r: { code: number; text: string };
    try { r = await exec(command, cwd, ac.signal); }
    catch (e) { r = { code: -1, text: `could not run the check: ${e instanceof Error ? e.message : String(e)}` }; }
    finally { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); }
    ran++;
    if (timedOut) return { command, ok: false, code: r.code, timedOut: true, ms: clock() - started, failure: failingPart(r.text), ran };
    if (r.code !== 0 || opts.signal?.aborted) return { command, ok: false, code: r.code, timedOut: false, ms: clock() - started, failure: failingPart(r.text), ran };
  }
  return { command: last, ok: true, code: 0, timedOut: false, ms: clock() - started, failure: "", ran };
}

/** The one continuation turn after a failed check. A harness message, not the user's; both answers — fix it, or
 *  say plainly why it cannot be made to pass — are acceptable, and the next silence ends the run either way. */
export function verifyNudgeText(o: VerifyOutcome, timeoutMs = VERIFY_TIMEOUT_MS): string {
  const head = o.timedOut
    ? `The project's check did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped: \`${o.command}\``
    : `The project's check failed (exit ${o.code}) after your changes: \`${o.command}\``;
  return [
    "<verify-check>",
    "You stopped, but the work does not pass — this is a check by the harness, not a message from the user.",
    head,
    o.failure.trim() === "" ? "(the check produced no output)" : "Failing part of its output:\n" + o.failure,
    "Fix what your changes broke and run the check yourself, or say plainly why it cannot be made to pass. This check runs once per run; your next reply ends it either way.",
    "</verify-check>",
  ].join("\n");
}

/** one clause for the surfaces ("done · check failed (bun test): 2 tests failed") */
export function verifyClause(v: NonNullable<RunOutstanding["verify"]>): string {
  const refused = v.refused && v.refused.length > 0 ? ` · ${v.refused.length} check${v.refused.length === 1 ? "" : "s"} refused (${v.refused.join("; ")})` : "";
  // a configured check can be a whole shell line; the clause names it, the transcript carries it
  const cmd = "command" in v ? (v.command.length > 60 ? `${v.command.slice(0, 59)}…` : v.command) : "";
  switch (v.state) {
    case "unconfigured": return `not verified: ${v.reason ?? "no check configured"}${refused}`;
    case "passed": return `check passed (${cmd})${refused}`;
    case "timeout": return `check timed out after ${v.seconds}s (${cmd})${refused}`;
    case "failed": return `check failed (${cmd}): ${(v.failure.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "").slice(0, 120)}${refused}`;
  }
}

/** first line for the surfaces while it runs / when it ends (the RunEvent "verify" detail) */
export function verifyDetail(o: VerifyOutcome): string {
  if (o.ok) return `passed in ${(o.ms / 1000).toFixed(1)}s`;
  if (o.timedOut) return `timed out after ${(o.ms / 1000).toFixed(0)}s`;
  const lastLine = o.failure.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "";
  return `exit ${o.code}${lastLine ? ` — ${lastLine.slice(0, 120)}` : ""}`;
}
