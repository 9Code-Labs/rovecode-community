/** `/trust` in the TUI — the approval card for the project trust gate (core/trust.ts, 08f355a), which until now could
 *  only be answered by QUITTING the TUI and running `rovecode trust`. A security gate whose only yes is "leave the thing
 *  you are doing" is a gate people switch off, so this is the same decision without the exit.
 *
 *  NOT the aion port of the same file name. aion's src/tui/trust-card.ts asks about a FOLDER (decideTrust, trust.json,
 *  "trust this folder / just this session / never", and a PreBootHooks so runTui can ask before createRuntime); rovecode's
 *  gate is per-FILE and keyed by sha256 in the user home, so there is no folder answer to give and no boot ordering to
 *  bend — the decision here is "these bytes of THIS file", one file at a time. Everything the person reads before
 *  answering comes from core/project-trust.ts (projectTrustRows → trustShowLines), the same lines `rovecode trust show`
 *  prints: the terminal and the TUI must not describe the same file differently.
 *
 *  Two rules the card is built around, both of them Berkay's:
 *   - approving is a DECISION, not a keystroke: the first item of the picker — the one Enter lands on — is "keep them
 *     untrusted". There is no default yes, and Esc is the same refusal.
 *   - no bulk yes without showing what "all" is: the carries lines are printed BEFORE the picker every time, and
 *     "approve all N files" only appears when N > 1 (with one file it would be a second spelling of the same item).
 *  Approving does not retro-load anything — hooks.ts is imported at boot, sandbox.json picks the executor at boot — so
 *  the card closes with the CLI's own sentence: restart to apply. */

import { relative } from "node:path";
import { projectTrustRows, trustRows, trustShowLines, untrustedRows, untrustRows, type TrustRow } from "../core/project-trust.ts";
import { trustFile } from "../core/trust.ts";
import { rovecodeHome } from "../providers/auth.ts";
import type { PickItem, Renderer } from "./renderer.ts";

export const TRUST_CARD_USAGE = "/trust — review this repo's gated files and approve them · /trust show — review only · /trust untrust — withdraw";

/** the palette entry (the mcp-cmd.ts idiom, so app.ts's table gains ONE line) */
export const TRUST_SUBCOMMANDS = ["show", "untrust"] as const;
export const TRUST_COMMAND = { name: "trust", choices: TRUST_SUBCOMMANDS, choicesThen: "submit" as const, description: "Review what this repo's config would run and approve it: /trust · /trust show · /trust untrust", group: "modes & safety" };

/** picker value of the refusal (first item) and of the bulk approval — neither can collide with a file path */
export const KEEP_UNTRUSTED = "\u0000keep-untrusted";
export const TRUST_ALL = "\u0000trust-all";

export const RESTART_NOTE = "restart rovecode to apply — an edit to any of these files asks again";

export interface TrustCardCtx {
  renderer: Renderer;
  cwd: string;
  /** the trust store's home; default rovecodeHome() (tests point it at a scratch dir) */
  home?: string;
}

/** the picker for the untrusted rows: refusal FIRST, then one item per file, then the bulk item when there are several */
export function trustPickItems(untrusted: readonly TrustRow[], cwd: string): PickItem[] {
  const items: PickItem[] = [{ value: KEEP_UNTRUSTED, label: "keep them untrusted", description: "nothing from these files is used; you will be asked again next launch" }];
  for (const r of untrusted) items.push({ value: r.file, label: `approve ${rel(r.file, cwd)}`, description: r.carries.join(" · ") });
  if (untrusted.length > 1) items.push({ value: TRUST_ALL, label: `approve all ${untrusted.length} files`, description: untrusted.map((r) => rel(r.file, cwd)).join(", ") });
  return items;
}

const rel = (file: string, cwd: string): string => { const r = relative(cwd, file); return r === "" || r.startsWith("..") ? file : r; };

export function trustCardTitle(cwd: string, untrusted: readonly TrustRow[]): string {
  const what = untrusted.length === 1 ? "1 file" : `${untrusted.length} files`;
  return `${cwd}: ${what} would make rovecode run something and ${untrusted.length === 1 ? "is" : "are"} not trusted on this machine — the lines above say what each one carries. Enter on the first item changes nothing (Esc the same).`;
}

/** `/trust [show|untrust]` — the review lines, then (bare verb only) the approval card */
export async function cmdTrustCard(ctx: TrustCardCtx, arg = ""): Promise<void> {
  const { renderer } = ctx;
  const home = ctx.home ?? rovecodeHome();
  const verb = arg.trim().split(/\s+/).filter(Boolean)[0] ?? "";
  if (verb !== "" && verb !== "show" && verb !== "untrust") { renderer.addSystemNote(`unknown /trust verb "${verb}" — ${TRUST_CARD_USAGE}`, "warn"); return; }
  const rows = projectTrustRows(ctx.cwd, home);
  if (verb === "untrust") { for (const l of untrustRows(home, rows)) renderer.addSystemNote(l); return; }
  show(ctx, rows);
  if (verb === "show" || rows.length === 0) return;
  if (untrustedRows(rows).length === 0) { renderer.addSystemNote("every gated file here is already trusted — nothing to approve"); return; }
  await ask(ctx, home);
}

/** the `trust show` lines, verbatim from project-trust.ts; an untrusted file's header is a warn so it is not read as prose */
function show(ctx: TrustCardCtx, rows: readonly TrustRow[]): void {
  for (const line of trustShowLines([...rows])) ctx.renderer.addSystemNote(line, line.startsWith("· UNTRUSTED") ? "warn" : "info");
}

/** one card per remaining untrusted file: approve one → re-list what is left → ask again, until the person refuses
 *  (Enter on the first item / Esc) or nothing is left. `trustFile` records the file's CURRENT bytes. */
async function ask(ctx: TrustCardCtx, home: string): Promise<void> {
  const { renderer } = ctx;
  let approved = 0;
  for (;;) {
    const untrusted = untrustedRows(projectTrustRows(ctx.cwd, home));
    if (untrusted.length === 0) break;
    const picked = await renderer.pickOne(trustPickItems(untrusted, ctx.cwd), trustCardTitle(ctx.cwd, untrusted));
    if (picked === null || picked === KEEP_UNTRUSTED) {
      renderer.addSystemNote(`${untrusted.length} file${untrusted.length === 1 ? "" : "s"} left untrusted — ${untrusted.map((r) => rel(r.file, ctx.cwd)).join(", ")} contribute nothing this session`, "warn");
      break;
    }
    if (picked === TRUST_ALL) {
      for (const l of trustRows(home, untrusted)) renderer.addSystemNote(l);
      approved += untrusted.length;
      break;
    }
    const row = untrusted.find((r) => r.file === picked);
    if (row === undefined) break; // a file that vanished between the card and the answer: nothing to record
    const t = trustFile(home, row.file);
    if (!t.ok) { renderer.addSystemNote(t.reason, "warn"); break; }
    renderer.addSystemNote(`trusted ${row.file}  (${t.digest.slice(0, 12)}…)`);
    approved++;
    if (untrusted.length === 1) break; // that was the last one; the loop's re-list would only confirm it
    show(ctx, untrustedRows(projectTrustRows(ctx.cwd, home)));
  }
  if (approved > 0) ctx.renderer.addSystemNote(RESTART_NOTE);
}
