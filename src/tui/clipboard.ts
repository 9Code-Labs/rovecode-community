/** System clipboard writer for `/copy` (port #53). ONE candidate chain per platform family, tried in
 *  order until one succeeds; the process spawner is injectable so tests pin the order with a fake and
 *  the only real-process test is the Windows round-trip (clipboard.test.ts, skipped elsewhere).
 *    win32       powershell — `Set-Clipboard` fed the text on stdin, decoded as UTF-8 explicitly
 *                ([Console]::InputEncoding, else the OEM code page garbles non-ASCII; verified: a string
 *                with accents, an em dash, a check mark and CJK reads back byte-identical via
 *                `Get-Clipboard -Raw`). clip.exe is NOT in the chain: its stdin decoding is code-page
 *                dependent and was not proven.
 *    everything  pbcopy (macOS) → wl-copy (Wayland) → xclip -selection clipboard → xsel --clipboard --input
 *    else        — one chain for every non-Windows platform: a tool the host lacks fails to spawn
 *                (ENOENT) and the chain simply moves on, so macOS stops at pbcopy and Linux skips it
 *  A missing binary, a non-zero exit and a spawn error all mean "next candidate"; when the chain is
 *  exhausted the result says which tools were tried. Never throws.
 *
 *  Pattern reference only, no code ported: gemini-cli @ 0bd1d43 packages/cli/src/ui/commands/
 *  copyCommand.ts (the last model message's text parts joined, "no output" / "no text" notes, :24-68).
 *  gemini hands the write to the `clipboardy` package behind an OSC-52 attempt
 *  (ui/utils/commandUtils.ts:256-283); the explicit tool chain, the stdin-fed PowerShell form and the
 *  injectable spawner are rovecode's. */

export interface SpawnOutcome { ok: boolean; detail?: string }

/** Run `argv` with `input` on stdin; resolve ok on exit 0. Rejections are treated as failures. */
export type ClipboardSpawn = (argv: readonly string[], input: string) => Promise<SpawnOutcome>;

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  spawn?: ClipboardSpawn;
}

export type ClipboardResult =
  | { ok: true; tool: string }
  | { ok: false; tried: string[]; detail?: string };

/** Windows: read ALL of stdin as UTF-8 (the default console input encoding is the OEM code page)
 *  and hand it to Set-Clipboard verbatim — no trailing newline added, no line splitting. */
export const WIN_SET_CLIPBOARD = "[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t";

/** The candidates for a platform, in the order they are tried (header): PowerShell alone on Windows,
 *  the pbcopy → wl-copy → xclip → xsel chain everywhere else. */
export function clipboardChain(platform: NodeJS.Platform): readonly (readonly string[])[] {
  if (platform === "win32") return [["powershell", "-NoProfile", "-NonInteractive", "-Command", WIN_SET_CLIPBOARD]];
  return [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

/** Default spawner: Bun.spawn with the text piped to stdin. A missing binary throws synchronously
 *  (ENOENT) — caught here and reported as a failed candidate, like a non-zero exit. */
export const bunClipboardSpawn: ClipboardSpawn = async (argv, input) => {
  try {
    const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    proc.stdin.write(input);
    await proc.stdin.end();
    const code = await proc.exited;
    if (code === 0) return { ok: true };
    const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? "";
    return { ok: false, detail: `exit ${code}${err ? `: ${err.slice(0, 120)}` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

/** Copy `text` to the system clipboard through the platform's chain. Empty text is refused up
 *  front (nothing is spawned): a blank clipboard write is never what /copy meant. */
export async function copyToClipboard(text: string, opts: ClipboardOptions = {}): Promise<ClipboardResult> {
  const spawn = opts.spawn ?? bunClipboardSpawn;
  const tried: string[] = [];
  if (text.length === 0) return { ok: false, tried, detail: "nothing to copy (empty text)" };
  let detail: string | undefined;
  for (const argv of clipboardChain(opts.platform ?? process.platform)) {
    const tool = argv[0]!;
    tried.push(tool);
    let out: SpawnOutcome;
    try { out = await spawn(argv, text); } catch (e) { out = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
    if (out.ok) return { ok: true, tool };
    detail = out.detail;
  }
  return { ok: false, tried, ...(detail !== undefined ? { detail } : {}) };
}
