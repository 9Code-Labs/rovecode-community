/** Which session `rovecode` reopens at boot, from argv.
 *
 *  Three spellings, one rule — an explicit id always wins:
 *    rovecode --resume <id>     that session (a unique prefix resolves in the TUI, session-cmd.ts resolveBootSession)
 *    rovecode --resume          the newest session that holds something
 *    rovecode --continue        the same — the flag every CLI that got this right converged on
 *  `--resume` followed by another flag (`rovecode --resume --yolo`) is `--resume` with no id, never "resume the
 *  session named --yolo".
 *
 *  Two things changed on 2026-09-07 (the aion sessions port, and Berkay's complaint that a wrong id silently gave
 *  him an empty session): a typed id that is invalid (`../x`), unknown or ambiguous is REFUSED before the TUI boots
 *  — exit 2, one stderr line with the reason, through the one resolver every session verb uses (cli/session-arg.ts →
 *  core/session-ops.ts). It used to start a brand-new session under the typed name. And with nothing to continue
 *  from, the TUI still starts fresh (there is nothing else to do) but SAYS so on the startup card (`note`) instead of
 *  looking exactly like a resumed session that happened to be empty. */

import { newestSession } from "../core/session.ts";
import { resolveSessionArg } from "./session-arg.ts";

export interface ResumeRequest {
  /** the id or prefix the user named */
  id?: string;
  /** `--continue`, or `--resume` with no id: reopen the newest non-empty session */
  newest: boolean;
}

export function parseResume(argv: readonly string[]): ResumeRequest {
  const ix = argv.indexOf("--resume");
  const arg = ix !== -1 ? argv[ix + 1] : undefined;
  const id = arg !== undefined && !arg.startsWith("-") ? arg : undefined;
  return { ...(id !== undefined ? { id } : {}), newest: id === undefined && (ix !== -1 || argv.includes("--continue")) };
}

export interface BootSession {
  /** the session to open; undefined = a fresh one */
  id?: string;
  /** what the startup card says when the request could not be honoured as a resume (nothing to continue from) */
  note?: string;
}

export const NOTHING_TO_CONTINUE = "nothing to continue from — this is a new session";

/** The session to boot with. A typed id goes through the one resolver (validity, exact, unique prefix; anything
 *  else is `fail`, which by default exits 2 with one stderr line). `--continue` / bare `--resume` with no session
 *  holding anything starts fresh WITH a note. Reads only: nothing is created here. */
export function resolveBoot(argv: readonly string[], sessionsDir: string, fail?: (msg: string) => never): BootSession {
  const r = parseResume(argv);
  if (r.id !== undefined) return { id: resolveSessionArg("--resume", sessionsDir, r.id, fail) };
  if (!r.newest) return {};
  const newest = newestSession(sessionsDir);
  return newest ? { id: newest.id } : { note: NOTHING_TO_CONTINUE };
}

/** The session id to boot with, or undefined for a fresh one (the id half of resolveBoot). */
export function resolveResume(argv: readonly string[], sessionsDir: string, fail?: (msg: string) => never): string | undefined {
  return resolveBoot(argv, sessionsDir, fail).id;
}
