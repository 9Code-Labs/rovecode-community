/** Port #44: the attach context the app hands a Renderer that implements `attach` (the sextant surface)
 *  — extracted from app.ts for the ADR-002 line cap. The panels read the runtime through these closures
 *  ONLY: the active store (swapped by /sessions, /resume and a root /rewind — read live, never captured),
 *  the task manager, the current mode's model, the catalog's context window and the /cost math over the
 *  active transcript (tui/cost.ts sessionUsage — priced per message at its origin model). */

import type { SessionStore } from "../core/session.ts";
import type { TaskManager } from "../core/tasks.ts";
import type { ModelCatalog } from "../providers/catalog.ts";
import type { SextantAttach } from "../sextant/types.ts";
import { sessionUsage } from "./cost.ts";

/** slash names the sextant surface handles itself before onSubmit (keys.ts runLocal — the future
 *  src/sextant/local-commands.ts); reserved against custom commands like the built-ins, so a
 *  `.aion/commands/theme.md` warns and loses instead of silently never being reachable. */
export const SEXTANT_LOCAL_NAMES: readonly string[] = ["theme", "open", "diff", "focus", "agents"];

export interface AttachSources {
  cwd: string;
  sessionsDir: string;
  /** the ACTIVE store, read live */
  store(): SessionStore;
  tasks: TaskManager;
  /** the current mode's model */
  model(): { provider: string; model: string };
  catalog: ModelCatalog;
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
    ...(a.petName !== undefined ? { petName: a.petName } : {}),
  };
}
