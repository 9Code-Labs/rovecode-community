/** THE one answer to "how big is this model's context window" — every consumer (the sextant usage
 *  panel, the history budget, /cost) asks here, so a model NEVER has an unknown window:
 *
 *    1. providers.json `contextWindows[model]`  — the user's own per-model word (source "config")
 *    2. providers.json `contextWindow`          — the provider-wide fallback      (source "config")
 *    3. the catalog (models.dev snapshot + local overlay)                          (source "catalog")
 *    4. ASSUMED_CONTEXT_WINDOW                    — explicit, marked, never "?"    (source "assumed")
 *
 *  The "assumed" rung is a display promise, not a guess presented as fact: the panel marks it ≈ and
 *  the TUI says once per model how to set the real number. The history budget deliberately does NOT
 *  spend an assumed window (runtime.ts) — a wrong-high budget overflows the request; the panel's ≈
 *  bar is the safe place for the assumption. */

import type { ModelCatalog } from "./catalog.ts";

/** the slice of a provider spec this module reads — structural, so the host app's own ProviderSpec
 *  satisfies it without the package importing anything from the host */
export interface ContextWindowSpec {
  /** provider-wide fallback for models the catalog does not know */
  contextWindow?: number;
  /** per-model windows for models the catalog does not know; case-insensitive match on the model id */
  contextWindows?: Record<string, number>;
}

/** 128k: the floor of what a current hosted chat model serves. Over-assuming risks one rejected
 *  request (the loop's emergency compaction catches it); under-assuming would silently waste the
 *  window on the panel the user watches to decide whether one more turn fits. */
export const ASSUMED_CONTEXT_WINDOW = 128_000;

export type WindowSource = "config" | "catalog" | "assumed";
export interface ResolvedWindow { window: number; source: WindowSource }

export function resolveContextWindow(
  catalog: Pick<ModelCatalog, "lookup">,
  spec: ContextWindowSpec | undefined,
  provider: string,
  model: string,
): ResolvedWindow {
  const per = spec?.contextWindows;
  if (per) {
    const lower = model.toLowerCase();
    for (const [id, w] of Object.entries(per)) {
      if ((id === model || id.toLowerCase() === lower) && Number.isFinite(w) && w > 0) {
        return { window: Math.floor(w), source: "config" };
      }
    }
  }
  const wide = spec?.contextWindow;
  if (wide !== undefined && Number.isFinite(wide) && wide > 0) return { window: Math.floor(wide), source: "config" };
  const known = catalog.lookup(provider, model)?.contextWindow;
  if (known !== undefined) return { window: known, source: "catalog" };
  return { window: ASSUMED_CONTEXT_WINDOW, source: "assumed" };
}
