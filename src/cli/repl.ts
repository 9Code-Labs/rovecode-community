/** Interactive agent chat (omp/claude-code style): persistent session, streaming
 *  output, y/n/a approvals, slash commands. Bare `aion` drops here. */

import readline from "node:readline";
import { agentLoop } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import { providerStream } from "../providers/stream.ts";
import type { ApprovalFn, RunEvent } from "../core/types.ts";
import { bootRuntime } from "./runtime.ts";
import { SandboxConfigError, describeSandbox } from "../core/sandbox-config.ts";

export interface ReplState {
  yolo: boolean;
  provider: string;
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim().toLowerCase())));
}

export async function runRepl( /* eslint-disable-line complexity */
  opts: { yolo?: boolean; model?: string } = {},
): Promise<void> {
  // port #27: sandbox misconfig / unavailable configured rung → one-line startup error, exit 2
  const rt = await bootRuntime().catch((e: unknown): never => {
    if (e instanceof SandboxConfigError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });

  const state: ReplState = {
    yolo: opts.yolo ?? process.env.AION_YOLO === "1",
    provider: "mock",
    model: opts.model ?? process.env.AION_MODEL ?? "",
    turns: 0, tokensIn: 0, tokensOut: 0,
  };

  // interactive fallback when no provider is configured (stays out of runtime.ts)
  let cfgProvider = rt.provider;
  let stream = rt.stream ?? undefined;
  if (!cfgProvider) {
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("no provider configured (run `aion auth set <provider>`, or set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY env).");
    const base = await ask(rl0, "base url [https://api.kaesra.tech/v1]: ");
    const key = await ask(rl0, "api key: ");
    rl0.close();
    if (base && key) {
      cfgProvider = { id: "custom", baseUrl: base || "https://api.kaesra.tech/v1", apiKey: key, protocol: base.includes("anthropic") ? "anthropic" : "openai", defaultModel: state.model || undefined };
      stream = providerStream(cfgProvider);
    }
  }
  if (cfgProvider) { state.provider = cfgProvider.id; state.model = state.model || cfgProvider.defaultModel || "gpt-4o-mini"; }

  console.log(`aion — interactive agent (${state.provider}/${state.model})`);
  console.log(`session ${rt.sessionId.slice(0, 8)} in ${rt.cwd}`);
  console.log(`mode: ${state.yolo ? "yolo (all tools allowed)" : "gated (asks before writes/exec)"}`);
  console.log(`commands: /exit /new /yolo /model <id> /status /skills /memory`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "aion> " });

  // port #33: `--plain` HAS a human (the y/n/a approvals below prove it) — bind ask_user to the same
  // readline; headless surfaces leave it unbound and the tool fails closed. Numbered options plus
  // free text when allowed: a number picks, other text is the typed answer, an empty line declines
  // (null). Piped stdin is fine — it just consumes the next line. The run's abort resolves null so
  // an interrupted run never stays parked on the question.
  rt.setAskUser((q, signal) => new Promise((resolve) => {
    const options = q.options ?? [];
    const free = q.allowFreeText !== false;
    console.log(`\n  question: ${q.question}`);
    options.forEach((o, i) => console.log(`    ${i + 1}) ${o}`));
    const hint = [options.length > 0 ? `1-${options.length}` : "", free ? "text" : ""].filter(Boolean).join(" or ");
    const onAbort = (): void => { resolve(null); };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.question(`  answer [${hint}; empty = decline]: `, (line) => {
      signal.removeEventListener("abort", onAbort);
      const a = line.trim();
      const n = Number(a);
      if (a === "") resolve(null);
      else if (Number.isInteger(n) && n >= 1 && n <= options.length) resolve({ choice: n - 1, label: options[n - 1] });
      else if (free) resolve({ text: a });
      else { console.log("  (not one of the options — declined)"); resolve(null); }
    });
  }));

  const approval: ApprovalFn = async (req) => {
    const argPreview = JSON.stringify(req.revisedArgs).slice(0, 140);
    console.log(`\n  approval needed: ${req.tool} ${argPreview}`);
    const a = await ask(rl, "  allow? [y]es / [a]lways / [n]o: ");
    return a === "a" ? "always" : a === "n" || a === "" ? "deny" : "once";
  };

  rl.prompt();

  // port #21: one AbortController per run — Ctrl+C mid-run aborts the in-flight
  // fetch/tools for real (abort first, then return() settles the generator); idle
  // Ctrl+C keeps its old meaning (close the repl)
  let running: { ac: AbortController; gen: AsyncGenerator<RunEvent> } | null = null;
  rl.on("SIGINT", () => {
    if (running) { running.ac.abort(); void running.gen.return(undefined as never); console.log("\n  [interrupted]"); }
    else rl.close();
  });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === "/exit" || text === "/quit") { rl.close(); return; }
    if (text === "/yolo") { state.yolo = !state.yolo; console.log(`mode: ${state.yolo ? "yolo" : "gated"}`); rl.prompt(); return; }
    if (text === "/status") { console.log(`provider=${state.provider} model=${state.model} turns=${state.turns} tokens=${state.tokensIn}in/${state.tokensOut}out\nsandbox: ${describeSandbox(rt.sandbox)}`); rl.prompt(); return; }
    if (text === "/skills") { for (const s of rt.skillStore.list()) console.log(`  ${s.name.padEnd(20)} ${s.description}`); rl.prompt(); return; }
    if (text === "/memory") { console.log(rt.blockStore.renderForPrompt() || "(empty)"); rl.prompt(); return; }
    if (text.startsWith("/model ")) { state.model = text.slice(7).trim(); console.log(`model → ${state.model}`); rl.prompt(); return; }
    if (text === "/new") { rt.store.branch(rt.store.messages()[0]?.id ?? ""); console.log("branched to session start"); rl.prompt(); return; }

    if (!stream) { console.log("no provider — set AION_BASE_URL/AION_API_KEY and restart"); rl.prompt(); return; }

    const def = rt.buildDef({ provider: state.provider, model: state.model });

    const ac = new AbortController();
    rt.tasks.bindRun(ac.signal); // port #26: Ctrl-C (ac.abort above) also cancels the background tasks this run started
    const gen = agentLoop(def, text, {}, rt.buildCfg(state.yolo, approval), { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, signal: ac.signal }, rt.steering); // port #26: the runtime's queue — task completion notes reach the next turn
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

  rl.on("close", () => {
    void (async () => {
      // port #26: quitting leaves no background children — their runs (and subprocess trees) die
      // now and settle, bounded, before the process goes (same policy as cmdRun's exit())
      rt.tasks.cancelAll();
      await rt.tasks.drain(2_000);
      void rt.mcp?.close().catch(() => {}); // kill MCP child processes (TUI does the same in app.ts)
      console.log(`\nbye — session ${rt.sessionId.slice(0, 8)} saved (${state.turns} turns, ${state.tokensIn}in/${state.tokensOut}out tokens)`);
      process.exit(0);
    })();
  });
}
