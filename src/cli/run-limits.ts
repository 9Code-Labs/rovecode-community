/** The three ceilings on one run — turns, wall-clock seconds and dollars — from flags and environment, in one
 *  place so `rovecode run` (flags + a headless default) and the runtime (env, every surface) agree.
 *  Why a wall clock at all: a headless run that has finished its files can keep verifying — screenshots,
 *  probe pages, pixel measurements — until something external kills it, and a killed run leaves no result
 *  object. The loop checks the clock at each turn boundary (core/loop.ts) and ends with status "budget". */

export interface RunLimits {
  /** RunConfig.maxTurns override; unset = the runtime default (unlimited) */
  maxTurns?: number;
  /** RunConfig.maxSeconds; unset = no clock */
  maxSeconds?: number;
  /** RunConfig.maxCostUsd; unset = no spend cap */
  maxCostUsd?: number;
}

/** a positive whole number, or undefined for anything else (unset, junk, zero, negative) */
export function positiveInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** a positive amount of money — `0.50`, `2`, `$1.25` (a leading $ is forgiven: it is what people type) — or
 *  undefined for anything else. Zero is not an amount: a bare "0" is "off" (the shared OFF set, as for
 *  --max-seconds) and "0.00" is a usage error — neither may become a cap that ends every run before its
 *  first priced turn, which nobody means. */
export function positiveUsd(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim().replace(/^\$/, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const OFF = new Set(["off", "none", "0", "false"]);
const flagValue = (argv: readonly string[], name: string): string | undefined => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };

/** `--max-turns N` · `--max-seconds S|off` · `--max-cost D|off`, then ROVECODE_MAX_TURNS / ROVECODE_MAX_SECONDS /
 *  ROVECODE_MAX_COST, then `defaultSeconds` (the headless default; omit it for surfaces that want no clock).
 *  A flag that is present but not a positive number is a usage error, not a silent default. */
export function parseRunLimits(argv: readonly string[], env: Record<string, string | undefined>, opts: { defaultSeconds?: number } = {}): RunLimits | { error: string } {
  const out: RunLimits = {};
  // the spend cap first: it has no default and no interaction with the other two
  const cost = flagValue(argv, "--max-cost");
  if (cost !== undefined || argv.includes("--max-cost")) {
    if (cost === undefined || !OFF.has(cost.trim().toLowerCase())) {
      const n = positiveUsd(cost);
      if (n === undefined) return { error: `--max-cost wants a positive amount in dollars (or "off"), not "${cost ?? ""}"` };
      out.maxCostUsd = n;
    }
  } else {
    const envCost = env["ROVECODE_MAX_COST"];
    if (envCost !== undefined && !OFF.has(envCost.trim().toLowerCase())) {
      const n = positiveUsd(envCost);
      if (n !== undefined) out.maxCostUsd = n;
    }
  }
  const turns = flagValue(argv, "--max-turns");
  if (turns !== undefined || argv.includes("--max-turns")) {
    const n = positiveInt(turns);
    if (n === undefined) return { error: `--max-turns wants a positive whole number, not "${turns ?? ""}"` };
    out.maxTurns = n;
  } else {
    const n = positiveInt(env["ROVECODE_MAX_TURNS"]);
    if (n !== undefined) out.maxTurns = n;
  }
  const secs = flagValue(argv, "--max-seconds");
  if (secs !== undefined || argv.includes("--max-seconds")) {
    if (secs !== undefined && OFF.has(secs.trim().toLowerCase())) return out; // an explicit "no clock"
    const n = positiveInt(secs);
    if (n === undefined) return { error: `--max-seconds wants a positive whole number of seconds (or "off"), not "${secs ?? ""}"` };
    out.maxSeconds = n;
    return out;
  }
  const envSecs = env["ROVECODE_MAX_SECONDS"];
  if (envSecs !== undefined && OFF.has(envSecs.trim().toLowerCase())) return out;
  const n = positiveInt(envSecs) ?? opts.defaultSeconds;
  if (n !== undefined) out.maxSeconds = n;
  return out;
}
