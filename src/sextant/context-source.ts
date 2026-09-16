/** The seam between the context overlay and core/context-report.ts.
 *
 *  draw-context.ts is pure over `ContextState` and never counts anything. This file is the only place that
 *  knows the report module exists: it lazily imports it (the boot rule — nothing in that dependency tree is
 *  loaded until someone opens /context), asks the LIVE runtime for the two rows a transcript cannot know,
 *  and maps the report onto the overlay's flat view.
 *
 *  The live runtime is the whole reason this overlay is worth having. `rovecode context` on a shell has to
 *  BUILD a runtime to learn the system prompt and the tool schemas, and in a fresh session those two are
 *  most of the window; here they are already in memory, so the number is complete without constructing
 *  anything. What is still missing is MCP tools — their schemas do not exist until a server is connected —
 *  and the panel says so on its own line rather than letting a complete-looking total imply otherwise.
 *
 *  Two numbers travel, never one. `raw` is what o200k counted; `estimated` is that corrected towards the
 *  model's own tokenizer. Presenting only the second would be presenting a corrected figure as a
 *  measurement, and someone comparing this panel against a provider's dashboard needs to know which is
 *  which. `scale.note` says where the factor came from, including when nobody has measured this model.
 *
 *  Nothing here throws. A runtime that cannot answer, a model the catalog does not know, an empty
 *  transcript — each is a state the overlay draws, because a panel that reports on the session must not be
 *  the thing that ends it. */

import type { ContextState } from "./draw-context.ts";

/** What the live runtime can tell us that the transcript cannot. Both optional: a session whose runtime
 *  is mid-rebuild still opens the panel, and `live: false` makes the total read as a floor. */
export interface ContextFixed {
  /** the system prompt a real turn would send — buildDef's, not the base alone */
  system?: string;
  /** rovecode's own tool schemas, serialized. MCP tools are deliberately absent. */
  toolSchemas?: string;
}

/** the runtime shape this file needs, structurally — declared here so the overlay never imports the
 *  runtime's types and so a test can hand in three lines instead of a process */
export interface LiveRuntime {
  registry: { list(): { schema: unknown }[] };
  // method syntax, and `unknown` for the prompt: the real AgentDefinition types `systemPrompt` as a string
  // or a function over its own AgentVars, and pinning either shape here would make this file depend on the
  // runtime's types — which is exactly what the overlay must not do. It is narrowed where it is read.
  buildDef(ref: { provider: string; model: string; effort: "auto" }): { systemPrompt: unknown };
  /** optional: the market overlay uses it after installing an MCP server (types.ts SextantAttach) */
  reloadMcp?(): Promise<{ added: string[]; removed: string[]; failed: { name: string; error: string }[]; skipped: string[] }>;
}

/** Pull the two fixed rows out of a runtime that is ALREADY running.
 *
 *  Deliberately not `createRuntime`: the CLI builds one because it has none, and paid for that decision
 *  with a session directory it had to pass in to avoid creating a stray empty session. Inside the TUI the
 *  runtime is the one the next turn will use, so this is a read, not a construction — and it cannot leave
 *  anything behind.
 *
 *  `buildDef`, not `systemPrompt()`: the prompt a run actually sends is the base plus the model profile,
 *  the design section, and — for a model without native tool calling — the tool block. Asking for the base
 *  alone under-counts the largest fixed row by everything that makes it large. */
export function fixedFrom(rt: LiveRuntime | null | undefined, ref: { provider: string; model: string }): ContextFixed {
  if (!rt) return {};
  try {
    const schemas = rt.registry.list().map((t) => t.schema);
    const def = rt.buildDef({ ...ref, effort: "auto" });
    const sp = def.systemPrompt;
    const system = typeof sp === "string" ? sp : typeof sp === "function" ? String((sp as (x: Record<string, unknown>) => unknown)({})) : undefined;
    if (system === undefined) return {};
    return { system, toolSchemas: JSON.stringify(schemas) };
  } catch {
    // a runtime that cannot describe itself is a panel that says so, not a crashed frame
    return {};
  }
}

/** the report module's shape, structurally: this file must compile and be testable without importing it */
interface Slice { label: string; tokens: number; share: number; note?: string }
interface Drift { estimated: number; reported: number; delta: number; fraction: number; beyondTolerance: boolean }
interface Report {
  model: { provider: string; model: string };
  window?: number;
  estimated: number;
  corrected: number;
  scale: { factor: number; measured: boolean; note: string };
  slices: Slice[];
  remaining?: number;
  fraction?: number;
  nearLimit?: boolean;
  drift?: Drift;
  totals: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  costUsd?: number;
  unpricedTurns: number;
  images: number;
}

export interface ContextLoadInput {
  messages: readonly unknown[];
  current: { provider: string; model: string };
  /** window + pricing, however the caller has them */
  lookup: (r: { provider: string; model: string }) => unknown;
  fixed: ContextFixed;
  /** the tolerance drift is judged against; printed by the panel, never assumed by a reader */
  tolerance?: number;
  /** tests inject the report function; production lazily imports the real one */
  report?: (input: unknown) => Report;
}

/** the fraction past which drift is called out rather than merely shown. Matches core/context-report.ts;
 *  it travels in the state so the panel can print it instead of asserting a number the reader cannot see. */
const TOLERANCE = 0.05;

/** Build the overlay's state. Never throws: every failure becomes something the panel can draw. */
export async function loadContext(input: ContextLoadInput): Promise<Omit<ContextState, "scroll">> {
  const tolerance = input.tolerance ?? TOLERANCE;
  const model = `${input.current.provider}/${input.current.model}`;

  let report: Report;
  try {
    const fn = input.report ?? (await import("../core/context-report.ts")).contextReport as unknown as (i: unknown) => Report;
    report = fn({
      messages: input.messages,
      current: input.current,
      lookup: input.lookup,
      ...(input.fixed.system !== undefined ? { system: input.fixed.system } : {}),
      ...(input.fixed.toolSchemas !== undefined ? { toolSchemas: input.fixed.toolSchemas } : {}),
    });
  } catch {
    // the panel opens and says it has nothing, which is more useful than a frame that died counting
    return {
      model, raw: 0, estimated: 0, scale: { factor: 1, measured: false, note: "the context report could not be built" },
      slices: [], images: 0, billed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      unpricedTurns: 0, live: false, tolerance,
    };
  }

  const t = report.totals;
  return {
    model,
    ...(report.window !== undefined ? { window: report.window } : {}),
    // `estimated` on the panel is the CORRECTED number, because that is what the window and the bill are
    // computed from; `raw` carries what o200k counted so the panel can show both
    raw: report.estimated,
    estimated: report.corrected,
    scale: report.scale,
    ...(report.remaining !== undefined ? { remaining: report.remaining } : {}),
    ...(report.fraction !== undefined ? { fraction: report.fraction } : {}),
    ...(report.nearLimit !== undefined ? { nearLimit: report.nearLimit } : {}),
    slices: report.slices.map((s) => ({ label: s.label, tokens: s.tokens, share: s.share, ...(s.note ? { note: s.note } : {}) })),
    images: report.images,
    ...(report.drift ? { drift: { ...report.drift } } : {}),
    billed: {
      input: t.inputTokens ?? 0, output: t.outputTokens ?? 0,
      cacheRead: t.cacheReadTokens ?? 0, cacheWrite: t.cacheWriteTokens ?? 0,
    },
    ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
    unpricedTurns: report.unpricedTurns,
    // "live" is about the two rows a transcript cannot know. The system prompt is the one that matters:
    // tool schemas can legitimately be an empty list, so their absence proves nothing.
    live: input.fixed.system !== undefined,
    tolerance,
  };
}
