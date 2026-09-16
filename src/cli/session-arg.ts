/** A session id typed on the command line (aion hygiene h2, brought over 2026-09-07): the CLI's ONE gate for the entry
 *  points that used to take an id straight into a path join — `rovecode --resume <id|prefix>` (main.ts hand-parses the
 *  value) and `rovecode trace <id|prefix>`. Both resolve here through core/session-ops.ts resolveSession: validity
 *  first (core/session-id.ts), then an exact id or a UNIQUE prefix among the sessions under the root; a miss or an
 *  ambiguity is the usage error, never a fresh session dir under the typed name (which is what `--resume typo` used to
 *  create, silently). A bad id is exit 2 with ONE stderr line; `fail` is injectable for tests. */

import { describeBadSessionId } from "../core/session-id.ts";
import { resolveSession } from "../core/session-ops.ts";

const usageExit = (msg: string): never => {
  process.stderr.write(`error: ${msg}\n`); // ONE stderr line
  return process.exit(2);
};

/** `<what> <id>`: the id, or the usage error — missing, empty, `.`/`..`, a separator (core/session-id.ts). */
export function sessionIdArg(what: string, id: string | undefined, fail: (msg: string) => never = usageExit): string {
  if (id === undefined) return fail(`${what} needs a session id or prefix`);
  const bad = describeBadSessionId(id);
  return bad === undefined ? id : fail(`${what}: ${bad}`);
}

/** Validity (sessionIdArg) + resolution against the sessions under `root`: an exact id wins, else exactly ONE prefix
 *  match; several or none is the usage error naming them (never the first hit, never a new directory). */
export function resolveSessionArg(what: string, root: string, id: string | undefined, fail: (msg: string) => never = usageExit): string {
  const wanted = sessionIdArg(what, id, fail);
  const r = resolveSession(root, wanted);
  if (r.ok) return r.id;
  return fail(r.error.startsWith("no session matching") ? `${what}: ${r.error} in ${root} (rovecode sessions lists them)` : `${what}: ${r.error}`);
}
