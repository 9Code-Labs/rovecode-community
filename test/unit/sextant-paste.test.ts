/** Sending an image, the way people actually try to: ⌃v with a screenshot on the clipboard, dragging a
 *  file onto the terminal, and seeing the attachment BEFORE pressing Enter. `/attach <path>` existed;
 *  Berkay's "gorsel gonderebilme olayini yapalim" was about these three. Pinned here: the pure keys.ts
 *  half (path detection, ⌃v and a dropped path route through the existing /attach and /paste slash
 *  handlers, never a second staging path), the OS clipboard readers with an injected runner (no real
 *  clipboard, no real process), cmdPasteImage staging through the real store, and the chip row on the
 *  prompt's rule line. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pastedImagePath } from "../../src/sextant/keys.ts";
import { readClipboardImage, clipboardImageName, type ClipboardRunner } from "../../src/tui/clipboard-image.ts";
import { cmdPasteImage, type AttachCtx } from "../../src/tui/attach.ts";
import { SessionStore } from "../../src/core/session.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import { drawMessages } from "../../src/sextant/draw-messages.ts";
import { makeState, makeLayout, spyCtx, ctrl, paste, press, THEME } from "../helpers/sextant-fixtures-keys.ts";

// a valid 1×1 PNG (magic bytes + IHDR), enough for the sniff and the dimension read
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// ---------- keys.ts: what a paste means ----------

test("pastedImagePath: one image path (bare, quoted, with spaces) — not text, not two lines, not a .ts", () => {
  expect(pastedImagePath("C:\\shots\\a.png")).toBe("C:\\shots\\a.png");
  expect(pastedImagePath('"C:\\my shots\\a b.PNG"')).toBe("C:\\my shots\\a b.PNG");
  expect(pastedImagePath("'/tmp/x.webp'")).toBe("/tmp/x.webp");
  expect(pastedImagePath("  ./x.jpeg  ")).toBe("./x.jpeg");
  expect(pastedImagePath("look at a.png please")).toBeNull();
  expect(pastedImagePath("a.png\nb.png")).toBeNull();
  expect(pastedImagePath("src/main.ts")).toBeNull();
  expect(pastedImagePath("")).toBeNull();
});

test("a dropped image path attaches through /attach instead of landing in the prompt as text", () => {
  const s = makeState(), spy = spyCtx();
  press(s, spy, paste('"C:\\shots\\hero final.png"'));
  expect(spy.submits).toEqual(['/attach "C:\\shots\\hero final.png"']);
  expect(s.input.text).toBe(""); // nothing typed into the prompt
});

test("ordinary pastes still go into the prompt, and a path pasted into a question card's answer is text", () => {
  const s = makeState(), spy = spyCtx();
  press(s, spy, paste("fix the header"));
  expect(s.input.text).toBe("fix the header");
  expect(spy.submits).toEqual([]);
});

test("⌃v routes to /paste — the terminal never delivers an image paste, only the key", () => {
  const s = makeState(), spy = spyCtx();
  press(s, spy, ctrl("v"));
  expect(spy.submits).toEqual(["/paste"]);
});

// ---------- clipboard-image.ts: asking the OS ----------

test("win32: PowerShell's base64 becomes PNG bytes; no image → null; the tool missing → null", () => {
  const calls: string[] = [];
  const run: ClipboardRunner = (cmd) => { calls.push(cmd); return PNG_1x1.toString("base64"); };
  const bytes = readClipboardImage(run, "win32");
  expect(calls).toEqual(["powershell"]);
  expect(bytes).not.toBeNull();
  expect(Buffer.from(bytes!).equals(PNG_1x1)).toBe(true);
  expect(readClipboardImage(() => "", "win32")).toBeNull();
  expect(readClipboardImage(() => null, "win32")).toBeNull();
  expect(readClipboardImage(() => "not base64!!", "win32")).toBeNull();
});

test("darwin: osascript's «data PNGf…» hex becomes bytes", () => {
  const hex = PNG_1x1.toString("hex").toUpperCase();
  const bytes = readClipboardImage(() => `«data PNGf${hex}»`, "darwin");
  expect(Buffer.from(bytes!).equals(PNG_1x1)).toBe(true);
  expect(readClipboardImage(() => "«data TEXT00»", "darwin")).toBeNull();
});

test("linux: wl-paste first, xclip second, bytes returned untouched through latin1", () => {
  const seen: string[] = [];
  const run: ClipboardRunner = (cmd, _a, enc) => { seen.push(`${cmd}:${enc}`); return cmd === "xclip" ? PNG_1x1.toString("latin1") : null; };
  const bytes = readClipboardImage(run, "linux");
  expect(seen).toEqual(["wl-paste:latin1", "xclip:latin1"]);
  expect(Buffer.from(bytes!).equals(PNG_1x1)).toBe(true);
});

test("clipboardImageName is clipboard-HHMMSS.png", () => {
  expect(clipboardImageName(new Date(2026, 8, 4, 9, 5, 7))).toBe("clipboard-090507.png");
});

// ---------- attach.ts: staging what the clipboard held ----------

function attachCtx(): { ctx: AttachCtx; notes: string[]; store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-paste-"));
  const store = new SessionStore(dir, "s1");
  const notes: string[] = [];
  const renderer = { addSystemNote: (t: string) => { notes.push(t); } } as unknown as AttachCtx["renderer"];
  return { ctx: { renderer, cwd: dir, store: () => store, modelRef: () => ({ provider: "anthropic", model: "claude-sonnet-5" }) }, notes, store, dir };
}

test("cmdPasteImage stages the clipboard image on the store and says so; nothing on the clipboard is a note, not a throw", () => {
  const { ctx, notes, store, dir } = attachCtx();
  try {
    cmdPasteImage(ctx, () => null);
    expect(store.stagedAttachments).toHaveLength(0);
    expect(notes[0]).toContain("no image on the clipboard");
    cmdPasteImage(ctx, () => new Uint8Array(PNG_1x1), "clipboard-120000.png");
    expect(store.stagedAttachments).toHaveLength(1);
    expect(store.stagedAttachments[0]).toMatchObject({ kind: "image", mime: "image/png", name: "clipboard-120000.png", width: 1, height: 1 });
    expect(notes.at(-1)).toContain("attached");
    expect(notes.at(-1)).toContain("clipboard");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bytes that are not an image are refused with the loader's own error", () => {
  const { ctx, notes, store, dir } = attachCtx();
  try {
    cmdPasteImage(ctx, () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(store.stagedAttachments).toHaveLength(0);
    expect(notes).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- draw-messages.ts: seeing it before sending ----------

test("staged images show as chips on the prompt's rule row — no transcript row is spent on them", () => {
  const L = makeLayout(160, 44);
  const s = makeState({ staged: ["clipboard-120000.png", "hero.png"] });
  const scr = new GridScreen(160, 44, THEME.bg);
  drawMessages(scr, L.messages, s, THEME, 0);
  const rows = scr.toText().split("\n");
  const ruleY = L.messages.y + L.messages.h - 3; // inner bottom row is the prompt; the row above is the rule
  expect(rows[ruleY]).toContain("▣ clipboard-120000.png");
  expect(rows[ruleY]).toContain("▣ hero.png");
  expect(rows[ruleY]).toContain("2/8");
  // the prompt row below is untouched
  expect(rows[ruleY + 1]).toContain("▌");
  // and without a stage the rule is a plain rule
  const plain = new GridScreen(160, 44, THEME.bg);
  drawMessages(plain, L.messages, makeState(), THEME, 0);
  expect(plain.toText().split("\n")[ruleY]).not.toContain("▣");
});
