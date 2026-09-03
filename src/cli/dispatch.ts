/** Pure CLI argv parsing — separated from main.ts (which runs at import) so
 *  dispatch is unit-testable. Flags (--*) never become the command, and neither
 *  does the VALUE of a value-taking flag: `rovecode --out o.md export abc` must
 *  dispatch `export`, not `o.md` — an unknown cmd falls through to the bare-
 *  prompt one-shot, which spends tokens on a real provider. */

import { parseEffort, type ThinkingEffort } from "../core/types.ts";

export interface CliInvocation {
  /** first non-flag arg after the script path; "" = interactive default */
  cmd: string;
  plain: boolean;
  yolo: boolean;
  /** the middle tier: writes inside the workspace stop asking (ROVECODE_ACCEPT_EDITS=1 does the same) */
  acceptEdits: boolean;
  /** `--effort off|low|medium|high` — how hard the model thinks (ROVECODE_EFFORT does the same); absent when not given */
  effort?: ThinkingEffort;
  /** port #44: `--classic` forces the pi-tui chat (the sextant surface is the default on a capable TTY) */
  classic: boolean;
  /** port #44: `--pet <name>` names the sextant pet (TUI-only value flag; absent when not given) */
  pet?: string;
  /** args after the command, flags excluded (one-shot prompt words, ids) */
  rest: string[];
}

/** Every flag the CLI hand-parses a VALUE for out of process.argv: --resume
 *  (main.ts, TUI session id), --key (cmdAuth, key name), --out (export.ts, target
 *  path), --output (output.ts, cmdRun output mode), --pet (here, the sextant pet
 *  name), --protocol / --key-env / --model / --scope (cmdProvider, `rovecode provider add`;
 *  providers/registry.ts parseAddArgs). parseCli only skips the value when locating cmd;
 *  the owners still read it themselves, and `rest` keeps post-command values
 *  (cmdAuth/export.ts/output.ts drop their own). Add here when a new value flag lands. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(["--resume", "--key", "--out", "--output", "--pet", "--effort", "--protocol", "--key-env", "--model", "--scope"]);

export function parseCli(argv: string[]): CliInvocation {
  const args = argv.slice(2);
  const isFlag = (a: string) => a.startsWith("-");
  // a token is the command unless it is a flag or the value of the value flag before it
  const cmdIdx = args.findIndex((a, i) => !isFlag(a) && !(i > 0 && VALUE_FLAGS.has(args[i - 1]!)));
  const wantsHelp = args.includes("--help") || args.includes("-h");
  // --pet <name>: a flag-shaped "value" is not a value (the flag after it stays a flag)
  const petIdx = args.indexOf("--pet");
  const petArg = petIdx !== -1 ? args[petIdx + 1] : undefined;
  const pet = petArg !== undefined && !isFlag(petArg) ? petArg : undefined;
  // --effort <level>: an unrecognized word is DROPPED, not read as "off" — a typo must leave the
  // runtime's own default in place rather than silently turning thinking off
  const effIdx = args.indexOf("--effort");
  const effortArg = parseEffort(effIdx !== -1 ? args[effIdx + 1] : undefined);
  return {
    cmd: wantsHelp && cmdIdx === -1 ? "help" : cmdIdx === -1 ? "" : args[cmdIdx]!,
    plain: args.includes("--plain"),
    yolo: args.includes("--yolo"),
    acceptEdits: args.includes("--accept-edits"),
    ...(effortArg !== undefined ? { effort: effortArg } : {}),
    classic: args.includes("--classic"),
    ...(pet !== undefined ? { pet } : {}),
    rest: cmdIdx === -1 ? [] : args.slice(cmdIdx + 1).filter((a) => !isFlag(a)),
  };
}
