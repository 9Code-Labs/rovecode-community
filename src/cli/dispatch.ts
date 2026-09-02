/** Pure CLI argv parsing — separated from main.ts (which runs at import) so
 *  dispatch is unit-testable. Flags (--*) never become the command, and neither
 *  does the VALUE of a value-taking flag: `aion --out o.md export abc` must
 *  dispatch `export`, not `o.md` — an unknown cmd falls through to the bare-
 *  prompt one-shot, which spends tokens on a real provider. */

export interface CliInvocation {
  /** first non-flag arg after the script path; "" = interactive default */
  cmd: string;
  plain: boolean;
  yolo: boolean;
  /** args after the command, flags excluded (one-shot prompt words, ids) */
  rest: string[];
}

/** Every flag the CLI hand-parses a VALUE for out of process.argv: --resume
 *  (main.ts, TUI session id), --key (cmdAuth, key name), --out (export.ts, target
 *  path), --output (output.ts, cmdRun output mode). parseCli only skips the value
 *  when locating cmd; the owners still read it themselves, and `rest` keeps
 *  post-command values (cmdAuth/export.ts/output.ts drop their own). Add here
 *  when a new value flag lands. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(["--resume", "--key", "--out", "--output"]);

export function parseCli(argv: string[]): CliInvocation {
  const args = argv.slice(2);
  const isFlag = (a: string) => a.startsWith("-");
  // a token is the command unless it is a flag or the value of the value flag before it
  const cmdIdx = args.findIndex((a, i) => !isFlag(a) && !(i > 0 && VALUE_FLAGS.has(args[i - 1]!)));
  const wantsHelp = args.includes("--help") || args.includes("-h");
  return {
    cmd: wantsHelp && cmdIdx === -1 ? "help" : cmdIdx === -1 ? "" : args[cmdIdx]!,
    plain: args.includes("--plain"),
    yolo: args.includes("--yolo"),
    rest: cmdIdx === -1 ? [] : args.slice(cmdIdx + 1).filter((a) => !isFlag(a)),
  };
}
