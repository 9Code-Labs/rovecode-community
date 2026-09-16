/** The three tools that read and stop background shell jobs (port #55): `bash_list`, `bash_output`,
 *  `bash_kill`. The job manager itself is tools/bash-jobs.ts; starting a job is `bash` with a flag.
 *
 *  WHY THREE READ/WRITE TOOLS AND NOT ONE. A model that starts a four-minute build has to be able to
 *  ask three different questions — what is still running, what has it printed since I last looked, and
 *  stop it — and folding them into one tool with an `action` argument means every call carries an
 *  argument that could be wrong. The cost is three schema entries; the benefit is that each call says
 *  what it does.
 *
 *  `bash_output` returns only what is NEW since the previous read, so a model polling a build sees the
 *  next hundred lines rather than the same first hundred again. That is the single most important
 *  property here: a tool that re-sends its whole buffer every time turns a long build into a context
 *  leak, and the model cannot tell the repeat from real progress. When the ring dropped output the
 *  reader had not yet seen, the read SAYS how much it lost — a gap a model is told about can be worked
 *  around; a silent one is read as the command having printed nothing. */

import type { Tool, ToolOutput } from "../core/types.ts";
import { jobManager, type JobInfo } from "./bash-jobs.ts";

const NO_MANAGER = "background jobs are not available on this surface";

function describe(j: JobInfo, now: number): string {
  const secs = Math.round(((j.finishedAt ?? now) - j.startedAt) / 1000);
  const code = j.exitCode !== undefined ? ` exit=${j.exitCode}` : "";
  const pid = j.pid !== undefined ? ` pid=${j.pid}` : "";
  const drop = j.dropped > 0 ? ` (${j.dropped} chars dropped from the buffer)` : "";
  return `${j.id} ${j.status}${code}${pid} ${secs}s — ${j.command}${drop}`;
}

export const bashListTool: Tool = {
  schema: {
    name: "bash_list",
    description:
      "List this session's background shell jobs (started with `bash … run_in_background: true`): id, status, exit code, pid, elapsed and the command. " +
      "A finished job stays listed until its output has been read at least once, so nothing you started disappears unseen.",
    args: { type: "object", properties: {} },
  },
  kind: "read",
  execute(_args, _ctx): Promise<ToolOutput> {
    const m = jobManager();
    if (!m) return Promise.resolve({ ok: false, output: NO_MANAGER });
    const jobs = m.list();
    if (jobs.length === 0) return Promise.resolve({ ok: true, output: "no background jobs in this session" });
    const now = Date.now();
    return Promise.resolve({ ok: true, output: jobs.map((j) => describe(j, now)).join("\n"), data: jobs });
  },
};

export const bashOutputTool: Tool = {
  schema: {
    name: "bash_output",
    description:
      "Read what a background job has printed SINCE YOUR LAST READ of it (not the whole buffer — repeated reads show progress, never the same lines twice). " +
      "Says `more output remains` when the job printed more than one read returns, and says how many characters were dropped if the job outran its buffer. " +
      "Do not poll in a tight loop: a finished job also posts one note into this conversation by itself.",
    args: { type: "object", properties: { id: { type: "string", description: "job id from bash_list (e.g. b1)" } }, required: ["id"] },
  },
  kind: "read",
  execute(args, _ctx): Promise<ToolOutput> {
    const m = jobManager();
    if (!m) return Promise.resolve({ ok: false, output: NO_MANAGER });
    const id = String((args as { id: string }).id ?? "").trim();
    if (id === "") return Promise.resolve({ ok: false, output: "bash_output needs an id (bash_list shows them)" });
    const r = m.read(id);
    if (!r.ok) return Promise.resolve({ ok: false, output: r.reason });
    const head = describe(r.info, Date.now());
    const lost = r.lost > 0 ? `\n[${r.lost} characters were dropped from this job's buffer before you read them]` : "";
    const more = r.more ? "\n[more output remains — read again]" : "";
    const body = r.text === "" ? "(nothing new)" : r.text;
    return Promise.resolve({ ok: true, output: `${head}${lost}\n${body}${more}`, data: r.info });
  },
};

export const bashKillTool: Tool = {
  schema: {
    name: "bash_kill",
    description:
      "Stop a background job and everything it started (the process TREE, not just the shell — a killed `npm run dev` must not leave its port bound). " +
      "Killing an already-finished job is not an error. Its output stays readable afterwards.",
    args: { type: "object", properties: { id: { type: "string", description: "job id from bash_list (e.g. b1)" } }, required: ["id"] },
  },
  kind: "execute",
  execute(args, _ctx): Promise<ToolOutput> {
    const m = jobManager();
    if (!m) return Promise.resolve({ ok: false, output: NO_MANAGER });
    const id = String((args as { id: string }).id ?? "").trim();
    if (id === "") return Promise.resolve({ ok: false, output: "bash_kill needs an id (bash_list shows them)" });
    const r = m.kill(id);
    if (!r.ok) return Promise.resolve({ ok: false, output: r.reason ?? `could not kill "${id}"` });
    return Promise.resolve({ ok: true, output: `${id} ${r.info?.status ?? "killed"} — its output is still readable with bash_output ${id}`, data: r.info });
  },
};

export const bashJobTools: readonly Tool[] = [bashListTool, bashOutputTool, bashKillTool];
