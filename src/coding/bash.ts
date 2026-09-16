/** The bash tool (ports #10, #21, #55). Runs a shell command through the Executor seam — the probed rung
 *  (direct / wsl / docker) shapes the argv, and the abort path is the rung's tree kill (Windows Job Object
 *  + taskkill sweep; SIGTERM to the process group on POSIX).
 *
 *  It lived at the end of coding/hashline.ts until #55 gave it a timeout and a background flag. That file
 *  is the anchored-edit implementation; shell execution had simply drifted into its last fifty lines.
 *  hashline.ts re-exports `bashTool`, so the ten files importing it from there are untouched.
 *
 *  ONE TOOL, THREE SHAPES, and the reason it is one tool rather than three: policy runs UPSTREAM of
 *  execute() — the permission rules, execpolicy, the hooks and the human approval all decide before this
 *  function is entered. A separate `bash_background` tool would be a second door onto the same room, and
 *  every rule written for `bash` would have to be written again for it.
 *    plain              await it, one automatic retry on a non-zero exit
 *    timeout_ms         the same, with a deadline; a timed-out run KEEPS its partial output and says so
 *    run_in_background  hand it to the job manager and return the id at once (tools/bash-jobs.ts) */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { getExecutor } from "../core/executor.ts";
import { startBashJob, hasJobManager } from "../tools/bash-jobs.ts";

/** Upper bound on `timeout_ms`, so a model cannot ask for a deadline that never arrives. Ten minutes:
 *  past that the honest answer is a background job, which is the flag sitting next to it. */
export const MAX_TIMEOUT_MS = 600_000;

export const bashTool: Tool = {
  schema: {
    name: "bash",
    description:
      "Run a shell command in the workspace (cwd locked to the session cwd). One automatic retry on non-zero exit. " +
      "Destructive system commands are refused by a best-effort blocklist — this is NOT a sandbox. Output truncated to 10k chars. " +
      `\`timeout_ms\` gives up after that long and RETURNS what the command printed (max ${MAX_TIMEOUT_MS}ms); the process tree is killed. ` +
      "`run_in_background: true` returns a job id at once instead of waiting — for a dev server, a long build, a slow test run. " +
      "Read it later with bash_output (only NEW output per read), see them with bash_list, stop one with bash_kill; a finished job also posts one note here by itself.",
    args: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: `give up after this many ms and return the partial output (1..${MAX_TIMEOUT_MS}); a timeout is never retried` },
        run_in_background: { type: "boolean", description: "start it as a background job and return its id immediately (bash_output reads it)" },
      },
      required: ["command"],
    },
  },
  kind: "execute",
  sequential: true,
  async execute(args, ctx): Promise<ToolOutput> {
    const a = args as { command: string; timeout_ms?: unknown; run_in_background?: unknown };
    const cmd = String(a.command);
    const denied = deniedCommand(cmd);
    if (denied) return { ok: false, output: denied };

    // #55: the background flag is read AFTER the blocklist and BEFORE anything runs — a command we
    // would refuse in the foreground must not become startable by asking for it in the background.
    if (a.run_in_background === true) {
      if (!hasJobManager()) {
        // Deliberately a refusal, not a silent foreground run: the caller asked NOT to be blocked, and
        // quietly blocking it is the wrong answer to a request we cannot honour.
        return { ok: false, output: "background jobs are not available on this surface — drop run_in_background to run it in the foreground" };
      }
      const started = startBashJob(cmd, ctx.cwd);
      if (!started.ok) return { ok: false, output: started.reason };
      return {
        ok: true,
        output: `started background job ${started.info.id}: ${cmd}\nIt runs while you continue — do NOT poll in a loop. \`bash_output ${started.info.id}\` reads what is new; a note lands here when it finishes.`,
        data: started.info,
      };
    }

    const timeout = timeoutFrom(a.timeout_ms);
    if (timeout instanceof Error) return { ok: false, output: timeout.message };

    // port #10: shell execution goes through the Executor seam (direct/wsl/docker
    // rungs, probed not assumed). Direct rung is byte-compatible with the old
    // inline runOnce; a missing bash now returns exit=-1 instead of throwing.
    const run = async (): Promise<{ code: number; text: string; timedOut: boolean }> => {
      if (timeout === undefined) {
        const r = await getExecutor().run(cmd, ctx.cwd, ctx.signal);
        return { code: r.code, text: r.text, timedOut: false };
      }
      // The deadline aborts a controller the executor is watching, which IS the tree-kill path — the
      // same one Esc uses. A timeout that returned while the process kept running would be a lie in
      // the other direction, and on Windows it would hold the pipe open too.
      const ac = new AbortController();
      const onOuter = (): void => ac.abort();
      ctx.signal.addEventListener("abort", onOuter, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fired = false;
      try {
        timer = setTimeout(() => { fired = true; ac.abort(); }, timeout);
        const r = await getExecutor().run(cmd, ctx.cwd, ac.signal);
        return { code: r.code, text: r.text, timedOut: fired };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onOuter);
      }
    };

    let r = await run();
    // single self-contained retry — but NEVER after an abort (port #21): the kill
    // makes the exit non-zero, and a blind retry would respawn the cancelled
    // command as a detached subprocess that outlives the run. Nor after a TIMEOUT:
    // a command that needed more time than it was given needs more time, not twice.
    if (r.code !== 0 && !r.timedOut && !ctx.signal.aborted) r = await run();
    if (r.timedOut) {
      // The partial output is the whole point. A build that timed out has usually already printed the
      // reason it was slow, and throwing that away leaves the model with only "it took too long".
      return { ok: false, output: `timed out after ${timeout}ms (process tree killed; what it printed follows)\n${r.text}` };
    }
    return { ok: r.code === 0, output: `exit=${r.code}\n${r.text}` };
  },
};

/** undefined = no deadline; an Error is a refusal to be RETURNED as tool output, never thrown. */
function timeoutFrom(raw: unknown): number | undefined | Error {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return new Error(`timeout_ms must be a positive number of milliseconds (got ${JSON.stringify(raw)})`);
  if (n > MAX_TIMEOUT_MS) return new Error(`timeout_ms ${n} is longer than the ${MAX_TIMEOUT_MS}ms cap — use run_in_background for work that takes longer`);
  return Math.floor(n);
}

// ---------- Bash safety (best-effort blocklist, NOT a sandbox) ----------

/** Footgun guard on the raw command string. A determined agent bypasses it;
 *  real isolation belongs at the process/OS layer. */
const denyPatterns: RegExp[] = [
  /rm\s+(-[a-z]*\s+)*\/(\s|$)/,           // rm -rf /
  /rm\s+(-[a-z]*\s+)*\/\*/,               // rm -rf /*
  /rm\s+(-[a-z]*\s+)*(--no-preserve-root\s+)?\*(\s|$)/, // rm -rf *
  /:\(\)\s*\{/,                            // fork bomb body :(){ ...
  /\bmkfs(\.\w+)?\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /(^|[;&|\s])(sudo\s+)?format\s+(\/|[c-z]:)/i,  // windows format
  /(^|[;&|\s])(sudo\s+)?del\s+\/[fqs]/i,         // windows del /f
  /(^|[;&|\s])(sudo\s+)?rd\s+\/[sq]/i,
  /(^|[;&|\s])(sudo\s+)?remove-item\s+-(rec|r|f|force)/i,
  /\bdd\s+[^|]*of=\/dev\/(sd|nvme|hd|disk)/,  // raw disk overwrite
  />\s*\/dev\/(sd|nvme|hd|disk)/,
  /\bsudo\b.*\b(rm|mkfs|dd|shutdown|reboot|halt|format)\b/, // sudo + destructive core
];

export function deniedCommand(cmd: string): string | null {
  const hit = denyPatterns.find((re) => re.test(cmd));
  return hit
    ? `command refused by safety blocklist (matched ${hit.source}): this tool is not a sandbox; rephrase without destructive system commands`
    : null;
}

