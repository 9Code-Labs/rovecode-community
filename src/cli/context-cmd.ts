/** `rovecode context [session-id]` — what is in the window right now, item by item, and how far our
 *  arithmetic is from the provider's own count.
 *
 *  Reads a saved session from `<cwd>/.rovecode/sessions` (the newest one unless an id is given) and
 *  prints the breakdown core/context-report.ts computes. The interesting line is `drift`: the estimate
 *  is o200k, which is exact for OpenAI models and an approximation everywhere else, so the honest thing
 *  is to print the provider's own number beside ours whenever a turn reported one — and to say plainly
 *  when the two disagree by more than a twentieth, because compaction fires on the estimate.
 *
 *  Offline: the catalog is the bundled snapshot plus rovecode's own table, no fetch. `--json` prints the
 *  report verbatim for scripts; `--no-runtime` skips building the runtime, and with it the system-prompt
 *  and tool-schema rows, for a project whose config does not load. */

import { join } from "node:path";
import { listSessions, SessionStore } from "../core/session.ts";
import { contextReport, DRIFT_TOLERANCE, type ContextReport } from "../core/context-report.ts";
import { ModelCatalog } from "../providers/catalog.ts";

export interface ContextCliDeps {
  cwd?: string;
  /** overridden in tests; production reads the default model from the provider registry */
  currentRef?: () => { provider: string; model: string } | null;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

const bar = (fraction: number, width = 24): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "█".repeat(filled) + "·".repeat(width - filled);
};

const n = (v: number): string => v.toLocaleString("en-US");
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function renderContext(r: ContextReport, sessionId: string): string[] {
  const out: string[] = [];
  out.push(`session ${sessionId} · ${r.model.provider}/${r.model.model}`);
  out.push("");
  if (r.window) {
    out.push(`context  ${bar(r.fraction ?? 0)}  ~${n(r.corrected)} of ${n(r.window)} (${pct(r.fraction ?? 0)})`);
    out.push(`         ${n(r.remaining ?? 0)} left${r.nearLimit ? " — near the limit, compaction is due" : ""}`);
  } else {
    out.push(`context  ~${n(r.corrected)} tokens — this model's window is not in the catalog`);
  }
  // never correct a number silently: say the raw estimate, the factor, and where the factor is from
  if (r.scale.factor !== 1) {
    out.push(`         o200k counted ${n(r.estimated)}, scaled by ${r.scale.factor}× — ${r.scale.note}`);
  } else if (!r.scale.measured) {
    out.push(`         ${r.scale.note}`);
  }
  out.push("");
  const width = Math.max(...r.slices.map((s) => s.label.length), 10);
  for (const s of r.slices) {
    out.push(`  ${s.label.padEnd(width)}  ${n(s.tokens).padStart(9)}  ${pct(s.share).padStart(6)}${s.note ? `  — ${s.note}` : ""}`);
  }
  if (r.images > 0) out.push(`  ${"images".padEnd(width)}  ${String(r.images).padStart(9)}         — not estimated; image tokens are provider-specific`);
  out.push("");
  if (r.drift) {
    const d = r.drift;
    const dir = d.delta > 0 ? "more than we estimate" : "less than we estimate";
    out.push(`drift    provider counted ${n(d.reported)} for the last turn's prompt, we estimated ${n(d.estimated)}`);
    out.push(`         ${n(Math.abs(d.delta))} ${dir} (${pct(d.fraction)})${d.beyondTolerance ? ` — beyond the ${pct(DRIFT_TOLERANCE)} tolerance; the meter above reads ${d.delta > 0 ? "low" : "high"} for this model` : ""}`);
  } else {
    out.push("drift    no turn reported usage yet — nothing to compare the estimate against");
  }
  out.push("");
  const t = r.totals;
  out.push(`billed   ${n(t.input)} in · ${n(t.output)} out · ${n(t.cacheRead)} cache read · ${n(t.cacheWrite)} cache written`);
  // three different silences, and saying the wrong one is a lie about the catalog: nothing has been
  // billed yet, versus the catalog not pricing this model, versus a partly priced transcript.
  const billedAnything = t.input + t.output + t.cacheRead + t.cacheWrite > 0;
  out.push(
    r.costUsd !== undefined
      ? `cost     $${r.costUsd.toFixed(4)}${r.unpricedTurns > 0 ? ` — lower bound, ${r.unpricedTurns} turn${r.unpricedTurns > 1 ? "s" : ""} unpriced` : ""}`
      : billedAnything
        ? `cost     unknown — no pricing for ${r.model.provider}/${r.model.model}`
        : "cost     $0.0000 — nothing has been billed in this session yet",
  );
  return out;
}

/** the `--exact` rows: the provider's own count of this prompt, and how far our meter sits from it.
 *  A refusal prints the reason on the same row — a count nobody could obtain is not a zero. */
export function renderExact(e: { inputTokens?: number; reason?: string; placeholder?: boolean }, estimated: number): string[] {
  if (e.inputTokens === undefined) return ["", `exact    not counted — ${e.reason ?? "no reason given"}`];
  const delta = estimated - e.inputTokens;
  const fraction = e.inputTokens > 0 ? Math.abs(delta) / e.inputTokens : 0;
  const verdict =
    delta === 0
      ? "our estimate agrees exactly"
      : `our estimate reads ${delta > 0 ? "high" : "low"} by ${n(Math.abs(delta))} (${pct(fraction)})${fraction > DRIFT_TOLERANCE ? ` — beyond the ${pct(DRIFT_TOLERANCE)} tolerance` : ""}`;
  const rows = ["", `exact    the provider counted ${n(e.inputTokens)} for this prompt`, `         ${verdict}`];
  if (e.placeholder) rows.push("         this session has no turns yet — the count includes a one-character placeholder message, which the API requires");
  return rows;
}

export async function cmdContext(args: string[], deps: ContextCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const cwd = deps.cwd ?? process.cwd();
  const json = args.includes("--json");
  const id = args.find((a) => !a.startsWith("-"));

  // --json is one document on stdout on every exit, the failing ones included — a script that asked for the
  // report gets `{error}` it can read, not an empty stdout and a 1 (the market commands keep the same rule)
  const fail = (msg: string): 1 => { err(msg); if (json) log(JSON.stringify({ error: msg })); return 1; };

  const sessionsDir = join(cwd, ".rovecode", "sessions");
  const sessions = listSessions(sessionsDir);
  const chosen = id ?? sessions[0]?.id;
  if (!chosen) return fail("no sessions here — run rovecode in this directory first");
  if (id && !sessions.some((s) => s.id === id)) return fail(`no session ${id} here — rovecode context lists the newest by default`);

  const messages = new SessionStore(sessionsDir, chosen).messages();
  const ref = deps.currentRef
    ? deps.currentRef()
    : await (async () => {
        const { ProviderRegistry } = await import("../providers/registry.ts");
        return new ProviderRegistry(cwd).defaultRef() ?? null;
      })();
  if (!ref) return fail("no default model — rovecode model use <provider/model>");

  // The system prompt and the tool schemas are the two rows a transcript cannot tell us, and they are
  // the largest fixed cost of every turn — so the command builds the same runtime a real run would and
  // asks it, unless --no-runtime says not to (a broken project config should not stop a token count).
  // MCP tools are deliberately absent: their schemas exist only after connecting to a server, and
  // starting other people's processes to print a number is not a trade this command should make.
  let fixed: { system?: string; toolSchemas?: string; schemas?: unknown[]; note?: string } = {};
  if (!args.includes("--no-runtime")) {
    try {
      const { createRuntime } = await import("./runtime.ts");
      // sessionId: the one we are reporting on. Without it the runtime opens a NEW session directory,
      // so merely asking "what is in the window" would leave an empty session behind — and the next
      // `rovecode context` would report that empty one instead.
      const rt = createRuntime({ cwd, stream: null, sessionId: chosen });
      const schemas = rt.registry.list().map((t) => t.schema);
      // buildDef, not systemPrompt(): the prompt a run actually sends is the base plus the model
      // profile, the design section and — for a model without native tool calling — the tool block.
      // Asking for the base alone under-counts the row by everything that makes it big.
      const def = rt.buildDef({ ...ref, effort: "auto" });
      const system = typeof def.systemPrompt === "string" ? def.systemPrompt : def.systemPrompt({});
      fixed = { system, toolSchemas: JSON.stringify(schemas), schemas };
      await rt.mcp?.close().catch(() => {});
    } catch (e) {
      fixed = { note: `the system prompt and tool schemas are not counted — this project's runtime did not build (${e instanceof Error ? e.message : String(e)})` };
    }
  }

  const catalog = new ModelCatalog();
  const report = contextReport({
    messages,
    current: ref,
    ...(fixed.system !== undefined ? { system: fixed.system } : {}),
    ...(fixed.toolSchemas !== undefined ? { toolSchemas: fixed.toolSchemas } : {}),
    lookup: (r) => {
      const info = catalog.lookup(r.provider, r.model);
      if (!info) return undefined;
      return {
        ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
        ...(info.pricing ? { pricing: info.pricing } : {}),
        // the tier travels with the pricing or the report bills a 250k-token xAI turn at half rate
        ...(info.tier ? { tier: info.tier } : {}),
      };
    },
  });

  // --exact: stop estimating and ask the provider. Anthropic counts the same body a request would carry
  // and returns the number the window and the bill are computed from; o200k is only our stand-in for it.
  let exact: { inputTokens?: number; reason?: string; endpoint?: string; placeholder?: true } | undefined;
  if (args.includes("--exact")) {
    const { countPromptRemotely } = await import("../core/count-remote.ts");
    const { ProviderRegistry } = await import("../providers/registry.ts");
    const p = new ProviderRegistry(cwd).get(ref.provider);
    if (!p) exact = { reason: `provider "${ref.provider}" is not configured here` };
    else {
      const r = await countPromptRemotely({
        provider: { baseUrl: p.baseUrl, protocol: p.protocol, ...(p.apiKey ? { apiKey: p.apiKey } : {}), ...(p.headers ? { headers: p.headers } : {}) },
        model: ref.model,
        messages,
        ...(fixed.system !== undefined ? { system: fixed.system } : {}),
        // the same schemas the estimate counted; without them the two numbers would describe
        // different prompts and the comparison below would be meaningless
        ...(fixed.schemas ? { tools: fixed.schemas } : {}),
      });
      exact = r.ok
        ? { inputTokens: r.inputTokens, endpoint: r.endpoint, ...(r.placeholder ? { placeholder: true as const } : {}) }
        : { reason: r.reason };
    }
  }

  if (json) log(JSON.stringify({ session: chosen, ...report, ...(exact ? { exact } : {}), ...(fixed.note ? { note: fixed.note } : {}) }, null, 2));
  else {
    for (const line of renderContext(report, chosen)) log(line);
    if (exact) for (const line of renderExact(exact, report.estimated)) log(line);
    if (fixed.note) log(`note     ${fixed.note}`);
    else if (fixed.system !== undefined) log("note     MCP tools are not counted — their schemas exist only once a server is connected");
  }
  return 0;
}
