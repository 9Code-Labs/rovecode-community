/** Which session `rovecode` reopens at boot, from argv.
 *
 *  Three spellings, one rule — an explicit id always wins:
 *    rovecode --resume <id>     that session (a unique prefix resolves in the TUI, session-cmd.ts resolveBootSession)
 *    rovecode --resume          the newest session that holds something
 *    rovecode --continue        the same — the flag every CLI that got this right converged on
 *  `--resume` followed by another flag (`rovecode --resume --yolo`) is `--resume` with no id, never "resume the
 *  session named --yolo". With nothing to continue from, the answer is undefined and the TUI starts fresh, as
 *  it always did; that is the honest outcome, not an error. */

import { newestSession } from "../core/session.ts";

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

/** The session id to boot with, or undefined for a fresh one. */
export function resolveResume(argv: readonly string[], sessionsDir: string): string | undefined {
  const r = parseResume(argv);
  if (r.id !== undefined) return r.id;
  return r.newest ? newestSession(sessionsDir)?.id : undefined;
}
