/** External CLI agent adapters (claude-code, codex, antigravity, …): rovecode as the orchestrator.
 *
 *  One spec = how to invoke a headless CLI with a prompt and how to read its answer. Built-ins ship
 *  the three known CLIs; `~/.rovecode/agents.json` and `<cwd>/.rovecode/agents.json` (project wins)
 *  add or override entries, so any CLI with a non-interactive mode joins without a code change:
 *
 *    { "agents": { "aider": { "command": ["aider", "--message", "{prompt}", "--yes"], "format": "text" } } }
 *
 *  `{prompt}` inside command is replaced by the prompt; without it the prompt is the LAST argv
 *  element. `promptVia: "stdin"` pipes the prompt on stdin instead (no argv length ceiling).
 *  Processes run through the executor's runner (core/executor.ts: Windows tree-kill, abort grace),
 *  never through a shell — argv form means quoting/injection is not a thing here. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { bunRunner, type SpawnRunner } from "../core/executor.ts";

export type ExternalAgentFormat = "claude-json" | "codex-jsonl" | "opencode-jsonl" | "text";

export interface ExternalAgentSpec {
  /** argv template; `{prompt}` is substituted, else the prompt is appended as the last element */
  command: string[];
  format: ExternalAgentFormat;
  /** "arg" (default) or "stdin" — stdin has no length ceiling and never hits argv limits */
  promptVia?: "arg" | "stdin";
  /** per-agent default timeout, seconds (the tool arg overrides) */
  timeoutSec?: number;
  /** the flag that selects the delegated agent's OWN model (claude --model, codex/opencode -m);
   *  set when the tool's `model` arg is given. Absent = the CLI keeps its own default. */
  modelFlag?: string;
  /** what the human sees in the tool description */
  note?: string;
}

/** Headless modes, verified against each CLI's own --help where installed; the rest are the vendors'
 *  documented print/exec flags, marked best-effort — if an installed binary differs, agents.json
 *  overrides the entry without a release. Every CLI that can take a prompt non-interactively belongs
 *  here; the agents.json door stays open for the rest.
 *
 *  claude: `-p` (print mode) reads the prompt from stdin when it is not an argument; --output-format
 *  json wraps the answer ({result, is_error, total_cost_usd, num_turns, …}). codex: `exec` is the
 *  non-interactive subcommand; --json emits one event per line, the agent's text is the last
 *  item.completed agent_message. opencode: `run` is the headless subcommand; --format json streams
 *  events whose text parts join into the answer (verified: run --help, 2026-09). */
export const BUILTIN_AGENTS: Record<string, ExternalAgentSpec> = {
  claude: {
    command: ["claude", "-p", "--output-format", "json"],
    format: "claude-json",
    promptVia: "stdin",
    modelFlag: "--model",
    note: "Claude Code (print mode; full tool use in the target dir)",
  },
  codex: {
    // `exec -` reads the prompt from stdin (codex exec --help): with the prompt as an argv element
    // AND a piped stdin, codex waits for stdin EOF forever — measured 2026-09-28 (a 120s timeout
    // kill on a working setup). stdin also dodges the argv length ceiling.
    command: ["codex", "exec", "--json", "--skip-git-repo-check", "-"],
    format: "codex-jsonl",
    promptVia: "stdin",
    modelFlag: "-m",
    note: "Codex CLI (exec mode, prompt on stdin, JSONL events)",
  },
  opencode: {
    command: ["opencode", "run", "--format", "json", "{prompt}"],
    format: "opencode-jsonl",
    modelFlag: "-m",
    note: "opencode (run mode, JSON events; uses opencode's OWN default model unless the delegate `model` arg sets one)",
  },
  antigravity: {
    modelFlag: "--model",
    command: ["antigravity", "run", "{prompt}"],
    format: "text",
    note: "Antigravity CLI (best-effort; override via agents.json if your build differs)",
  },
  gemini: {
    modelFlag: "-m",
    command: ["gemini", "-p", "{prompt}"],
    format: "text",
    note: "Gemini CLI (best-effort: -p print mode)",
  },
  qwen: {
    modelFlag: "-m",
    command: ["qwen", "-p", "{prompt}"],
    format: "text",
    note: "Qwen Code (best-effort: gemini-cli fork, -p print mode)",
  },
  cursor: {
    modelFlag: "-m",
    command: ["cursor-agent", "-p", "{prompt}", "--output-format", "text"],
    format: "text",
    note: "Cursor agent (best-effort: -p print mode)",
  },
  copilot: {
    modelFlag: "--model",
    command: ["copilot", "-p", "{prompt}"],
    format: "text",
    note: "GitHub Copilot CLI (best-effort: -p prompt mode)",
  },
  aider: {
    modelFlag: "--model",
    command: ["aider", "--message", "{prompt}", "--yes-always", "--no-auto-commits"],
    format: "text",
    note: "Aider (best-effort: one-shot --message; no auto-commits — rovecode reviews the diff)",
  },
};

export const DEFAULT_TIMEOUT_SEC = 600;
export const MAX_TIMEOUT_SEC = 3600;
/** a delegated run's answer is one tool result — same ceiling philosophy as tool-output-budget */
export const MAX_OUTPUT_CHARS = 50_000;
/** argv is not the place for a novel (Windows caps near 32k); stdin-capable CLIs never see this */
export const MAX_ARG_PROMPT_CHARS = 100_000;

/** ~/.rovecode/agents.json + <cwd>/.rovecode/agents.json, project wins per agent id. Malformed
 *  entries are dropped with a warning string the caller may surface — a bad file never blocks. */
export function loadAgentSpecs(cwd: string): { specs: Record<string, ExternalAgentSpec>; warnings: string[] } {
  const specs: Record<string, ExternalAgentSpec> = { ...BUILTIN_AGENTS };
  const warnings: string[] = [];
  for (const file of [join(rovecodeHome(), "agents.json"), join(cwd, ".rovecode", "agents.json")]) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
      warnings.push(`${file}: invalid JSON (${e instanceof Error ? e.message : e}) — skipped`);
      continue;
    }
    const agents = (parsed as { agents?: unknown })?.agents;
    if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
      warnings.push(`${file}: expected { "agents": { … } } — skipped`);
      continue;
    }
    for (const [id, raw] of Object.entries(agents as Record<string, unknown>)) {
      const r = raw as Record<string, unknown>;
      const cmd = r["command"];
      const format = r["format"];
      if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === "string" && c.length > 0)) {
        warnings.push(`${file}: agents.${id}.command must be a non-empty string list — entry dropped`);
        continue;
      }
      if (format !== "claude-json" && format !== "codex-jsonl" && format !== "opencode-jsonl" && format !== "text") {
        warnings.push(`${file}: agents.${id}.format must be claude-json | codex-jsonl | opencode-jsonl | text — entry dropped`);
        continue;
      }
      const spec: ExternalAgentSpec = { command: cmd as string[], format };
      if (r["promptVia"] === "stdin" || r["promptVia"] === "arg") spec.promptVia = r["promptVia"];
      const t = r["timeoutSec"];
      if (typeof t === "number" && Number.isFinite(t) && t > 0) spec.timeoutSec = Math.min(Math.floor(t), MAX_TIMEOUT_SEC);
      if (typeof r["modelFlag"] === "string" && r["modelFlag"].trim()) spec.modelFlag = r["modelFlag"].trim();
      if (typeof r["note"] === "string" && r["note"].trim()) spec.note = r["note"].trim();
      // an override of a BUILTIN id inherits what it did not say (modelFlag above all — a pinned
      // command like `[…, "-m", "x", "{prompt}"]` must not lose the ability to take `model`)
      const base = BUILTIN_AGENTS[id];
      if (base) {
        if (spec.modelFlag === undefined && base.modelFlag !== undefined) spec.modelFlag = base.modelFlag;
        if (spec.promptVia === undefined && base.promptVia !== undefined) spec.promptVia = base.promptVia;
        if (spec.timeoutSec === undefined && base.timeoutSec !== undefined) spec.timeoutSec = base.timeoutSec;
      }
      specs[id] = spec;
    }
  }
  return { specs, warnings };
}

/** the binary a spec's argv[0] resolves to, or null (Bun.which: PATH lookup, PATHEXT-aware on Windows) */
export function agentAvailable(spec: ExternalAgentSpec): string | null {
  return Bun.which(spec.command[0]!);
}

export interface ExternalRunResult {
  ok: boolean;
  /** the agent's final answer text (capped), or the error line */
  text: string;
  exitCode: number;
  durationMs: number;
  /** claude-json only: cost and turn count when the CLI reports them */
  costUsd?: number;
  turns?: number;
  timedOut?: boolean;
}

/** Parse the raw stdout per the spec's format. Falls back to text when the structured shape is
 *  absent — a CLI that changes its output must not turn every delegation into an error. */
export function parseAgentOutput(format: ExternalAgentFormat, stdout: string, stderr: string): { text: string; costUsd?: number; turns?: number; isError?: boolean } {
  if (format === "claude-json") {
    try {
      const j = JSON.parse(stdout) as { result?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number };
      if (typeof j.result === "string") {
        const out: { text: string; costUsd?: number; turns?: number; isError?: boolean } = { text: j.result };
        if (typeof j.total_cost_usd === "number") out.costUsd = j.total_cost_usd;
        if (typeof j.num_turns === "number") out.turns = j.num_turns;
        if (j.is_error === true) out.isError = true;
        return out;
      }
    } catch { /* fall through to text */ }
  }
  if (format === "codex-jsonl") {
    let last: string | undefined;
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const ev = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") last = ev.item.text;
      } catch { /* a partial line is not the answer */ }
    }
    if (last !== undefined) return { text: last };
  }
  if (format === "opencode-jsonl") {
    // opencode run --format json: one event per line; the answer is the concatenation of text parts.
    // A failed run (exit 1) carries an {"type":"error"} event — surface ITS message, not the raw JSONL
    const texts: string[] = [];
    let errMsg: string | undefined;
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const ev = JSON.parse(t) as { type?: string; part?: { type?: string; text?: string }; error?: { data?: { message?: string }; message?: string } };
        if (ev.type === "text" && typeof ev.part?.text === "string") texts.push(ev.part.text);
        if (ev.type === "error") {
          const m = ev.error?.data?.message ?? ev.error?.message;
          if (typeof m === "string") { try { errMsg = (JSON.parse(m) as { message?: string }).message ?? m; } catch { errMsg = m; } }
        }
      } catch { /* skip */ }
    }
    if (texts.length > 0) return { text: texts.join("") };
    if (errMsg !== undefined) return { text: `opencode error: ${errMsg}` };
  }
  const body = stdout.trim() || stderr.trim();
  return { text: body };
}

/** argv construction, pure: `{prompt}` substituted (else appended); the delegated agent's OWN model
 *  (delegate's `model` arg) becomes the spec's modelFlag BEFORE the prompt element — for stdin
 *  prompts that is simply the end of the argv (there is no prompt in it). */
export function buildArgv(spec: ExternalAgentSpec, prompt: string, model?: string): { argv: string[]; stdinPrompt?: string } {
  let argv: string[];
  let stdinPrompt: string | undefined;
  if (spec.promptVia === "stdin") {
    argv = [...spec.command];
    stdinPrompt = prompt;
  } else if (spec.command.includes("{prompt}")) {
    argv = spec.command.map((a) => (a === "{prompt}" ? prompt : a));
  } else {
    argv = [...spec.command, prompt];
  }
  if (model !== undefined && model.trim() !== "" && spec.modelFlag !== undefined) {
    const at = stdinPrompt !== undefined ? argv.length : argv.indexOf(prompt);
    argv.splice(at === -1 ? argv.length : at, 0, spec.modelFlag, model.trim());
  }
  return stdinPrompt !== undefined ? { argv, stdinPrompt } : { argv };
}

/** Run one delegation. Never throws: spawn failures, timeouts and non-zero exits are all data in
 *  the result — the model reads them and decides (retry, another agent, do it itself). */
export async function runExternalAgent(
  spec: ExternalAgentSpec,
  prompt: string,
  opts: { cwd: string; signal?: AbortSignal; timeoutSec?: number; runner?: SpawnRunner; model?: string },
): Promise<ExternalRunResult> {
  const t0 = Date.now();
  const timeoutSec = Math.min(opts.timeoutSec ?? spec.timeoutSec ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
  // one controller per delegation: the run's abort OR the timeout, whichever first
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
  const onOuterAbort = (): void => ac.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const viaStdin = spec.promptVia === "stdin";
    if (!viaStdin && prompt.length > MAX_ARG_PROMPT_CHARS) {
      return { ok: false, text: `prompt is ${prompt.length} chars — the argv ceiling is ${MAX_ARG_PROMPT_CHARS}; use an agent with promptVia stdin (claude) or shorten it`, exitCode: -1, durationMs: 0 };
    }
    const { argv, stdinPrompt } = buildArgv(spec, prompt, opts.model);
    const runner = opts.runner ?? bunRunner;
    // the executor's runner does not take stdin; pipe it ourselves when the spec wants it
    const r = stdinPrompt !== undefined ? await runWithStdin(argv, stdinPrompt, opts.cwd, ac.signal) : await runner(argv, { cwd: opts.cwd, signal: ac.signal });
    const durationMs = Date.now() - t0;
    const timedOut = ac.signal.aborted && !opts.signal?.aborted;
    if (r.code === -1) return { ok: false, text: r.stderr || "spawn failed", exitCode: -1, durationMs };
    const parsed = parseAgentOutput(spec.format, r.stdout, r.stderr);
    let text = parsed.text;
    if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated at ${MAX_OUTPUT_CHARS} chars]`;
    const out: ExternalRunResult = { ok: r.code === 0 && parsed.isError !== true, text, exitCode: r.code, durationMs };
    if (parsed.costUsd !== undefined) out.costUsd = parsed.costUsd;
    if (parsed.turns !== undefined) out.turns = parsed.turns;
    if (timedOut) { out.timedOut = true; out.ok = false; if (!text) out.text = `timed out after ${timeoutSec}s`; }
    return out;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** The executor's runner covers argv/cwd/signal; stdin piping is the one thing it does not do —
 *  small and local: write the prompt, close, collect (claude -p reads stdin to EOF). */
async function runWithStdin(argv: string[], input: string, cwd: string, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: process.platform === "win32" ? undefined : signal });
    const onAbort = (): void => { try { proc.kill(); } catch { /* already gone */ } };
    if (process.platform === "win32") signal.addEventListener("abort", onAbort, { once: true });
    proc.stdin.write(input);
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (process.platform === "win32") signal.removeEventListener("abort", onAbort);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
