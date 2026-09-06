/** The LSP gate's absence is SAID at boot instead of being silently off (coding/lsp.ts lspAvailabilityNote).
 *  On the machine this was found on, typescript-language-server was not on PATH, and every claim that "edits
 *  come back with diagnostics" had been false there without a single line saying so. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspAvailabilityNote } from "../../src/coding/lsp.ts";
import { createRuntime } from "../../src/cli/runtime.ts";

const none = () => null;
const found = (n: string) => `/usr/bin/${n}`;

test("a TypeScript project without the server on PATH gets one line naming what is NOT happening; with the server, or without a tsconfig, nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-lsp-"));
  try {
    expect(lspAvailabilityNote(root, none)).toBeNull();                       // not a TS project: nothing was promised
    writeFileSync(join(root, "tsconfig.json"), "{}");
    const note = lspAvailabilityNote(root, none);
    expect(note).toContain("typescript-language-server is not on PATH");
    expect(note).toContain("NOT type-checked");
    expect(note).toContain("npm i -g typescript-language-server typescript");
    expect(lspAvailabilityNote(root, found)).toBeNull();
    expect(lspAvailabilityNote(root, none, "vtsls")).toContain("vtsls is not on PATH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createRuntime carries it as a plugin warning (the channel the TUI shows as a warn note and headless prints to stderr) — exactly as many times as the real PATH warrants", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-lsp-rt-"));
  try {
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    const rt = createRuntime({ cwd, stream: null });
    const lspNotes = rt.plugins.warnings.filter((w) => w.startsWith("lsp: "));
    const expected = Bun.which("typescript-language-server") === null ? 1 : 0;
    expect(lspNotes.length).toBe(expected);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
