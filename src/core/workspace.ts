/** Workspace roots + the `file.external` boundary (ported from the Nimbus harness, PORT #81).
 *
 *  Until this port nothing locked the file tools to the cwd: read / edit / write / glob / grep / ls open any
 *  absolute path verbatim (coding/hashline.ts, coding/files.ts, coding/diff.ts resolvePath) and the gated rule set
 *  says `file.read * allow` — so an absolute path outside the project was read silently. This module INTRODUCES
 *  the boundary and `--add-dir <dir>` widens it:
 *    - the cwd (ToolContext.cwd — a task child's own dir for children) is the implicit root; every `--add-dir`
 *      value is an extra root, canonicalised (realpath through the deepest existing ancestor: junction, 8.3 and
 *      case spellings collapse), deduplicated, and dropped with ONE note when it lies inside the cwd or inside
 *      another root; a value that is not a directory, or is a filesystem root (`C:\`, `/` — it would disable the
 *      boundary), is an error the surfaces turn into exit 2;
 *    - containment is `path.relative` (not a string prefix: `E:\proj2\x` is OUTSIDE `E:\proj`; on win32 relative()
 *      compares case-insensitively, so a non-existent tail keeps working), both sides canonical — a junction inside
 *      the cwd that points outside is OUTSIDE, because its real target is;
 *    - the ONE ladder (core/tools.ts dispatch step 2a) evaluates the action `file.external` for a path-declared tool
 *      whose canonical resource is outside the cwd, with resource `<real containing dir>\*` (the parent dir of a
 *      file target, the dir itself when glob/grep/ls name an existing directory, `C:\*` for a drive root): the
 *      built-in gated set says `file.external * prompt`, yolo's `* * allow` covers it, the roots enter as
 *      `allow file.external <root>\*` rules after the built-in set; the prompt names the path, the cwd, the roots
 *      that exist and the remedy — never a bare denial;
 *    - what a tool OPENS is what the ladder JUDGED: toolPath() below is the ONE spelling rule — `path.resolve`
 *      against the cwd, so `.` / `..` collapse LEXICALLY before any filesystem lookup — shared by core/tools.ts
 *      describeResource and the read / edit / write / glob / grep / ls tools and the diff preview. A
 *      `<cwd>/<symlink>/../<outside>` spelling therefore names `<cwd>/<outside>` on BOTH sides: the symlink is never
 *      handed to the kernel (a POSIX kernel applies `..` to the link's TARGET; Win32 collapses it lexically), so a
 *      lexical INSIDE verdict can no longer open an OUTSIDE file. The direct `<cwd>/<symlink>/<file>` spelling
 *      stays OUTSIDE via realpath.
 *  Pure over the filesystem: no settings knob, no env — a repo must never widen its own roots.
 *
 *  What the boundary does NOT cover, said plainly: `bash` is not path-declared, so `cd ../other && …` is judged
 *  as a shell command (its own rules), not as a path; the executor's cwd lock is what bash has. And checkpoints
 *  (coding/checkpoints.ts) are ONE shadow repository whose work-tree is the cwd: a change under an added root is
 *  not snapshotted and /restore does not undo it — WorkspaceRoots.checkpointNote() says so at boot and in
 *  `rovecode doctor` rather than letting one root look whole. Spanning roots means one shadow repo per root; not
 *  built here.
 *
 *  Pattern sources (pattern level, no code copied):
 *    - opencode (MIT): `packages/opencode/src/tool/external-directory.ts` :15-45 (a target outside the instance
 *      directory asks an `external_directory` permission whose pattern AND `always` grant is `path.join(dir, "*")`),
 *      `packages/core/src/fs-util.ts` :270-273 contains() (`relative` result not absolute / not `..`-prefixed),
 *      `packages/opencode/src/project/instance-context.ts` :18-24 containsPath (a `/` worktree is never a boundary);
 *    - gemini-cli (Apache-2.0): `packages/core/src/utils/workspaceContext.ts` :262-272 isPathWithinRoot (the same
 *      relative() rule over fully-resolved paths), and the `--include-directories` flag name; Claude Code's
 *      `--add-dir` is a flag-name mention only (proprietary). */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { PermissionRule } from "./types.ts";

/** the ladder action a path-declared tool's call outside the workspace is evaluated under */
export const EXTERNAL_ACTION = "file.external";

/** The canonical spelling of a path: its real path (symlinks, junctions, 8.3 short names and drive-letter case
 *  resolved). A path that does not (or no longer) exist keys as the real path of its deepest existing ancestor plus
 *  the missing tail — so a file the model is about to CREATE inside a junction is still judged by where the junction
 *  really points. (The Nimbus tree kept this in core/trust.ts as trustKey; rovecode has no trust store, so it lives
 *  here — the one canonicalisation for roots, resources and grants.) */
export function canonical(p: string): string {
  const abs = resolve(p);
  try { return realpathSync.native(abs); } catch { /* not on disk: resolve through the existing ancestors below */ }
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonical(parent), basename(abs));
}

/** The ONE spelling a `path` argument has for BOTH the ladder (core/tools.ts describeResource) and the tool that opens it
 *  (coding/hashline.ts read / edit / write, coding/files.ts glob / grep / ls, coding/diff.ts previewDiff): `path.resolve`
 *  against the cwd — absolute, with `.` / `..` / doubled and mixed separators collapsed LEXICALLY before any filesystem lookup
 *  and a trailing separator dropped. On win32 a rooted spelling without a drive (`/workspace/x`) resolves on the PROCESS's
 *  current drive — that is where node:fs opens it, so it is judged there too (a posix carve-out would let `/proj/.env` dodge an
 *  absolute deny). The lexical collapse is the point: `<cwd>/<symlink>/../<outside>` names `<cwd>/<outside>` here, so the
 *  symlink never reaches the kernel and the tool opens exactly the path policy judged. */
export function toolPath(cwd: string, p: string): string {
  return resolve(isAbsolute(p) ? p : join(cwd, p));
}

/** is `p` inside `root` (or root itself)? Both CANONICAL. `path.relative`, not a prefix test: `E:\proj2` is not inside `E:\proj`;
 *  on win32 relative() is case-insensitive (opencode fs-util contains(); gemini-cli isPathWithinRoot) */
export function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
}

/** is the canonical form of `resource` outside the canonical form of `cwd`? (the dispatch gate) */
export function outsideWorkspace(cwd: string, resource: string): boolean { return !isInside(canonical(cwd), canonical(resource)); }

function isDirectory(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

/** the `file.external` resource for a path resource: `<canonical containing dir>\*` — the dir itself when the target is an
 *  existing directory (glob / grep / ls), else its parent; a drive / filesystem root gives `C:\*` / `/*` (opencode's
 *  `path.join(dir, "*")` pattern). The glob is the SAVED / CACHED shape too, so a second file in that dir matches it. */
export function externalResource(resource: string): string {
  const c = canonical(resource);
  return join(isDirectory(c) ? c : dirname(c), "*");
}

/** the ONE prompt text for a call outside the workspace: names the path, the cwd, the roots the ladder already allows
 *  (its `allow file.external <dir>\*` rules — `--add-dir` roots and grants) and the remedy. Never a bare denial. */
export function outsidePrompt(resource: string, cwd: string, rules: readonly PermissionRule[]): string {
  const roots = rules.filter((r) => r.action === EXTERNAL_ACTION && r.effect === "allow" && r.resource !== "*").map((r) => r.resource);
  return `${resource} is outside the workspace ${cwd}${roots.length > 0 ? ` and its roots ${roots.join(", ")}` : ""} — allow once/always for this directory, or start rovecode with --add-dir <dir> to make it a workspace root`;
}

/** why `abs` cannot be a workspace root (`spelled` = the value as the user typed it), or undefined when it can */
export function rootProblem(abs: string, spelled: string): string | undefined {
  // a `*` in the name (POSIX allows it) would be a ladder wildcard in the root's `allow file.external <dir>\*` rule; checked on
  // the spelling first (before the stat) and again on the real path (a link whose target's name holds `*`)
  const wildcard = `--add-dir "${spelled}": the directory name contains "*", a rule wildcard (no escape syntax) — its allow rule would match more than that directory`;
  if (abs.includes("*")) return wildcard;
  if (!isDirectory(abs)) return `--add-dir "${spelled}" is not a directory`;
  const c = canonical(abs);
  if (c.includes("*")) return wildcard;
  if (parse(c).root === c) return `--add-dir "${spelled}" is a filesystem root — it would disable the workspace boundary — pass --yolo instead`;
  return undefined;
}

export interface ResolvedRoots { dirs: string[]; notes: string[] }

/** thrown by resolveRoots for a value that cannot be a root (cli/runtime.ts turns it into a startup error → exit 2) */
export class WorkspaceRootError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceRootError"; }
}

/** Canonicalise `addDirs` (each resolved against `base` — the LAUNCH dir) into the extra roots: duplicates, a dir inside the
 *  cwd and a dir inside another root are dropped (a later root that CONTAINS an earlier one replaces it) with ONE note line;
 *  a non-directory or a filesystem root throws WorkspaceRootError. */
export function resolveRoots(cwd: string, addDirs: readonly string[] = [], base: string = process.cwd()): ResolvedRoots {
  const home = canonical(cwd);
  const dirs: string[] = [], dropped: string[] = [];
  for (const spelled of addDirs) {
    const abs = resolve(base, spelled);
    const problem = rootProblem(abs, spelled);
    if (problem !== undefined) throw new WorkspaceRootError(problem);
    const c = canonical(abs);
    if (isInside(home, c) || dirs.some((d) => isInside(d, c))) { dropped.push(spelled); continue; }
    for (const d of dirs) if (isInside(c, d)) dropped.push(d); // the wider root replaces the narrower one
    dirs.splice(0, dirs.length, ...dirs.filter((d) => !isInside(c, d)), c);
  }
  const notes = dropped.length === 0 ? [] : [`rovecode: --add-dir: ${dropped.length} value${dropped.length === 1 ? "" : "s"} dropped — already inside the workspace ${home} or another root: ${dropped.join(", ")}`];
  return { dirs, notes };
}

/** The roots a runtime carries: canonical cwd + extra dirs, their ladder rules and the banner / prompt spellings. */
export class WorkspaceRoots {
  readonly cwd: string;
  readonly dirs: readonly string[];
  readonly notes: readonly string[];

  constructor(cwd: string, resolved: ResolvedRoots = { dirs: [], notes: [] }) {
    this.cwd = canonical(cwd);
    this.dirs = resolved.dirs;
    this.notes = resolved.notes;
  }

  /** the extra root containing `abs` (canonical compare), or undefined — cwd is not a root here (callers fall back to it) */
  rootOf(abs: string): string | undefined {
    const c = canonical(abs);
    return this.dirs.find((d) => isInside(d, c));
  }

  /** `allow file.external <root>\*` per extra root — the ladder layer right after the built-in set */
  rules(): PermissionRule[] {
    return this.dirs.map((d) => ({ action: EXTERNAL_ACTION, resource: join(d, "*"), effect: "allow" as const }));
  }

  /** `allow file.write <root>\*` per extra root — what accept-edits adds for the cwd, extended to every root, so a root is
   *  visible everywhere a permission decision is made (the cwd's own rule stays where runtime.ts puts it) */
  acceptEditsRules(): PermissionRule[] {
    return this.dirs.map((d) => ({ action: "file.write", resource: join(d, "*"), effect: "allow" as const }));
  }

  /** the banner spelling: `+<dir> +<dir>` ("" without roots) */
  describe(): string { return this.dirs.map((d) => `+${d}`).join(" "); }

  /** the system-prompt sentence; "" without roots (the prompt stays byte-identical) */
  promptLine(): string {
    return this.dirs.length === 0 ? "" : `\n\nAdditional workspace roots (name them by absolute path): ${this.dirs.join(", ")}`;
  }

  /** the limit, named: checkpoints (coding/checkpoints.ts) snapshot the cwd only. "" without roots. Shown once at boot on every
   *  surface and as the doctor row's detail — a root that looks checkpointed and is not would be the silent kind of wrong. */
  checkpointNote(): string {
    return this.dirs.length === 0 ? "" : `roots: ${this.describe()} — checkpoints cover ${this.cwd} only; a change under an added root is not snapshotted and /restore does not undo it`;
  }
}
