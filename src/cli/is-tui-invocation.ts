/** Returns true when argv will start the interactive TUI (as opposed to a lightweight subcommand).
 *  Used by bin/rovecode.ts to decide whether to route through the pre-bundled dist/cli/main.js. */
import { parseCli } from "./dispatch.ts";

export function isTuiInvocation(argv: string[]): boolean {
  const { cmd, plain } = parseCli(argv);
  return (cmd === "" || cmd === "chat" || cmd === "repl") && !plain;
}
