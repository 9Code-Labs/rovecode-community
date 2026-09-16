/** Interactive agent chat (omp/claude-code style): persistent session, streaming
 *  output, y/n/a approvals, slash commands. Bare `rovecode` drops here. */

import readline from "node:readline";
import { agentLoop } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import type { ApprovalFn, RunEvent } from "../core/types.ts";
import type { AskFn } from "../tools/ask-user.ts";
import { bootRuntime, NO_PROVIDER_HINT } from "./runtime.ts";
import { modeSwitchNote } from "../core/voice.ts";
import { SandboxConfigError, describeSandbox } from "../core/sandbox-config.ts";
import { WorkspaceRootError } from "../core/workspace.ts";
import { appendMemory, memoryCommand, memoryNoteLine } from "../tui/memory-note.ts";
import { runPlainGitCommand } from "../tui/git-plain.ts"; // port #65: /commit /undo on the plain REPL
import { compactNoteLines, compactSession, copyAssistantMessage } from "../tui/context-cmds.ts"; // port #53
import { expandBuiltinSlash } from "../tui/builtin-prompts.ts"; // port #53: /init
import { shellLine } from "../tui/shell-cmd.ts"; // port #78: the existing shell classifier
import { askPlainApproval, expandPlainInput, runPlainShellLine, type PlainInputDeps } from "../tui/input-plain.ts"; // port #78

export interface ReplState {
  yolo: boolean;
  provider: string;
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

// port #78: an interrupted approval must release its readline question as well as its tool call.
function ask(rl: readline.Interface, q: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.resolve("");
  return new Promise((res) => {
    const onAbort = (): void => { res(""); };
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.question(q, { signal }, (a) => {
      signal?.removeEventListener("abort", onAbort);
      res(a.trim().toLowerCase());
    });
  });
} // port #78

/** port #33: the `--plain` asker behind ask_user — `--plain` HAS a human (the y/n/a approvals prove
 *  it), headless surfaces leave the tool unbound and it fails closed. Numbered options plus free text
 *  when allowed: a number picks, other text is the typed answer, an empty line declines (null). Piped
 *  stdin is fine — it just consumes the next line. The run's abort resolves null AND is handed to
 *  rl.question itself (WIRE-1 LOW): an aborted question's callback is DISARMED, so the user's next
 *  line is a normal `line` event again instead of being swallowed by the dead callback. `out` is
 *  console.log; tests capture it. */
export function readlineAsker(rl: readline.Interface, out: (line: string) => void = console.log): AskFn {
  return (q, signal) => new Promise((resolve) => {
    const options = q.options ?? [];
    const free = q.allowFreeText !== false;
    out(`\n  question: ${q.question}`);
    options.forEach((o, i) => out(`    ${i + 1}) ${o}`));
    const hint = [options.length > 0 ? `1-${options.length}` : "", free ? "text" : ""].filter(Boolean).join(" or ");
    const onAbort = (): void => { resolve(null); };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.question(`  answer [${hint}; empty = decline]: `, { signal }, (line) => {
      signal.removeEventListener("abort", onAbort);
      const a = line.trim();
      const n = Number(a);
      if (a === "") resolve(null);
      else if (Number.isInteger(n) && n >= 1 && n <= options.length) resolve({ choice: n - 1, label: options[n - 1] });
      else if (free) resolve({ text: a });
      else { out("  (not one of the options — declined)"); resolve(null); }
    });
  });
}

export async function runRepl( /* eslint-disable-line complexity */
  opts: { yolo?: boolean; model?: string; addDirs?: readonly string[] } = {},
): Promise<void> {
  // port #27: sandbox misconfig / unavailable configured rung → one-line startup error, exit 2; a --add-dir value
  // that stopped being a directory between the parse and the boot is the same class of error (core/workspace.ts)
  const rt = await bootRuntime(opts.addDirs !== undefined && opts.addDirs.length > 0 ? { addDirs: opts.addDirs } : {}).catch((e: unknown): never => {
    if (e instanceof SandboxConfigError || e instanceof WorkspaceRootError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });

  const state: ReplState = {
    yolo: opts.yolo ?? process.env.ROVECODE_YOLO === "1",
    provider: "mock",
    model: opts.model ?? process.env.ROVECODE_MODEL ?? "",
    turns: 0, tokensIn: 0, tokensOut: 0,
  };

  // the registry is live: `rovecode provider add …` / `rovecode auth set …` from another terminal is
  // picked up on the next line — no restart and no ad-hoc base-url prompt here
  const stream = rt.stream ?? undefined;
  const adoptDefault = (): void => {
    const d = rt.providers.defaultRef();
    if (d !== null) { state.provider = d.provider; state.model = state.model || d.model || "gpt-4o-mini"; }
  };
  adoptDefault();
  if (state.provider === "mock") console.log(NO_PROVIDER_HINT);
  rt.hooks.onWarning((w) => console.error(`hooks: ${w}`)); // port #29: load + runtime hook notes → stderr (cmdRun idiom)

  console.log(`◆ rovecode here — plain chat with ${state.provider}/${state.model}`);
  console.log(`session ${rt.sessionId.slice(0, 8)} in ${rt.cwd}`);
  console.log(modeSwitchNote(state.yolo));
  console.log(`commands: /exit /new /yolo /model <provider/model> /status /skills /memory [--user] [text] /compact [focus] /copy [n] /init  ·  #<text> remembers a line`);

  console.log("input: !cmd runs through the bash tool (same policy + approval, no model turn) · @path attaches files with read/edit anchors; images ride on the next message"); // port #78
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "rovecode> " });

  rt.setAskUser(readlineAsker(rl)); // port #33: ask_user over the same readline (readlineAsker above)

  const approval: ApprovalFn = (req) => askPlainApproval((q) => ask(rl, q, running?.ac.signal), req.tool, JSON.stringify(req.revisedArgs).slice(0, 140)); // port #78: one ladder for model and shell calls

  rl.prompt();

  // port #21: one AbortController per run — Ctrl+C mid-run aborts the in-flight
  // fetch/tools for real (abort first, then return() settles the generator); idle
  // Ctrl+C keeps its old meaning (close the repl)
  let running: { ac: AbortController; gen: AsyncGenerator<RunEvent> } | null = null;
  let compacting: AbortController | null = null; // port #53: /compact's controller — Ctrl+C aborts the in-flight summarize call
  // port #78: the shell owns the same busy/interrupt lifecycle, without creating a model run.
  let closing = false; // port #78: do not prompt again after a mid-shell quit
  let shellRun: AbortController | null = null;
  let shellPending: Promise<void> | null = null;
  let gitRun: AbortController | null = null; // ports #65 + #78: git commands share the same lifecycle
  let gitPending: Promise<void> | null = null;
  let compactPending: Promise<void> | null = null;
  const busy = (): boolean => Boolean(running || compacting || shellRun || shellPending || gitRun || gitPending);
  const busyNote = (): boolean => { if (busy()) { console.log("finish or interrupt the run first (Ctrl+C)"); return true; } return false; };
  const plainInput: PlainInputDeps = { rt, yolo: () => state.yolo, busy, bindAbort: (ac) => { shellRun = ac; }, ask: (q) => ask(rl, q, shellRun?.signal), modelRef: () => ({ provider: state.provider, model: state.model }) };
  // port #78 end
  rl.on("SIGINT", () => {
    if (compacting) { compacting.abort(); console.log("\n  [interrupted]"); return; } // port #53: compaction first — a run cannot be in flight beside it (the busy gate)
    if (running) { running.ac.abort(); void running.gen.return(undefined as never); console.log("\n  [interrupted]"); }
    else if (shellRun || gitRun) { (shellRun ?? gitRun)!.abort(); console.log(`${String.fromCharCode(10)}  [interrupted]`); } // ports #65 + #78
    else rl.close();
  });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    // port #78: shell lines precede the provider check and never reach agentLoop, even with no provider.
    if (shellLine(text) !== null) {
      if (!busyNote()) {
        shellPending = runPlainShellLine(plainInput, text);
        try { await shellPending; }
        catch (e) { console.log(`error: ${e instanceof Error ? e.message : String(e)}`); }
        finally { shellPending = null; }
      }
      if (!closing) rl.prompt(); return;
    } // port #78
    if (text === "/exit" || text === "/quit") { rl.close(); return; }
    if ((text === "/new" || text === "/compact" || text.startsWith("/compact ") || text === "/commit" || text.startsWith("/commit ") || text === "/undo") && busyNote()) { rl.prompt(); return; } // port #78: do not fork the record mid-shell
    if (text === "/yolo") { state.yolo = !state.yolo; console.log(modeSwitchNote(state.yolo)); rl.prompt(); return; }
    if (text === "/status") { console.log(`provider=${state.provider} model=${state.model} turns=${state.turns} tokens=${state.tokensIn}in/${state.tokensOut}out\nsandbox: ${describeSandbox(rt.sandbox)}`); rl.prompt(); return; }
    if (text === "/skills") { for (const s of rt.skillStore.list()) console.log(`  ${s.name.padEnd(20)} ${s.description}`); rl.prompt(); return; }
    // the same two memory affordances the TUI has (tui/memory-note.ts): `/memory [--user] [text]` and the
    // `#<text>` note, which short-circuits before any model turn
    if (text === "/memory" || text.startsWith("/memory ")) { console.log(memoryCommand(rt.blockStore, text.slice("/memory".length)).text); rl.prompt(); return; }
    { const note = memoryNoteLine(text); if (note !== null) { console.log(appendMemory(rt.blockStore, "memory", note).text); rl.prompt(); return; } }
    if (text.startsWith("/model ")) {
      const ref = rt.providers.resolveSelector(text.slice(7), state.provider);
      if ("error" in ref) console.log(ref.error); else { state.provider = ref.provider; state.model = ref.model; console.log(`model → ${ref.provider}/${ref.model}`); }
      rl.prompt(); return;
    }
    if (text === "/new") { rt.store.branch(rt.store.messages()[0]?.id ?? ""); console.log("branched to session start"); rl.prompt(); return; }
    // port #65: /commit and /undo run through git-plain.ts — the SAME cmdCommit/cmdUndo as the TUI,
    // the approval card as this REPL's own y/n question. A busy run is checked below like any submit;
    // the git commands check it themselves and are refused with a note instead.
    if (text === "/undo" || text === "/commit" || text.startsWith("/commit ")) {
      gitRun = new AbortController(); // /undo has a confirmation but no tool-run controller of its own
      gitPending = runPlainGitCommand({ rt, yolo: state.yolo, approve: state.yolo ? undefined : approval, ask: (q) => ask(rl, q, gitRun?.signal), busy: () => Boolean(running || compacting || shellRun || shellPending), bindAbort: (ac) => { gitRun = ac; }, out: (l) => console.log(l) }, text);
      try { await gitPending; }
      catch (e) { console.log(`error: ${e instanceof Error ? e.message : String(e)}`); }
      finally { gitPending = null; gitRun = null; }
      if (!closing) rl.prompt();
      return;
    }
    // port #53: /compact and /copy share the TUI's helpers (context-cmds.ts) — the ONE compaction strategy
    // set (marker persisted, compacted branch durable), the same clipboard chain; /init expands below
    if (text === "/compact" || text.startsWith("/compact ")) {
      if (running || compacting) { console.log("finish or interrupt the run first (Ctrl+C)"); rl.prompt(); return; }
      const focus = text.slice("/compact".length).trim();
      compacting = new AbortController();
      compactPending = compactSession(rt.store, rt.buildCfg(state.yolo, approval), { model: { provider: state.provider, model: state.model }, signal: compacting.signal }).then((result) => { for (const l of compactNoteLines(result, focus)) console.log(l); });
      try { await compactPending; }
      catch (e) { console.log(`compaction failed: ${e instanceof Error ? e.message : String(e)} — the session is unchanged`); }
      finally { compacting = null; compactPending = null; }
      if (!closing) rl.prompt(); return;
    }
    if (text === "/copy" || text.startsWith("/copy ")) {
      const arg = text.slice("/copy".length).trim();
      const n = arg === "" ? 1 : /^[1-9]\d*$/.test(arg) ? Number(arg) : NaN;
      console.log(Number.isNaN(n) ? "usage: /copy [n] — copies the last assistant message; n counts back from the latest" : (await copyAssistantMessage(rt.store.messages(), n)).text);
      rl.prompt(); return;
    }

    if (busyNote()) { rl.prompt(); return; } // port #78: no overlapping model/shell records
    const reason = rt.noProviderReason(); // live — a provider added since boot is picked up here
    if (!stream || reason !== null) { console.log(reason ?? "no provider stream"); rl.prompt(); return; }
    if (state.provider === "mock") adoptDefault();

    const goal = expandPlainInput(plainInput, expandBuiltinSlash(text, rt.cwd) ?? text); // port #78: after #53's /init expansion, using the current model for images
    const def = rt.buildDef({ provider: state.provider, model: state.model });

    const ac = new AbortController();
    rt.tasks.bindRun(ac.signal); // port #26: Ctrl-C (ac.abort above) also cancels the background tasks this run started
    // port #29: hooks ride the deps like every surface; port #26: the runtime's ONE steering queue (not a
    // fresh one) so background-task completion notes — and any hook-pushed steer — reach the next turn
    const gen = agentLoop(def, goal, {}, rt.buildCfg(state.yolo, approval), { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, planReminder: rt.planReminder, cwd: rt.cwd, signal: ac.signal, hooks: rt.hooks }, rt.steering); // port #78: expanded goal
    running = { ac, gen };
    try {
      let live = "";
      for await (const ev of gen) {
        if (ev.type === "turn_start") { resetTurnFailureCount(); state.turns++; }
        if (ev.type === "message_update") { process.stdout.write(ev.delta); live += ev.delta; }
        if (ev.type === "tool_execution_start") { console.log(`\n  → ${ev.tool} ${JSON.stringify(ev.args).slice(0, 120)}`); }
        if (ev.type === "tool_execution_end") { console.log(`  ← ${ev.ok ? "ok" : "FAIL"} ${ev.output.slice(0, 160).replace(/\n/g, " ⏎ ")}`); }
        if (ev.type === "run_end") {
          if (!live.trim()) console.log(ev.summary);
          else console.log();
          if (ev.status !== "done") console.log(`  [${ev.status}]`);
        }
      }
      for (const n of rt.drainRouterNotes()) console.log(`  [${n}]`); // port #14 fallback advances
      for (const m of rt.store.messages()) if (m.usage) { state.tokensIn += m.usage.input; state.tokensOut += m.usage.output; }
    } catch (e) {
      console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = null;
    }
    rl.prompt();
  });

  // every quit path lands here (Ctrl+D, /exit, /quit, idle Ctrl+C → rl.close()), so this is the ONE exit
  rl.on("close", async () => {
    closing = true; // port #78
    // port #29: a run still in flight dies with the surface (abort, then let its generator settle) BEFORE
    // session_close fires once — after in-flight on_event taps drained (hooks.close() waits for them)
    if (running) { running.ac.abort(); await running.gen.return(undefined as never).catch(() => {}); }
    // port #26: quitting leaves no background children — their runs (and subprocess trees) die
    // now and settle, bounded, before the process goes (same policy as cmdRun's exit())
    shellRun?.abort(); // port #78: release approval or kill the shell before closing hooks
    gitRun?.abort(); compacting?.abort(); // ports #53 + #65: no background command survives the surface
    await Promise.all([shellPending, gitPending, compactPending].map((p) => p?.catch(() => {}))); // settle before session_close
    rt.tasks.cancelAll();
    await rt.tasks.drain(2_000);
    rt.bashJobs.dispose(); // #55: kill this session's background jobs before session_close
    await rt.hooks.close().catch(() => {});
    void rt.mcp?.close().catch(() => {}); // kill MCP child processes (TUI does the same in app.ts)
    console.log(`\nbye — session ${rt.sessionId.slice(0, 8)} saved (${state.turns} turns, ${state.tokensIn}in/${state.tokensOut}out tokens)`);
    process.exit(0);
  });
}
