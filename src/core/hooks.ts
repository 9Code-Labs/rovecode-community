/** Hooks v2 (port #29): a small TYPED, file-loadable hook set — ≤10 hooks, versioned (ADR-013:
 *  "no 1.8k-line extension API surface — small typed hook set, versioned").
 *
 *  Contract (HOOKS_API_VERSION 1): nine hooks, every one optional, sync or async —
 *    pre_run(ctx) · post_run(ctx, {status, summary}) · pre_tool(ctx, call) → void | {deny}
 *    post_tool(ctx, call, result) → void | {output?} · approval(ctx, req) → void | "allow" | "deny"
 *    compaction(ctx, event) · session_open(ctx) · session_close(ctx) · on_event(ctx, ev)
 *  ctx = {cwd, sessionId, runId?} and nothing else (no registry/store handles) — the surface stays
 *  tiny on purpose; a tenth hook is the budget's last slot, not a target.
 *
 *  Loading: `.rovecode/hooks.ts` or `.rovecode/hooks.js` in the project plus `~/.rovecode/hooks.{ts,js}`
 *  (ROVECODE_HOME idiom, providers/auth.ts rovecodeHome), each `export default { version: 1, hooks: {…} }`,
 *  imported with a plain `await import()` — Bun runs TypeScript natively, so there is no build step
 *  and no loader dependency. User scope runs first, project second. Wrong/missing version → skipped
 *  with a warning (version gate); a failing import → warning, never a throw. Loaded ONCE per
 *  process (Bun's module cache; a `?query` does not bust it on 1.3.14): restart rovecode to pick up
 *  edits — the projectContext rule. ROVECODE_NO_HOOKS=1 skips the files (programmatic add() still works).
 *
 *  Running: every hook call is timeout-bounded (ROVECODE_HOOK_TIMEOUT_MS, default 5000, on a REF'D
 *  timer) and isolated — a throwing or hanging hook records one bounded warning note and the run
 *  continues as if the hook had returned void. Results are validated and bounded (deny reason
 *  ≤ MAX_DENY_REASON_CHARS; post_tool may grow the tool's output by ≤ MAX_POST_TOOL_GROWTH_CHARS).
 *  pre_tool / post_tool ride core/tools.ts dispatch at the existing hook seams; approval rides the
 *  ApprovalFn chain as approver() (composed in cli/runtime.ts buildCfg — see Authority); the
 *  run-level hooks ride the event stream via observer() in core/loop.ts agentLoop (pre_run /
 *  compaction / post_run awaited in order, on_event a fire-and-forget tap — port #39 OTel builds on
 *  it); session_open/close are the runtime's lifetime (cli/runtime.ts + the surfaces' close paths).
 *
 *  Authority: POLICY WINS. Permission rules (deny-default, last-match) are evaluated BEFORE pre_tool,
 *  so a hook never sees — and can never "un-deny" — a rule-rejected call; pre_tool can only deny,
 *  and its deny applies in every mode including yolo (a hook is the user's own stricter layer). The
 *  approval hook stands in for the HUMAN — literally: approver(human) is an ApprovalFn that buildCfg
 *  composes INSIDE execPolicyApprover, so the order is permission rules → execpolicy argv
 *  classification (port #9: forbidden → deny before any hook or human; allow-listed → runs, nobody
 *  asked) → approval hook → human. Consulted only on a policy "prompt" with nothing cached; "allow"
 *  is a one-shot yes (never cached), "deny" denies (the chain's deny shape, as execpolicy's), void →
 *  the human, or fail closed when there is none (headless). A hook "allow" is exactly as strong as
 *  the human's "once" — never stronger than policy or execpolicy. A failing/timed-out hook cannot
 *  deny (fail-open to policy, which already ran).
 *
 *  TRUST (gated since 2026-09-07, core/trust.ts): hooks are code executed in-process with the user's
 *  privileges — the worst thing a checkout can carry, because there is no spawn to classify and no
 *  execpolicy to consult. The HOME file is the user's own and always loads. The PROJECT file loads only
 *  when this machine approved its current bytes (`rovecode trust`; the same digest store as project
 *  mcp.json and plugins); the gate is asked BEFORE the import, on the whole file, so a refusal is never a
 *  partial load — one warning names the file and stays off. .rovecode/commands/*.md are prompt text, not
 *  executables: a different class of gate, not this one.
 *
 *  Sources (pattern references, no code copied; both MIT — covered by the generic MIT credit in the
 *  THIRD_PARTY_NOTICES.md preamble, no per-port entry as MIT sources are credited in module headers):
 *  - pi @ 853a80d packages/coding-agent/src/core/extensions — loader.ts:498-510 imports the
 *    extension module (jiti there) and reads its default export; runner.ts:851-884 emit() runs
 *    handlers in registration order with a per-handler try/catch → emitError (isolation);
 *    runner.ts:982-1004 emitToolCall: the first `block` result wins; types.ts:1125-1131
 *    ToolCallEventResult {block, reason}; types.ts:1144-1149 ToolResultEventResult replaces the
 *    result content; types.ts:1247 a handler may be sync or async.
 *  - opencode @ ebece6e packages/opencode/src/plugin — loader.ts:135-145 load() is a plain
 *    `await import(entry)` returning {ok:false, error} instead of throwing; loader.ts:203-236 failed
 *    entries are dropped and the successful order preserved; index.ts:284-297 trigger() runs each
 *    plugin's hook sequentially and later hooks see earlier mutations; index.ts:226-243 a plugin
 *    that fails to apply is logged and skipped.
 *  Deviations: an explicit `version` gate (upstream file plugins have none — opencode's compatibility
 *  check is npm-only, loader.ts:123-131); a per-call timeout (neither upstream bounds a hook);
 *  validated + bounded results; nine hooks instead of pi's ~45 events / opencode's open Hooks map. */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApprovalFn, ApprovalRequest, RunEvent, ToolOutput } from "./types.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { isTrustedFile, untrustedFileNote } from "./trust.ts";

export const HOOKS_API_VERSION = 1;
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;
export const MAX_DENY_REASON_CHARS = 400;
export const MAX_POST_TOOL_GROWTH_CHARS = 16_000;
const MAX_WARNINGS = 50;
const MAX_WARNING_CHARS = 300;

// ---------- contract ----------

export interface HookCtx { cwd: string; sessionId: string; runId?: string }
export interface HookToolCall { id: string; tool: string; args: unknown }
export interface RunResult { status: "done" | "stopped" | "error" | "budget"; summary: string }
export type CompactionEvent = Extract<RunEvent, { type: "compaction" }>;
type Hook<A extends unknown[], R = void> = (ctx: HookCtx, ...args: A) => Promise<R | void> | R | void;

/** The whole surface. Adding a member here is an API version bump (HOOKS_API_VERSION). */
export interface HookSet {
  /** run start, after run_start is produced (ctx.runId set) and before the first model turn */
  pre_run?: Hook<[]>;
  /** run end, awaited BEFORE run_end reaches the consumer (so it lands before a cmdRun exit); a run whose
   *  CONSUMER closed the generator first (serve disconnect, ACP cancel, TUI Esc) gets it once as {stopped, "run aborted"} */
  post_run?: Hook<[result: RunResult]>;
  /** before a tool executes, after policy allowed it; {deny} fails the call with this reason */
  pre_tool?: Hook<[call: HookToolCall], { deny: string }>;
  /** after a tool ran; {output} replaces what the model sees (growth-bounded), {} = unchanged */
  post_tool?: Hook<[call: HookToolCall, result: ToolOutput], { output?: string }>;
  /** policy said prompt, execpolicy left it to a human, nothing is cached: pre-answer instead of the
   *  human ("allow" one-shot / "deny"), or void to ask them — ctx is the runtime's (no runId) */
  approval?: Hook<[req: ApprovalRequest], "allow" | "deny">;
  /** after a history compaction (the event as yielded: strategy, trigger, token counts) */
  compaction?: Hook<[event: CompactionEvent]>;
  /** once per runtime, after the hook files loaded */
  session_open?: Hook<[]>;
  /** once per runtime, at surface teardown, after in-flight on_event taps settled */
  session_close?: Hook<[]>;
  /** every RunEvent, in order, fire-and-forget (not awaited — keep it cheap; port #39 OTel tap) */
  on_event?: Hook<[ev: RunEvent]>;
}
export type HookName = keyof HookSet;
/** exhaustive by construction (`satisfies Record<HookName, 0>` rejects a missing or extra key) */
export const HOOK_NAMES = Object.keys({
  pre_run: 0, post_run: 0, pre_tool: 0, post_tool: 0, approval: 0, compaction: 0, session_open: 0, session_close: 0, on_event: 0,
} satisfies Record<HookName, 0>) as HookName[];
/** shape of a hooks file's default export */
export interface HookModule { version: number; hooks: HookSet }
export type HookArgs<K extends HookName> = Parameters<NonNullable<HookSet[K]>>;
/** what a hook may decide (its non-void return), validated + bounded by the runner */
export type HookDecision<K extends HookName> = Exclude<Awaited<ReturnType<NonNullable<HookSet[K]>>>, void>;

// ---------- loader ----------

export interface LoadedHooks { hooks: HookSet[]; sources: string[]; warnings: string[] }

/** Load `<home>/hooks.{ts,js}` (user, first) and `<cwd>/.rovecode/hooks.{ts,js}` (project, second).
 *  Never throws: every failure is a warning line naming the file. hooks[i] came from sources[i]. */
export async function loadHooks(cwd: string, opts: { home?: string; timeoutMs?: number; trusted?: (file: string) => boolean } = {}): Promise<LoadedHooks> {
  const out: LoadedHooks = { hooks: [], sources: [], warnings: [] };
  if (process.env.ROVECODE_NO_HOOKS === "1") return out;
  const home = opts.home ?? rovecodeHome();
  // THE TRUST GATE (core/trust.ts, 2026-09-07): the project file is code from a checkout, imported in-process with the
  // person's privileges — asked BEFORE the import, on the whole file, so a refusal is never a partial load. The home
  // file is the person's own and is never gated.
  const trusted = opts.trusted ?? ((file: string) => isTrustedFile(home, file));
  const seen = new Set<string>();
  for (const [scope, dir] of [["user", home], ["project", join(cwd, ".rovecode")]] as const) {
    const file = pickHookFile(dir, out.warnings);
    if (file === null || seen.has(resolve(file))) continue; // home inside cwd/.rovecode: one load
    seen.add(resolve(file));
    if (scope === "project" && !trusted(file)) {
      out.warnings.push(untrustedFileNote(file, "its hooks stay off (they would run code from this repo in-process, with your privileges)"));
      continue;
    }
    const set = await importHookSet(file, opts.timeoutMs ?? hookTimeoutMs(), out.warnings);
    if (set) { out.hooks.push(set); out.sources.push(file); }
  }
  return out;
}

function pickHookFile(dir: string, warnings: string[]): string | null {
  const ts = join(dir, "hooks.ts"), js = join(dir, "hooks.js");
  const hasTs = existsSync(ts), hasJs = existsSync(js);
  if (hasTs && hasJs) warnings.push(`${js}: ignored — ${ts} takes precedence`);
  return hasTs ? ts : hasJs ? js : null;
}

async function importHookSet(file: string, timeoutMs: number, warnings: string[]): Promise<HookSet | null> {
  let mod: unknown;
  try {
    mod = await withTimeout(import(pathToFileURL(file).href), timeoutMs);
  } catch (e) {
    warnings.push(`${file}: failed to load — ${errText(e)}`);
    return null;
  }
  if (mod === TIMED_OUT) { warnings.push(`${file}: load timed out after ${timeoutMs}ms (top-level await?) — skipped`); return null; }
  return validateModule(file, isRecord(mod) ? mod["default"] : undefined, warnings);
}

/** default export → HookSet; the version gate lives here. Unknown/non-function members are
 *  dropped with a warning, the rest kept (a typo must not silently disable the whole file). */
function validateModule(file: string, dflt: unknown, warnings: string[]): HookSet | null {
  if (!isRecord(dflt)) { warnings.push(`${file}: default export must be { version: ${HOOKS_API_VERSION}, hooks: {…} } — skipped`); return null; }
  if (dflt["version"] !== HOOKS_API_VERSION) {
    const v = dflt["version"]; // a string "1" is shown quoted, never disguised as the supported number
    const shown = v === undefined ? "missing" : typeof v === "string" ? JSON.stringify(v) : String(v);
    warnings.push(`${file}: hooks API version ${shown} is not supported (this rovecode speaks ${HOOKS_API_VERSION}) — skipped`);
    return null;
  }
  if (!isRecord(dflt["hooks"])) { warnings.push(`${file}: "hooks" must be an object of hook functions — skipped`); return null; }
  const set: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(dflt["hooks"])) {
    if (!(HOOK_NAMES as string[]).includes(name)) { warnings.push(`${file}: unknown hook "${name}" ignored (known: ${HOOK_NAMES.join(", ")})`); continue; }
    if (typeof fn !== "function") { warnings.push(`${file}: hook "${name}" is not a function — ignored`); continue; }
    set[name] = fn;
  }
  return set as HookSet;
}

/** ROVECODE_HOOK_TIMEOUT_MS: blank/invalid/< 1 → default. */
export function hookTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env["ROVECODE_HOOK_TIMEOUT_MS"] ?? "");
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_HOOK_TIMEOUT_MS;
}

// ---------- runner ----------

/** the loop's per-run view; close() = the run ended WITHOUT a run_end (consumer-closed generator) */
export interface RunObserver { observe(ev: RunEvent): Promise<void>; close(): Promise<void> }
export interface HookRunnerOptions { timeoutMs?: number; onWarning?: (note: string) => void }

/** Holds the hook sets of one runtime and runs them: sets in attach order, per call a ref'd timeout
 *  + try/catch isolation, results validated. Decision hooks: the first decisive result wins
 *  (pi emitToolCall), except post_tool which chains (each set sees the previous output). */
export class HookRunner {
  /** bounded log of load/runtime notes (also streamed to onWarning) */
  readonly warnings: string[] = [];
  readonly timeoutMs: number;
  private readonly entries: { source: string; set: HookSet }[] = [];
  private loading: Promise<void> | null = null;
  private opened = false;
  private closing: Promise<void> | null = null;
  private readonly pending = new Set<Promise<void>>();
  private listener: ((note: string) => void) | undefined;

  constructor(private readonly base: HookCtx, opts: HookRunnerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? hookTimeoutMs();
    this.listener = opts.onWarning;
  }

  /** attach a set programmatically (port #39 OTel) — before the first run; session_open is open()'s */
  add(set: HookSet, source = "programmatic"): void { this.entries.push({ source, set }); }
  get size(): number { return this.entries.length; }
  has(name: HookName): boolean { return this.entries.some((e) => typeof e.set[name] === "function"); }
  /** settles when the hook files are attached and session_open has run; run() waits for it */
  get ready(): Promise<void> { return this.loading ?? Promise.resolve(); }

  /** load the hook files (background import) then fire session_open ONCE; idempotent */
  open(cwd = this.base.cwd, opts: { home?: string } = {}): Promise<void> {
    if (this.opened) return this.ready;
    this.opened = true;
    const load = loadHooks(cwd, { ...opts, timeoutMs: this.timeoutMs }).then(async (loaded) => {
      loaded.hooks.forEach((set, i) => this.add(set, loaded.sources[i] ?? "file"));
      for (const w of loaded.warnings) this.warn(w);
      await this.dispatch("session_open", [this.base]);
    }).then(() => { this.loading = null; });
    this.loading = load;
    return load;
  }

  /** run one hook across all sets (waits for open() first, so no caller can race the load) */
  async run<K extends HookName>(name: K, ...args: HookArgs<K>): Promise<HookDecision<K> | undefined> {
    if (this.loading) await this.loading;
    return this.dispatch(name, args);
  }

  private async dispatch<K extends HookName>(name: K, args: HookArgs<K>): Promise<HookDecision<K> | undefined> {
    let decision: HookDecision<K> | undefined;
    for (const entry of this.entries) {
      const fn = entry.set[name];
      if (typeof fn !== "function") continue;
      const raw = await this.invoke(entry.source, name, fn as (...a: unknown[]) => unknown, args);
      const d = normalize(name, raw, args, (w) => this.warn(`${entry.source}: ${w}`));
      if (d === undefined) continue;
      if (name !== "post_tool") return d; // first decisive result wins
      decision = d; // post_tool chains: the next set sees this set's output
      const cur = args as unknown as [HookCtx, HookToolCall, ToolOutput];
      const next = (d as { output?: string }).output;
      if (next !== undefined) cur[2] = { ...cur[2], output: next };
    }
    return decision;
  }

  /** one hook function: sync throw, async rejection and timeout all become `undefined` + a note */
  private invoke(source: string, name: HookName, fn: (...a: unknown[]) => unknown, args: readonly unknown[]): Promise<unknown> {
    let p: Promise<unknown>;
    try { p = Promise.resolve(fn(...args)); }
    catch (e) { this.warn(`${source}: ${name} hook threw: ${errText(e)} — ignored, run continues`); return Promise.resolve(undefined); }
    return withTimeout(p, this.timeoutMs).then(
      (v) => {
        if (v !== TIMED_OUT) return v;
        this.warn(`${source}: ${name} hook timed out after ${this.timeoutMs}ms — ignored, run continues`);
        return undefined;
      },
      (e) => { this.warn(`${source}: ${name} hook threw: ${errText(e)} — ignored, run continues`); return undefined; },
    );
  }

  /** per-run view for the loop: maps the event stream onto pre_run / compaction / post_run (awaited, in
   *  order) and taps on_event for every event (fire-and-forget). close() is the loop's teardown seam
   *  (fix-wave 4, #39 MED-1): a consumer that .return()s the generator before run_end still ended the
   *  run, so post_run fires ONCE with the abort shape — after a pre_run only, never after a yielded
   *  run_end — while on_event gets nothing synthesized (it mirrors the consumer's stream exactly). */
  observer(base: { cwd: string; sessionId: string }): RunObserver {
    let ctx: HookCtx = { cwd: base.cwd, sessionId: base.sessionId };
    let ended = false;
    return {
      observe: async (ev) => {
        if (ev.type === "run_start") ctx = { ...ctx, runId: ev.runId };
        this.tap(ctx, ev);
        if (ev.type === "run_start") await this.run("pre_run", ctx);
        else if (ev.type === "compaction") await this.run("compaction", ctx, ev);
        else if (ev.type === "run_end") { ended = true; await this.run("post_run", ctx, { status: ev.status, summary: ev.summary }); }
      },
      close: async () => {
        if (ended || ctx.runId === undefined) return;
        ended = true; await this.run("post_run", ctx, { status: "stopped", summary: "run aborted" });
      },
    };
  }

  /** The approval hook as an ApprovalFn for the approver chain — cli/runtime.ts buildCfg composes
   *  execPolicyApprover(hooks.approver(human)), so this runs only for prompt-classified calls that
   *  execpolicy did not settle (header: Authority). "allow" → "once" (dispatch never caches once),
   *  "deny" → "deny", void → the human; no human (headless) → fail closed like execpolicy's prompt
   *  arm. ctx is the runtime's {cwd, sessionId}: the chain is composed per config, before any run. */
  approver(human?: ApprovalFn): ApprovalFn {
    return async (req) => {
      const pre = await this.run("approval", this.base, { ...req, args: cloneForHook(req.args), revisedArgs: cloneForHook(req.revisedArgs) });
      if (pre === "allow") return "once";
      if (pre === "deny") return "deny";
      return human ? human(req) : "deny";
    };
  }

  private tap(ctx: HookCtx, ev: RunEvent): void {
    if (!this.loading && !this.has("on_event")) return; // zero cost without an on_event hook
    const p: Promise<void> = this.run("on_event", ctx, ev).then(() => undefined, () => undefined);
    this.pending.add(p);
    void p.then(() => { this.pending.delete(p); });
  }

  /** wait for in-flight on_event taps (each bounded by the timeout) */
  async settle(): Promise<void> { await Promise.all([...this.pending]); }

  /** fire session_close ONCE (after the load and in-flight taps settle); later calls share the promise */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.loading) await this.loading;
      await this.settle();
      await this.dispatch("session_close", [this.base]);
    })();
    return this.closing;
  }

  /** subscribe a surface (cmdRun → stderr, TUI → note); buffered notes are replayed first */
  onWarning(fn: (note: string) => void): void { this.listener = fn; for (const w of this.warnings) fn(w); }
  drainWarnings(): string[] { return this.warnings.splice(0); }
  private warn(note: string): void {
    const n = clip(note, MAX_WARNING_CHARS);
    this.warnings.push(n);
    if (this.warnings.length > MAX_WARNINGS) this.warnings.shift();
    this.listener?.(n);
  }
}

// ---------- result validation + helpers ----------

/** Hooks get COPIES of a call's args and a tool's result: a hook that mutates its argument must not
 *  re-aim a call policy already evaluated, rewrite the persisted tool_call, or dodge the post_tool
 *  growth bound (which applies to the RETURNED {output} only). JSON-derived values clone; anything
 *  structuredClone rejects (never off the wire) passes through as is rather than failing the call. */
export function cloneForHook<T>(v: T): T { try { return structuredClone(v); } catch { return v; } }

function normalize<K extends HookName>(name: K, raw: unknown, args: HookArgs<K>, warn: (w: string) => void): HookDecision<K> | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (name) {
    case "pre_tool": {
      const deny = isRecord(raw) ? raw["deny"] : undefined;
      if (typeof deny === "string" && deny.trim().length > 0) return { deny: clip(deny.trim(), MAX_DENY_REASON_CHARS) } as HookDecision<K>;
      break;
    }
    case "approval":
      if (raw === "allow" || raw === "deny") return raw as HookDecision<K>;
      break;
    case "post_tool": {
      if (!isRecord(raw)) break;
      if (raw["output"] === undefined) return undefined; // {} = leave the output alone
      if (typeof raw["output"] !== "string") break;
      const original = (args as unknown as [HookCtx, HookToolCall, ToolOutput])[2].output;
      return { output: boundGrowth(raw["output"], original.length) } as HookDecision<K>;
    }
    default:
      return undefined; // void hooks: a stray return value is not an error
  }
  warn(`${name} hook returned an invalid result (${describe(raw)}) — ignored`);
  return undefined;
}

/** a hook may replace the output outright, but may not GROW it past the original by more than the cap */
function boundGrowth(text: string, originalLen: number): string {
  const cap = originalLen + MAX_POST_TOOL_GROWTH_CHARS;
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n… [post_tool output truncated: hooks may add at most ${MAX_POST_TOOL_GROWTH_CHARS} chars]`;
}

const TIMED_OUT: unique symbol = Symbol("rovecode.hook.timeout");
/** resolves TIMED_OUT after ms on a REF'D timer (Bun unrefs AbortSignal.timeout — providers/retry.ts
 *  sleepMs / tools/webfetch.ts idiom); the original promise's later settle is ignored */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => resolvePromise(TIMED_OUT), ms);
    (timer as unknown as { ref?: () => void }).ref?.();
    p.then((v) => { clearTimeout(timer); resolvePromise(v); }, (e: unknown) => { clearTimeout(timer); rejectPromise(e); });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function clip(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max) + "…"; }
/** Bun's BuildMessage/ResolveMessage are not Error instances but carry .message */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (isRecord(e) && typeof e["message"] === "string") return e["message"];
  return String(e);
}
function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(clip(v, 40));
  if (Array.isArray(v)) return "array";
  if (isRecord(v)) return `object with keys ${Object.keys(v).slice(0, 5).join(",") || "(none)"}`;
  return typeof v;
}
