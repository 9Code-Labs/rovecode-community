/** Persisted preferences — the answers you should only have to give once.
 *
 *  Until this file existed, the permission level lived in the session: `/yolo` and `/accept-edits`
 *  died with the terminal, so every launch started back at "ask before every write and every
 *  command". That is the difference between a dial and a nag.
 *
 *  Two scopes, the providers.json idiom exactly (providers/provider-config.ts): `~/.rovecode/
 *  settings.json` is you, `<cwd>/.rovecode/settings.json` is this repository, and the project file
 *  wins — "in THIS checkout, stop asking" is a different sentence from "stop asking anywhere".
 *
 *  Precedence, highest first: an explicit CLI flag → ROVECODE_PERMISSION → project → user → "ask".
 *  A flag is about this run, an env var about this shell, a file about this place; the narrower the
 *  intent, the louder it speaks.
 *
 *  A missing, unreadable or malformed file reads as "no preference" — never an error. A settings
 *  file is a convenience; losing it must never stop the agent from starting. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { THINKING_EFFORTS, type PermissionLevel, type ThinkingEffort } from "./types.ts";

export type SettingsScope = "user" | "project";

export interface Settings {
  /** how much the human is asked — see types.ts PermissionLevel */
  permission?: PermissionLevel;
  /** how hard the model thinks before answering */
  effort?: ThinkingEffort;
  /** the terminal bell (BEL) when a run ends or a card needs you — default true; `false` turns it off.
   *  A terminal that beeps when you did not ask is worse than silence, so this is one key, in the file
   *  you already have, rather than a flag you have to remember every launch (sextant-renderer.ts ring). */
  bell?: boolean;
  /** the check the loop runs after the agent's last edit before its reply counts as done (core/verify.ts):
   *  one shell command, or a list run in order; `false` turns the gate off AND stops any inference. The
   *  one source that needs no guessing — a project should set this rather than let a `test` script be
   *  inferred, because a gate that runs the wrong command once is turned off forever. */
  verify?: string | string[] | false;
}

const FILE = "settings.json";

export function settingsPath(scope: SettingsScope, cwd: string): string {
  return scope === "user" ? join(rovecodeHome(), FILE) : join(cwd, ".rovecode", FILE);
}

const PERMISSIONS: readonly string[] = ["ask", "accept-edits", "auto"];

/** Only keys we recognize survive, and only with values we recognize: a hand-edited
 *  `"permission": "yes"` must not become a truthy something downstream. */
function sanitize(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Settings = {};
  if (typeof r.permission === "string" && PERMISSIONS.includes(r.permission)) out.permission = r.permission as PermissionLevel;
  if (typeof r.effort === "string" && (THINKING_EFFORTS as readonly string[]).includes(r.effort)) out.effort = r.effort as ThinkingEffort;
  if (typeof r.bell === "boolean") out.bell = r.bell; // "off"/"no" are not false: a string is ignored, the bell stays on
  // verify: a non-empty command string, a list of them (empty strings dropped, at most 8, each under 500 chars),
  // or `false`. Not a table with the other keys on purpose: the shapes differ (two enums, a boolean, this).
  if (r.verify === false) out.verify = false;
  else if (typeof r.verify === "string" && r.verify.trim() !== "" && r.verify.length <= 500) out.verify = r.verify.trim();
  else if (Array.isArray(r.verify)) {
    const cmds = r.verify.filter((v): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 500).map((v) => v.trim()).slice(0, 8);
    if (cmds.length > 0) out.verify = cmds;
  }
  return out;
}

function readOne(path: string): Settings {
  try { return sanitize(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
}

/** user then project, project winning key by key — a repo may pin the permission level while the
 *  thinking effort stays whatever you chose globally */
export function loadSettings(cwd: string): Settings {
  return { ...readOne(settingsPath("user", cwd)), ...readOne(settingsPath("project", cwd)) };
}

/** Merge one key into a scope's file, leaving the rest of it (and the other scope) alone. */
export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K], scope: SettingsScope, cwd: string): string {
  const path = settingsPath(scope, cwd);
  const next: Settings = { ...readOne(path), [key]: value };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}

/** The level this run starts at. `flag` is the CLI's answer (undefined when it said nothing);
 *  the env var is next; then the files; then the deny-default "ask". */
export function resolvePermission(cwd: string, flag: PermissionLevel | undefined, env: { ROVECODE_PERMISSION?: string | undefined; ROVECODE_YOLO?: string | undefined; ROVECODE_ACCEPT_EDITS?: string | undefined }): PermissionLevel {
  if (flag !== undefined) return flag;
  const named = (env.ROVECODE_PERMISSION ?? "").trim().toLowerCase();
  if (PERMISSIONS.includes(named)) return named as PermissionLevel;
  // the older single-purpose switches keep working; auto wins because it is the wider of the two
  if (env.ROVECODE_YOLO === "1") return "auto";
  if (env.ROVECODE_ACCEPT_EDITS === "1") return "accept-edits";
  return loadSettings(cwd).permission ?? "ask";
}
