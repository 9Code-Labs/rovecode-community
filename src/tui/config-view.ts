/** `/config [all]` (aion port, re-shaped): the read-only TUI view of rovecode's ACTUAL settings model — the two
 *  settings.json scopes (core/settings.ts) merged the way the loaders merge them, plus the environment the
 *  process is running with. Aion's `describeSettings`/knob table is NOT ported: rovecode has no such table, and
 *  a view that invented one would describe a settings model the real loaders do not use. What IS shown is what
 *  the loaders read, keyed the way they read it:
 *    - files first: which of the two settings.json files exists (a missing project file is the common case,
 *      and "you could create one" is more useful than pretending it is empty);
 *    - then every settings.json key that is SET, with the scope that wins for it (project beats user — the
 *      merge in loadSettings) and the value; `verify: false` shown as read (a refusal, honoured from any file);
 *    - then the ROVECODE_* variables this process carries (names + values, values of keys never shown);
 *    - the permission level is resolved the way the CLI resolves it and stated in words.
 *  Nothing is written here; editing is the file by hand (rovecode has no `config set`). A value changed on
 *  disk mid-session is picked up on the next read — the loaders read per call — so this view is a snapshot of
 *  NOW, not of boot. Same ctx idiom as info-cmd.ts: renderer + cwd. */

import type { Renderer } from "./renderer.ts";
import { existsSync } from "node:fs";
import { loadSettings, loadSettingsScoped, resolvePermission, settingsPath, type Settings } from "../core/settings.ts";
import { rovecodeHome } from "../providers/auth.ts";

export interface ConfigViewCtx { renderer: Pick<Renderer, "addSystemNote">; cwd: string; /** the CLI's explicit flag, when it gave one */ permissionFlag?: Parameters<typeof resolvePermission>[1] }

const KEYS: readonly (keyof Settings)[] = ["permission", "effort", "bell", "notify", "notify_when", "notify_command", "verify", "lsp"];
const short = (v: unknown): string => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 80 ? `${s.slice(0, 79)}…` : s; };

/** the note text, pure — `all` also lists the keys nothing set and the env vars named-but-unset is out of scope:
 *  rovecode's env page (`rovecode help env`) is the complete list, this view shows what THIS run carries */
export function renderConfigView(cwd: string, all: boolean, env: Readonly<Record<string, string | undefined>> = process.env, home: string = rovecodeHome(), flag?: Parameters<typeof resolvePermission>[1]): string {
  const user = settingsPath("user", cwd);
  const project = settingsPath("project", cwd);
  const scoped = loadSettingsScoped(cwd, home);
  const merged = loadSettings(cwd);
  const lines: string[] = [];
  lines.push(`settings — user: ${user}${existsSync(user) ? "" : " (absent)"} · project: ${project}${existsSync(project) ? "" : " (absent)"}`);
  lines.push(`permission: ${resolvePermission(cwd, flag, env)}${scoped.dropped.length > 0 ? ` · the project file's ${scoped.dropped.join(", ")} ${scoped.dropped.length === 1 ? "is" : "are"} ignored until you trust that file (rovecode trust show)` : ""}`);
  const set = KEYS.filter((k) => merged[k] !== undefined && k !== "permission");
  if (set.length === 0) lines.push("(no settings.json key is set — every knob is at its default)");
  for (const k of set) {
    const scope = scoped.project[k] !== undefined ? "project" : "user";
    lines.push(`${k} = ${short(merged[k])}  [${scope}]`);
  }
  const envNames = Object.keys(env).filter((k) => k.startsWith("ROVECODE_") && env[k] !== "").sort();
  if (envNames.length > 0) {
    if (all) for (const n of envNames) lines.push(`${n} = ${/KEY|TOKEN|SECRET/i.test(n) ? "(set — value not shown)" : short(env[n])}  [env]`);
    else lines.push(`env: ${envNames.length} ROVECODE_* variable${envNames.length === 1 ? "" : "s"} set (/config all names them)`);
  }
  return lines.join("\n");
}

/** `/config [all]` */
export function cmdConfigView(ctx: ConfigViewCtx, arg: string): void {
  ctx.renderer.addSystemNote(renderConfigView(ctx.cwd, arg.trim() === "all", process.env, rovecodeHome(), ctx.permissionFlag));
}
