/** The ONE rule for a session id (aion hygiene h2, brought over 2026-09-07): a session id is a plain DIRECTORY NAME —
 *  `<sessions root>/<id>` must never resolve outside the root, and listSessions (core/session.ts) takes a session's
 *  identity from its directory name. Refused: the empty (or whitespace-only) string, `.` and `..`, and ANY `/` or `\` —
 *  both separators on every platform: node's basename() only knows the host's separator, so on POSIX `a\b` would pass
 *  as one segment and a session dir created there could never be opened by the same id on Windows (ids travel with
 *  the state dir; they must be portable). Every id-consuming entry point routes through here BEFORE any path join —
 *  the TUI's `--resume` and `rovecode trace` (cli/session-arg.ts), `rovecode export` (cli/export.ts) and the
 *  `sessions` verbs (core/session-ops.ts resolveSession); a bad id is that entry point's usage error (one stderr
 *  line), never a path. Before this, `rovecode --resume ../x` reached `new SessionStore(root, "../x")` and the first
 *  entry was written outside the sessions root. */

import { basename } from "node:path";

/** true when `id` is a plain directory name under the header rule */
export function isPlainSessionId(id: string): boolean {
  return id.trim().length > 0 && id !== "." && id !== ".." && !/[\\/]/.test(id) && basename(id) === id;
}

/** The one-line reason `id` is refused (for a usage message), undefined when it passes. */
export function describeBadSessionId(id: string): string | undefined {
  if (isPlainSessionId(id)) return undefined;
  if (id.trim().length === 0) return "session id is empty";
  return `session id ${JSON.stringify(id)} is not a plain directory name (no / or \\, not . or ..)`;
}
