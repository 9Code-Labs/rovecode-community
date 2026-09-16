/** `--add-dir <dir>` (ported from the Nimbus harness, PORT #81; the rest of Nimbus's run-flags.ts — --continue, --resume,
 *  --cwd, --model — rovecode already has in cli/resume.ts, cli/run-limits.ts and main.ts, so only the flag that was
 *  missing lives here).
 *
 *  Repeatable, `--add-dir=<dir>` form too, EVERY occurrence of argv (unlike the last-wins value flags), each resolved
 *  against `base` — the LAUNCH dir — and validated NOW, before any boot: a missing path or a file is
 *  `--add-dir "<v>" is not a directory`, a filesystem root the "would disable the workspace boundary — pass --yolo"
 *  line (core/workspace.ts rootProblem), a missing or flag-shaped value `--add-dir needs a value`. Exact duplicates
 *  collapse here; canonical duplicates / nesting are dropped with a note by resolveRoots at boot. A usage error is
 *  exit 2 and leaves no session dir behind; `fail` is injectable for tests. `--add-dir` must also sit in
 *  cli/dispatch.ts VALUE_FLAGS so its value never becomes the command or a prompt word — the --max-cost bug class. */

import { resolve } from "node:path";
import { rootProblem } from "../core/workspace.ts";

export const ADD_DIR_FLAG = "--add-dir";
export const ADD_DIR_USAGE = 'usage: rovecode [run] [--add-dir <dir>]… — an extra workspace root beside the cwd (repeatable; --add-dir=<dir> too)';

const usageExit = (msg: string): never => {
  process.stderr.write(`error: ${msg} — ${ADD_DIR_USAGE}\n`); // ONE stderr line, like the sibling usage errors
  return process.exit(2);
};

/** a token that is a flag, not a value: `-x`, `--x` (a lone `-` is stdin, a value) */
const isFlagToken = (a: string): boolean => a.length > 1 && a.startsWith("-");

export function parseAddDirs(argv: readonly string[], fail: (msg: string) => never = usageExit, base = process.cwd()): string[] {
  const args = argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let v: string | undefined;
    if (a === ADD_DIR_FLAG) { v = args[i + 1]; if (v === undefined || isFlagToken(v)) return fail(`${ADD_DIR_FLAG} needs a value`); i++; }
    else if (a.startsWith(`${ADD_DIR_FLAG}=`)) v = a.slice(ADD_DIR_FLAG.length + 1);
    else continue;
    if (v.trim().length === 0) return fail(`${ADD_DIR_FLAG} needs a directory`);
    const abs = resolve(base, v);
    const problem = rootProblem(abs, v);
    if (problem !== undefined) return fail(problem);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}
