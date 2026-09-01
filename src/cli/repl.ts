/** Interactive agent chat (omp/claude-code style): persistent session, streaming
 *  output, y/n/a approvals, slash commands. Bare `aion` drops here. */

import readline from "node:readline";
import { agentLoop, SteeringQueue, partsText } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { SkillStore } from "../skills/index.ts";
import { createSkillTools, buildSkillsIndex } from "../skills/tools.ts";
import { BlockStore } from "../memory/blocks.ts";
import { memoryEditTool, resetTurnFailureCount } from "../memory/tools.ts";
import { resolveProvider, providerStream } from "../providers/stream.ts";
import type { RunConfig, AgentDefinition, Message } from "../core/types.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  const cwd = process.cwd();
  const stateDir = join(cwd, ".aion", "sessions");
  mkdirSync(stateDir, { recursive: true });
  const sessionId = randomUUID();
  const store = new SessionStore(stateDir, sessionId);

  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool);
  const skillStore = new SkillStore(cwd);
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  const blockStore = new BlockStore(join(stateDir, sessionId, "memory"));
  registry.register(memoryEditTool(blockStore));

  const state: ReplState = {
    yolo: opts.yolo ?? process.env.AION_YOLO === "1",
    provider: "mock",
    model: opts.model ?? process.env.AION_MODEL ?? "",
    turns: 0, tokensIn: 0, tokensOut: 0,
  };

  let cfgProvider = resolveProvider();
  if (!cfgProvider) {
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("no provider configured (set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY env).");
    const base = await ask(rl0, "base url [https://api.kaesra.tech/v1]: ");
    const key = await ask(rl0, "api key: ");
    rl0.close();
    if (base && key) cfgProvider = { id: "custom", baseUrl: base || "https://api.kaesra.tech/v1", apiKey: key, protocol: base.includes("anthropic") ? "anthropic" : "openai", defaultModel: state.model || undefined };
  }
  const stream = cfgProvider ? providerStream(cfgProvider) : undefined;
  if (cfgProvider) { state.provider = cfgProvider.id; state.model = state.model || cfgProvider.defaultModel || "gpt-4o-mini"; }

  const skillsIndex = buildSkillsIndex(skillStore);
  const memoryIndex = blockStore.renderForPrompt();

  console.log(`aion — interactive agent (${state.provider}/${state.model})`);
  console.log(`session ${sessionId.slice(0, 8)} in ${cwd}`);
  console.log(`mode: ${state.yolo ? "yolo (all tools allowed)" : "gated (asks before writes/exec)"}`);
  console.log(`commands: /exit /new /yolo /model <id> /status /skills /memory`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "aion> " });

  const buildCfg = (): RunConfig => ({
    maxTurns: 60, contextBudgetTokens: 200_000, compactionThreshold: 0.8,
    parallelTools: true, retry: { maxAttempts: 3, backoffMs: 400 },
    permissionRules: state.yolo
      ? [{ action: "*", resource: "*", effect: "allow" }]
      : [
          { action: "file.read", resource: "*", effect: "allow" },
          { action: "memory.write", resource: "*", effect: "allow" },
          { action: "tool.skill_view", resource: "*", effect: "allow" },
          { action: "tool.skills_list", resource: "*", effect: "allow" },
          { action: "file.write", resource: "*", effect: "prompt" },
          { action: "shell.exec", resource: "*", effect: "prompt" },
          { action: "spawn", resource: "*", effect: "prompt" },
        ],
    approval: state.yolo ? undefined : async (req) => {
      const argPreview = JSON.stringify(req.revisedArgs).slice(0, 140);
      console.log(`\n  approval needed: ${req.tool} ${argPreview}`);
      const a = await ask(rl, "  allow? [y]es / [a]lways / [n]o: ");
      return a === "a" ? "always" : a === "n" || a === "" ? "deny" : "once";
    },
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === "/exit" || text === "/quit") { rl.close(); return; }
    if (text === "/yolo") { state.yolo = !state.yolo; console.log(`mode: ${state.yolo ? "yolo" : "gated"}`); rl.prompt(); return; }
    if (text === "/status") { console.log(`provider=${state.provider} model=${state.model} turns=${state.turns} tokens=${state.tokensIn}in/${state.tokensOut}out`); rl.prompt(); return; }
    if (text === "/skills") { for (const s of skillStore.list()) console.log(`  ${s.name.padEnd(20)} ${s.description}`); rl.prompt(); return; }
    if (text === "/memory") { console.log(blockStore.renderForPrompt() || "(empty)"); rl.prompt(); return; }
    if (text.startsWith("/model ")) { state.model = text.slice(7).trim(); console.log(`model → ${state.model}`); rl.prompt(); return; }
    if (text === "/new") { store.branch(store.messages()[0]?.id ?? ""); console.log("branched to session start"); rl.prompt(); return; }

    if (!stream) { console.log("no provider — set AION_BASE_URL/AION_API_KEY and restart"); rl.prompt(); return; }

    const def: AgentDefinition = {
      name: "main",
      model: { provider: state.provider, model: state.model },
      systemPrompt: `You are Aion, an interactive coding agent in ${cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Be concise.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`,
      tools: ["*"],
    };

    try {
      let live = "";
      for await (const ev of agentLoop(def, text, {}, buildCfg(), { stream, registry, store, tools: registry.list().map((t) => t.schema) }, new SteeringQueue())) {
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
      for (const m of store.messages()) if (m.usage) { state.tokensIn += m.usage.input; state.tokensOut += m.usage.output; }
    } catch (e) {
      console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\nbye — session ${sessionId.slice(0, 8)} saved (${state.turns} turns, ${state.tokensIn}in/${state.tokensOut}out tokens)`);
    process.exit(0);
  });
}
