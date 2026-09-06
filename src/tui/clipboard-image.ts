/** Read an IMAGE from the system clipboard (⌃v / `/paste`).
 *
 *  A terminal only ever hands a program TEXT from the clipboard (bracketed paste). When the clipboard
 *  holds an image — a screenshot, a copied picture — the terminal sends nothing useful, and users who
 *  press ⌃v expecting the image to land (every chat app taught them that) get silence. So the surface
 *  asks the OS itself, through the one tool each platform has for it, and converts to PNG:
 *    win32  PowerShell + System.Windows.Forms.Clipboard.GetImage()  → PNG → base64 on stdout
 *    darwin osascript `the clipboard as «class PNGf»`                → hex («data PNGf…»)
 *    linux  wl-paste -t image/png, else xclip -selection clipboard -t image/png -o
 *
 *  The command runner is injected so tests never touch a real clipboard; every failure (no image on
 *  the clipboard, tool missing, odd output) is `null`, never a throw — the caller says "no image on the
 *  clipboard" and moves on. Nothing here writes a file: the bytes go straight to core/images.ts
 *  imageFromBytes, which sniffs the magic bytes and enforces the size cap like any other attachment. */

import { spawnSync } from "node:child_process";

export interface ClipboardRunner {
  /** run a command, return stdout decoded as `encoding` (utf8 for text tools, latin1 when the tool
   *  prints raw image bytes — utf8 decoding would corrupt them), or null when it failed / is missing */
  (cmd: string, args: readonly string[], encoding?: "utf8" | "latin1"): string | null;
}

const TIMEOUT_MS = 5_000;
const MAX_OUT = 64 * 1024 * 1024; // a 5 MiB image is ~7 MiB of base64; leave room, never unbounded

/** child_process.spawnSync under the contract above: non-zero exit, signal, timeout or ENOENT → null */
export const spawnRunner: ClipboardRunner = (cmd, args, encoding = "utf8") => {
  try {
    const r = spawnSync(cmd, args, { encoding, timeout: TIMEOUT_MS, maxBuffer: MAX_OUT, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (r.error || r.status !== 0 || r.signal) return null;
    return r.stdout;
  } catch { return null; }
};

/** PowerShell: the image as PNG base64, or nothing when the clipboard holds no image */
const PS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
  "$i = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($i -eq $null) { exit 3 }",
  "$ms = New-Object System.IO.MemoryStream",
  "$i.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
  "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
].join("; ");

function fromBase64(s: string | null): Uint8Array | null {
  const t = s?.trim() ?? "";
  if (t.length < 16 || !/^[A-Za-z0-9+/=\r\n]+$/.test(t)) return null;
  try { return new Uint8Array(Buffer.from(t.replace(/\s+/g, ""), "base64")); } catch { return null; }
}

/** osascript prints `«data PNGf89504E47…»`; take the hex between the marker and the closing » */
function fromAppleScriptHex(s: string | null): Uint8Array | null {
  const m = /«data PNGf([0-9A-Fa-f]+)»/.exec(s ?? "");
  if (!m || m[1]!.length < 32 || m[1]!.length % 2 !== 0) return null;
  return new Uint8Array(Buffer.from(m[1]!, "hex"));
}

/** The clipboard image as raw bytes (PNG on win32/darwin, whatever the tool yields on linux — the
 *  magic-byte sniff downstream decides), or null when there is none. `platform` defaults to the process's. */
export function readClipboardImage(run: ClipboardRunner = spawnRunner, platform: NodeJS.Platform = process.platform): Uint8Array | null {
  if (platform === "win32") {
    return fromBase64(run("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", PS_SCRIPT]));
  }
  if (platform === "darwin") {
    return fromAppleScriptHex(run("osascript", ["-e", "the clipboard as «class PNGf»"]));
  }
  // linux and the rest: wayland first, then X11; both print the raw PNG, which the runner returns as a
  // utf8 string — decode it back to bytes with latin1 so no byte is altered
  for (const [cmd, args] of [["wl-paste", ["-t", "image/png"]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]] as const) {
    const out = run(cmd, args, "latin1");
    if (out !== null && out.length > 8) return new Uint8Array(Buffer.from(out, "latin1"));
  }
  return null;
}

/** what a pasted image is called in the transcript chip and the sidecar name: clipboard-HHMMSS.png */
export function clipboardImageName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `clipboard-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
}
