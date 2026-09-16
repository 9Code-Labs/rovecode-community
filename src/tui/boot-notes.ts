/** Boot-note extraction port: everything runTui says before the first prompt, in its original order.
 *  Adapted from aion's boot-notes.ts, retaining rovecode's voice and runtime channels. Memory migration,
 *  trust, workspace-root and agent-definition notes already ride plugins.onWarning: do not emit them twice.
 *  No boot work or update fetch here; only the renderer and the runtime's buffered/live note listeners. */
import type { Runtime } from "../cli/runtime.ts";
import { resumedLine, welcomeCard } from "../core/voice.ts";
import { summarizePlugins } from "../plugins/index.ts";
import type { Renderer } from "./renderer.ts";

export interface BootNotesCtx {
  renderer: Pick<Renderer, "addSystemNote">;
  rt: Pick<Runtime, "cwd" | "stream" | "noProviderReason" | "skillStore" | "mcp" | "providers" | "hooks" | "plugins" | "onRouterNote">;
  yolo: boolean;
  modelRef: { provider: string; model: string };
  mode: "plan" | "act";
  version: string;
  width: number;
  /** Undefined on a fresh boot; the active store's id on a resumed boot. */
  sessionId: string | undefined;
  bootWarn: string | undefined;
  commandWarnings: readonly string[];
}

export function emitBootNotes({ renderer, rt, yolo, modelRef, mode, version, width, sessionId, bootWarn, commandWarnings }: BootNotesCtx): void {
  const connected = rt.stream && rt.noProviderReason() === null ? modelRef : null;
  if (sessionId !== undefined) renderer.addSystemNote(resumedLine(sessionId, rt.cwd, yolo));
  else {
    // Count only what this runtime accepted, not untrusted/unfilled MCP entries or inactive plugins.
    const loaded = { skills: rt.skillStore.list().length, plugins: rt.plugins.found.filter((p) => p.status === "active").length, mcp: rt.mcp?.serverNames().length ?? 0 };
    renderer.addSystemNote(welcomeCard({ connected, cwd: rt.cwd, yolo, mode, version, loaded, width }));
  }
  if (bootWarn) renderer.addSystemNote(bootWarn); // a fact, not a fault (the original info tone)
  for (const w of commandWarnings) renderer.addSystemNote(w, "warn");
  for (const w of rt.providers.warnings()) renderer.addSystemNote(`providers: ${w}`, "warn");
  rt.hooks.onWarning((w) => renderer.addSystemNote(`hooks: ${w}`, "warn"));
  rt.plugins.onWarning((w) => renderer.addSystemNote(w, "warn"));
  const pluginLine = summarizePlugins(rt.plugins.found);
  if (pluginLine !== null) renderer.addSystemNote(pluginLine);
  // Retry notices arrive during backoff; the run's final drain then has nothing left to print.
  rt.onRouterNote((n) => renderer.addSystemNote(n, "warn"));
}
