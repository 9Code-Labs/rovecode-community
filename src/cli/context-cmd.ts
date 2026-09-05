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
 *  report verbatim for scripts. */

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
    out.push(`context  ${bar(r.fraction ?? 0)}  ~${n(r.estimated)} of ${n(r.window)} (${pct(r.fraction ?? 0)})`);
    out.push(`         ${n(r.remaining ?? 0)} left${r.nearLimit ? " — near the limit, compaction is due" : ""}`);
  } else {
    out.push(`context  ~${n(r.estimated)} tokens — this model's window is not in the catalog`);
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
  out.push(
    r.costUsd !== undefined
      ? `cost     $${r.costUsd.toFixed(4)}${r.unpricedTurns > 0 ? ` — lower bound, ${r.unpricedTurns} turn${r.unpricedTurns > 1 ? "s" : ""} unpriced` : ""}`
      : `cost     unknown — no pricing for ${r.model.provider}/${r.model.model}`,
  );
  return out;
}

export async function cmdContext(args: string[], deps: ContextCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const cwd = deps.cwd ?? process.cwd();
  const json = args.includes("--json");
  const id = args.find((a) => !a.startsWith("-"));

  const sessionsDir = join(cwd, ".rovecode", "sessions");
  const sessions = listSessions(sessionsDir);
  const chosen = id ?? sessions[0]?.id;
  if (!chosen) {
    err("no sessions here — run rovecode in this directory first");
    return 1;
  }
  if (id && !sessions.some((s) => s.id === id)) {
    err(`no session ${id} here — rovecode context lists the newest by default`);
    return 1;
  }

  const messages = new SessionStore(sessionsDir, chosen).messages();
  const ref = deps.currentRef
    ? deps.currentRef()
    : await (async () => {
        const { ProviderRegistry } = await import("../providers/registry.ts");
        return new ProviderRegistry(cwd).defaultRef() ?? null;
      })();
  if (!ref) {
    err("no default model — rovecode model use <provider/model>");
    return 1;
  }

  const catalog = new ModelCatalog();
  const report = contextReport({
    messages,
    current: ref,
    lookup: (r) => {
      const info = catalog.lookup(r.provider, r.model);
      if (!info) return undefined;
      return {
        ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
        ...(info.pricing ? { pricing: info.pricing } : {}),
      };
    },
  });

  if (json) log(JSON.stringify({ session: chosen, ...report }, null, 2));
  else for (const line of renderContext(report, chosen)) log(line);
  return 0;
}
