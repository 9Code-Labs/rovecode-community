/** Pure CLI argv parsing — separated from main.ts (which runs at import) so
 *  dispatch is unit-testable. Flags (--*) never become the command. */

export interface CliInvocation {
  /** first non-flag arg after the script path; "" = interactive default */
  cmd: string;
  plain: boolean;
  yolo: boolean;
  /** args after the command, flags excluded (one-shot prompt words, ids) */
  rest: string[];
}

export function parseCli(argv: string[]): CliInvocation {
  const args = argv.slice(2);
  const cmdIdx = args.findIndex((a) => !a.startsWith("--"));
  return {
    cmd: cmdIdx === -1 ? "" : args[cmdIdx]!,
    plain: args.includes("--plain"),
    yolo: args.includes("--yolo"),
    rest: cmdIdx === -1 ? [] : args.slice(cmdIdx + 1).filter((a) => !a.startsWith("--")),
  };
}
