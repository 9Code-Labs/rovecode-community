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
import { isTrustedFile, untrustedFileNote } from "./trust.ts";
import { parseEffort, THINKING_EFFORTS, type PermissionLevel, type ThinkingEffort } from "./types.ts";

export type SettingsScope = "user" | "project";

/** The keys whose value is something rovecode EXECUTES — a shell string, an argv table, an argv. From the PROJECT file
 *  they are honoured only once that file is trusted on this machine (core/trust.ts): a cloned repo must not decide what
 *  we run. The user file is the person's own and is never gated. ONE list, enforced inside loadSettings itself, so a key
 *  added later joins the gate by being named here — not by every consumer remembering to ask. `verify: false` is a
 *  refusal, not a command, and stays honoured from any file. */
export const COMMAND_KEYS = ["verify", "lsp", "notify_command"] as const;
export type CommandKey = (typeof COMMAND_KEYS)[number];

export interface Settings {
  /** how much the human is asked — see types.ts PermissionLevel */
  permission?: PermissionLevel;
  /** how hard the model thinks before answering */
  effort?: ThinkingEffort;
  /** terminal notifications when a run ends or a card needs you — default true; `false` turns them off.
   *  A terminal that beeps when you did not ask is worse than silence, so this is one key, in the file
   *  you already have, rather than a flag you have to remember every launch. Since 2026-09-07 the signal
   *  fires only while the terminal is UNFOCUSED (tui/notify.ts; `notify_when: "always"` restores every run). */
  bell?: boolean;
  /** the notification method (tui/notify.ts): auto (default — an OSC 9 toast on Ghostty / iTerm2 / kitty / Warp /
   *  WezTerm, the bell everywhere else) | bell | osc9 | osc777. ROVECODE_NOTIFY overrides it (off = `bell: false`). */
  notify?: "auto" | "bell" | "osc9" | "osc777";
  /** when to notify: unfocused (default — the terminal must report focus, which Windows Terminal ≥ 1.14, Ghostty,
   *  kitty, WezTerm, iTerm2, xterm and VTE do) | always. ROVECODE_NOTIFY_WHEN overrides it. */
  notify_when?: "unfocused" | "always";
  /** a desktop hook run on every notification, under the same gate: argv as a JSON string array
   *  (`["notify-send","rovecode"]`) or whitespace-split words, the JSON payload appended as its last argument —
   *  never a shell. TRUST-REQUIRED from the project file: a repo-supplied command applies only once that file is
   *  approved in the digest store (mcp/trust.ts); the user file and ROVECODE_NOTIFY_COMMAND always may. */
  notify_command?: string;
  /** the check the loop runs after the agent's last edit before its reply counts as done (core/verify.ts):
   *  one shell command, or a list run in order; `false` turns the gate off AND stops any inference. The
   *  one source that needs no guessing — a project should set this rather than let a `test` script be
   *  inferred, because a gate that runs the wrong command once is turned off forever. */
  verify?: string | string[] | false;
  /** the LSP server table (coding/lsp-servers.ts): `ext[,ext]=argv;…`, `ext=off`, or `off` — merged over the
   *  built-in typescript-language-server entry; ROVECODE_LSP overrides it. Kept as written: a malformed table is
   *  named at boot and in `rovecode doctor` (coding/lsp-gate.ts lspAvailabilityNotes) instead of being dropped here
   *  in silence; the gate applies its valid entries. */
  lsp?: string;
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
  if (typeof r.notify === "string" && ["auto", "bell", "osc9", "osc777"].includes(r.notify)) out.notify = r.notify as Settings["notify"];
  if (r.notify_when === "unfocused" || r.notify_when === "always") out.notify_when = r.notify_when;
  // notify_command: one non-blank string (the argv grammar lives in tui/notify-seq.ts parseArgv); blank means "not set"
  if (typeof r.notify_command === "string" && r.notify_command.trim() !== "" && r.notify_command.length <= 2_000) out.notify_command = r.notify_command;
  // verify: a non-empty command string, a list of them (empty strings dropped, at most 8, each under 500 chars),
  // or `false`. Not a table with the other keys on purpose: the shapes differ (two enums, a boolean, this).
  if (r.verify === false) out.verify = false;
  else if (typeof r.verify === "string" && r.verify.trim() !== "" && r.verify.length <= 500) out.verify = r.verify.trim();
  else if (Array.isArray(r.verify)) {
    const cmds = r.verify.filter((v): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 500).map((v) => v.trim()).slice(0, 8);
    if (cmds.length > 0) out.verify = cmds;
  }
  // lsp: one string (a table can be a whole line; 2 000 chars is room for a dozen servers with quoted paths); blank
  // means "not set" — the knob's own grammar treats blank as the defaults anyway. Not validated here: see the key's doc.
  if (typeof r.lsp === "string" && r.lsp.trim() !== "" && r.lsp.length <= 2_000) out.lsp = r.lsp;
  return out;
}

function readOne(path: string): Settings {
  try { return sanitize(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
}

/** ONE settings file, sanitized and UNGATED — what the file says, for `rovecode trust show` (a person deciding to
 *  approve a file needs to see what it would do) and for a reader that must know WHICH file said something */
export function readSettingsFile(path: string): Settings { return readOne(path); }

/** the command-bearing keys an untrusted project file carries (`verify: false` excepted — a refusal is not a command) */
function commandKeysIn(s: Settings): CommandKey[] {
  return COMMAND_KEYS.filter((k) => s[k] !== undefined && !(k === "verify" && s.verify === false));
}

export interface ScopedSettings {
  user: Settings;
  /** the project file with its command-bearing keys REMOVED when the file is not trusted on this machine */
  project: Settings;
  projectPath: string;
  /** the command-bearing keys the project file carried and lost to the gate — empty when trusted or none */
  dropped: CommandKey[];
}

/** the two scopes apart, the project layer already gated (the trust store is keyed by `projectPath`) */
export function loadSettingsScoped(cwd: string, home: string = rovecodeHome()): ScopedSettings {
  const projectPath = settingsPath("project", cwd);
  const raw = readOne(projectPath);
  const carried = commandKeysIn(raw);
  if (carried.length === 0 || isTrustedFile(home, projectPath)) return { user: readOne(settingsPath("user", cwd)), project: raw, projectPath, dropped: [] };
  const project: Settings = { ...raw };
  for (const k of carried) delete project[k];
  return { user: readOne(settingsPath("user", cwd)), project, projectPath, dropped: carried };
}

/** user then project, project winning key by key — a repo may pin the permission level while the thinking effort
 *  stays whatever you chose globally. The project's command-bearing keys (COMMAND_KEYS) are here ONLY when that file is
 *  trusted: every consumer — verify, lsp, notify — is safe by construction, none of them has to ask. */
export function loadSettings(cwd: string): Settings {
  const s = loadSettingsScoped(cwd);
  return { ...s.user, ...s.project };
}

/** the one boot / doctor line when the gate dropped something from the project file; [] otherwise */
export function settingsTrustNotes(cwd: string, home: string = rovecodeHome()): string[] {
  const s = loadSettingsScoped(cwd, home);
  if (s.dropped.length === 0) return [];
  const keys = s.dropped.join(", ");
  return [untrustedFileNote(s.projectPath, `its ${keys} key${s.dropped.length === 1 ? " is" : "s are"} ignored (a repo file would decide what we run)`)];
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

/** The effort this run starts at — the same precedence sentence as resolvePermission: a flag is
 *  about this run, ROVECODE_EFFORT about this shell, the files about this place, and the floor is
 *  "auto" (the endpoint's own default stands). The `effort` key existed in the file schema from the
 *  start but nothing read it: a `/effort low` died with the terminal, so every launch was back to
 *  the model's default thinking budget — on a reasoning-heavy default that is the difference between
 *  a 5 s answer and a 30 s one (measured, 2026-09-20). */
export function resolveEffort(cwd: string, flag: ThinkingEffort | undefined, env: Record<string, string | undefined> = {}): ThinkingEffort {
  if (flag !== undefined) return flag;
  const fromEnv = parseEffort(env["ROVECODE_EFFORT"]);
  if (fromEnv !== undefined) return fromEnv;
  return loadSettings(cwd).effort ?? "auto";
}
