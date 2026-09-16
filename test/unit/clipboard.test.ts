/** Port #53 /copy clipboard chain (tui/clipboard.ts): the per-platform candidate ORDER is pinned with
 *  a fake spawner (mutation: swap xclip/xsel → fails), a missing tool / non-zero exit / thrown spawn
 *  falls through to the next candidate, an exhausted chain reports what it tried and never throws,
 *  empty text spawns nothing. The ONE real-process test is the Windows UTF-8 round-trip through the
 *  real PowerShell command (skipped elsewhere); it saves and restores the host clipboard. */

import { test, expect } from "bun:test";
import { clipboardChain, copyToClipboard, bunClipboardSpawn, WIN_SET_CLIPBOARD, type ClipboardSpawn } from "../../src/tui/clipboard.ts";

/** records every argv it was asked to run; `verdict` decides per tool name */
function fakeSpawn(verdict: (tool: string) => "ok" | "fail" | "throw") {
  const calls: { argv: string[]; input: string }[] = [];
  const spawn: ClipboardSpawn = async (argv, input) => {
    calls.push({ argv: [...argv], input });
    const v = verdict(argv[0]!);
    if (v === "throw") throw new Error(`spawn ${argv[0]}: ENOENT`);
    return v === "ok" ? { ok: true } : { ok: false, detail: `${argv[0]} exit 1` };
  };
  return { spawn, calls };
}

const UNIX_CHAIN = [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

test("chain order: win32 = powershell (UTF-8 stdin script) alone; every other platform = pbcopy → wl-copy → xclip -selection clipboard → xsel --clipboard --input", () => {
  expect(clipboardChain("win32")).toEqual([["powershell", "-NoProfile", "-NonInteractive", "-Command", WIN_SET_CLIPBOARD]]);
  expect(WIN_SET_CLIPBOARD).toContain("[Console]::InputEncoding=[Text.Encoding]::UTF8"); // the OEM default garbles non-ASCII
  expect(WIN_SET_CLIPBOARD).toContain("Set-Clipboard -Value $t");
  expect(clipboardChain("darwin")).toEqual(UNIX_CHAIN);   // mutation: swap any two → fails
  expect(clipboardChain("linux")).toEqual(UNIX_CHAIN);
  expect(clipboardChain("freebsd")).toEqual(UNIX_CHAIN);  // one chain for everything that is not Windows
});

test("every candidate failing is tried IN ORDER (pbcopy, wl-copy, xclip, xsel) and reported; the text reaches each spawn verbatim; nothing throws", async () => {
  const { spawn, calls } = fakeSpawn(() => "fail");
  const res = await copyToClipboard("héllo — ✓", { platform: "linux", spawn });
  expect(res).toEqual({ ok: false, tried: ["pbcopy", "wl-copy", "xclip", "xsel"], detail: "xsel exit 1" });
  expect(calls.map((c) => c.argv)).toEqual(UNIX_CHAIN); // mutation: reorder the chain → fails
  expect(calls.every((c) => c.input === "héllo — ✓")).toBe(true);
});

test("a Linux host: pbcopy and wl-copy missing (spawn throws ENOENT) fall through; xclip succeeding stops the chain — xsel is never spawned", async () => {
  const { spawn, calls } = fakeSpawn((tool) => (tool === "pbcopy" || tool === "wl-copy" ? "throw" : "ok"));
  const res = await copyToClipboard("x", { platform: "linux", spawn });
  expect(res).toEqual({ ok: true, tool: "xclip" });
  expect(calls.map((c) => c.argv[0])).toEqual(["pbcopy", "wl-copy", "xclip"]);
});

test("a macOS host: pbcopy succeeds first and nothing else is spawned; win32: powershell alone — a failure there is the end of the chain", async () => {
  const mac = fakeSpawn(() => "ok");
  expect(await copyToClipboard("x", { platform: "darwin", spawn: mac.spawn })).toEqual({ ok: true, tool: "pbcopy" });
  expect(mac.calls.map((c) => c.argv)).toEqual([["pbcopy"]]); // mutation: pbcopy not first → wl-copy spawned first
  const win = fakeSpawn(() => "fail");
  expect(await copyToClipboard("x", { platform: "win32", spawn: win.spawn })).toEqual({ ok: false, tried: ["powershell"], detail: "powershell exit 1" });
  expect(win.calls.length).toBe(1);
});

test("empty text is refused before any spawn", async () => {
  const { spawn, calls } = fakeSpawn(() => "ok");
  const res = await copyToClipboard("", { platform: "linux", spawn });
  expect(res.ok).toBe(false);
  expect(calls).toEqual([]);
});

test("the default spawner reports a missing binary as a failed candidate (no throw)", async () => {
  const out = await bunClipboardSpawn(["rovecode-no-such-clipboard-tool-53"], "x");
  expect(out.ok).toBe(false);
  expect(typeof out.detail).toBe("string");
});

// ---------- the one real-process test: Windows UTF-8 round-trip ----------

async function psRead(): Promise<string> {
  // Console.Out.Write (not the pipeline) so no trailing newline is appended to the read-back
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write([string](Get-Clipboard -Raw))"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

test.skipIf(process.platform !== "win32")("win32: the REAL PowerShell chain round-trips a non-ASCII, multi-line string byte-for-byte (Get-Clipboard read-back); the previous clipboard text is restored", async () => {
  const before = await psRead();
  const probe = `rovecode #53 héllo — ünïcode ✓ 日本語\nsecond line\ttab end`;
  try {
    const res = await copyToClipboard(probe, { platform: "win32" });
    expect(res).toEqual({ ok: true, tool: "powershell" });
    expect(await psRead()).toBe(probe);
  } finally {
    if (before.length > 0) await copyToClipboard(before, { platform: "win32" });
  }
}, 30_000);
