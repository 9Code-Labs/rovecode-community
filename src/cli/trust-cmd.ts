/** `rovecode trust` — the approval verb for every project file the trust gate covers (core/trust.ts): settings.json's
 *  command-bearing keys, hooks.ts, sandbox.json, the MCP files. `trust show` says what each file WOULD do; `trust [--yes]`
 *  approves them as they are now (a TTY confirms after the listing; off a TTY --yes is required); `trust untrust` withdraws.
 *  `rovecode mcp trust` keeps working and acts on the MCP files only — the same store, so nothing already approved is lost. */

import { rovecodeHome } from "../providers/auth.ts";
import { projectTrustRows, trustRows, trustShowLines, untrustRows } from "../core/project-trust.ts";

export const TRUST_USAGE = [
  "usage: rovecode trust                 list this repo's gated files with what they would do, then approve them (asks on a TTY)",
  "       rovecode trust --yes           approve without asking (after reading `trust show`)",
  "       rovecode trust show            list only — nothing changes",
  "       rovecode trust untrust         withdraw the approval; the files contribute nothing again until trusted",
  "  gated: .rovecode/settings.json (verify, lsp, notify_command) · .rovecode/hooks.ts|js · .rovecode/sandbox.json · .rovecode/mcp.json · .mcp.json",
  "  the store is ~/.rovecode/plugins.json (path → sha256): any edit to a file asks again",
];

export interface TrustCmdIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** default rovecodeHome() */
  home?: string;
  /** default process.stdin.isTTY */
  tty?: boolean;
  /** the confirmation prompt (default Bun's confirm()) */
  confirm?: (question: string) => Promise<boolean> | boolean;
}

export async function cmdTrust(argv: string[], cwd: string = process.cwd(), io: TrustCmdIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const home = io.home ?? rovecodeHome();
  const words = argv.filter((a) => !a.startsWith("--"));
  const yes = argv.includes("--yes");
  const verb = words[0] ?? "";
  if (verb === "-h" || verb === "help" || argv.includes("--help")) { for (const l of TRUST_USAGE) out(l); return 0; }
  if (verb !== "" && verb !== "show" && verb !== "untrust") { err(`unknown trust command "${verb}"`); for (const l of TRUST_USAGE) err(l); return 2; }
  const rows = projectTrustRows(cwd, home);
  if (verb === "show") { for (const l of trustShowLines(rows)) out(l); return 0; }
  if (verb === "untrust") { for (const l of untrustRows(home, rows)) out(l); return 0; }
  if (rows.length === 0) { for (const l of trustShowLines(rows)) out(l); return 1; }
  for (const l of trustShowLines(rows)) out(l);
  if (!yes) {
    const tty = io.tty ?? process.stdin.isTTY === true;
    if (!tty) { err("nothing trusted: no terminal to confirm on — re-run with --yes after reading the lines above"); return 1; }
    const ask = io.confirm ?? ((q: string) => confirm(q));
    if (!(await ask("trust these files as they are now? [y/N]"))) { out("nothing trusted"); return 1; }
  }
  for (const l of trustRows(home, rows)) out(l);
  out("restart rovecode to apply — an edit to any of these files asks again");
  return 0;
}
