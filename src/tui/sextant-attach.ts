/** Port #44: the attach context the app hands a Renderer that implements `attach` (the sextant surface)
 *  — extracted from app.ts for the ADR-002 line cap. The panels read the runtime through these closures
 *  ONLY: the active store (swapped by /sessions, /resume and a root /rewind — read live, never captured),
 *  the task manager, the current mode's model, the catalog's context window and the /cost math over the
 *  active transcript (tui/cost.ts sessionUsage — priced per message at its origin model). */

import type { SessionStore } from "../core/session.ts";
import type { TaskManager } from "../core/tasks.ts";
import type { ModelCatalog } from "../providers/catalog.ts";
import type { SextantAttach } from "../sextant/types.ts";
import type { LiveRuntime } from "../sextant/context-source.ts";
import { sessionUsage } from "./cost.ts";

/** slash names the sextant surface handles itself before onSubmit (keys.ts runLocal — the future
 *  src/sextant/local-commands.ts); reserved against custom commands like the built-ins, so a
 *  `.rovecode/commands/theme.md` warns and loses instead of silently never being reachable. */
export const SEXTANT_LOCAL_NAMES: readonly string[] = ["theme", "open", "diff", "focus", "agents", "notices", "context"];

export interface AttachSources {
  cwd: string;
  sessionsDir: string;
  /** the ACTIVE store, read live */
  store(): SessionStore;
  tasks: TaskManager;
  /** the current mode's model */
  model(): { provider: string; model: string };
  catalog: ModelCatalog;
  /** the LIVE runtime, for /context. A function rather than a value: /sessions and /resume swap what is
   *  underneath, and a captured runtime would report on the session the human left. Returning null is
   *  allowed and means the panel says its total is a floor. */
  runtime?: () => LiveRuntime | null;
  /** `--pet <name>` */
  petName?: string;
}

export function buildSextantAttach(a: AttachSources): SextantAttach {
  return {
    cwd: a.cwd,
    sessionsDir: a.sessionsDir,
    store: () => ({ id: a.store().id }),
    tasks: a.tasks,
    model: a.model,
    contextWindow: () => { const m = a.model(); return a.catalog.lookup(m.provider, m.model)?.contextWindow; },
    usage: () => sessionUsage(a.store().messages(), a.catalog, a.model()),
    // /context counts the real transcript against the real catalog, and asks the live runtime for the
    // system prompt and the tool schemas — the two rows a transcript cannot know and a fresh window is
    // mostly made of. The tier travels with the pricing, or a long xAI turn is billed at half rate.
    contextInputs: () => ({
      messages: a.store().messages(),
      lookup: (r) => {
        const info = a.catalog.lookup(r.provider, r.model);
        if (!info) return undefined;
        return {
          ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
          ...(info.pricing ? { pricing: info.pricing } : {}),
          ...(info.tier ? { tier: info.tier } : {}),
        };
      },
      runtime: a.runtime?.() ?? null,
    }),
    // /market installs an MCP server into a file this session already read; without this the only way to
    // reach it was to quit and start again, which is a poor answer to "I just installed it"
    reloadMcp: async () => { const rt = a.runtime?.(); return (await rt?.reloadMcp?.()) ?? { added: [], removed: [], failed: [], skipped: [] }; },
    // the images staged for the next message (tui/attach.ts /attach, /paste) — read live, the store owns them
    staged: () => a.store().stagedAttachments.map((p) => p.name ?? "image"),
    ...(a.petName !== undefined ? { petName: a.petName } : {}),
  };
}
