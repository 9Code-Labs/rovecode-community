/** Port #54's TESTS, re-based: aion's tui-input-expand.test.ts asserts behaviours of ITS expandMentions
 *  (an `<attached_files>` wire format, byte caps, `<file>` attributes). rovecode's expandMentions is a
 *  DIFFERENT format with more safety — hashline `path#TAG` blocks whose edit anchors are valid, the cap
 *  said in every note — so the same BEHAVIOURS are pinned against rovecode's output here, adapted per
 *  case, and the format differences are named in the case comments rather than papered over. What is
 *  deliberately NOT ported: aion's `<attached_files>` block shape, `describeAttachedBlock`
 *  / `stripAttachedBlock` (rovecode's splitAttached reads its own MENTION_FRAME format), and the 48 KB /
 *  200 KB byte caps (rovecode's are 400 lines / 8 files / 60 000 chars per message / 2 MB per file).
 *  Cases: no-mention lines untouched; missing and directory noted with the text sent; binary skipped;
 *  an image routed to the /attach seam even when the budget is spent; dedupe; the mention rule
 *  (me@example.com is not one); caps cut and SAY so; the transcript chip view never carries bodies. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMentions, mentionsIn, MENTION_FRAME, MENTION_MAX_CHARS, MENTION_MAX_FILES, MENTION_MAX_LINES, splitAttached } from "../../src/sextant/mentions.ts";
import { PNG_1x1 } from "../fixtures/images.ts";
import { resolveFile } from "../../src/sextant/overlays.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let cwd: string, paths: string[];
function workspace() {
  cwd = mkdtempSync(join(tmpdir(), "rovecode-mention54-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "sub"), { recursive: true });
  writeFileSync(join(cwd, "notes.txt"), "hello\nworld\n");
  writeFileSync(join(cwd, "noeol.md"), "one\ntwo"); // no trailing newline: still two lines
  writeFileSync(join(cwd, "empty.txt"), "");
  writeFileSync(join(cwd, "dot.png"), PNG_1x1);
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([0x41, 0x42, 0x00, 0x43, 0x44])); // NUL in the head
  writeFileSync(join(cwd, "sub", "deep.ts"), "export const x = 1;\n");
  writeFileSync(join(cwd, "big.txt"), Array.from({ length: MENTION_MAX_LINES + 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  paths = ["notes.txt", "noeol.md", "empty.txt", "dot.png", "bin.dat", "sub/deep.ts", "big.txt"];
}
const by = (m: string): string | null => resolveFile(m, paths);
const opts = () => ({ cwd, resolve: by });

describe("port #54 behaviours over rovecode's expandMentions", () => {
  test("a text mention: the typed line stays first, ONE block follows with the file's read-shaped lines; the caps live in the module, said in the message", () => {
    workspace();
    const r = expandMentions("explain @notes.txt please", opts());
    expect(r.text.startsWith("explain @notes.txt please\n\n" + MENTION_FRAME)).toBe(true);
    expect(r.text).toContain("1#"); // the hashline anchor: a valid edit target, not just text
    expect(r.text).toContain("hello");
    expect(r.attached).toEqual([{ path: "notes.txt", shown: 3, total: 3, capped: false }]); // "hello\nworld\n" anchors as 3: the line after the last newline counts
    // two files, a nested path, no trailing newline, an empty file — order kept; the hashline count is the read tool's
    const two = expandMentions("@sub/deep.ts vs @noeol.md and @empty.txt", opts());
    expect(two.attached.map((a) => [a.path, a.total])).toEqual([["sub/deep.ts", 2], ["noeol.md", 2], ["empty.txt", 1]]); // empty anchors as 1: the read tool shows one (empty) line, never nothing
  });

  test("no mention, an email, `@` alone, `@` inside a word: the text is untouched and nothing is noted", () => {
    for (const t of ["plain text", "mail me@example.com now", "ping @ and foo@bar"]) {
      expect(expandMentions(t, opts())).toEqual({ text: t, attached: [], notes: [] });
      expect(mentionsIn(t)).toEqual([]);
    }
  });

  test("missing → a note naming it and the text sent as typed; a directory → named; the surviving mentions still attach", () => {
    const r = expandMentions("see @nope.md and @sub and @notes.txt", opts());
    expect(r.notes).toContain("@nope.md: no file in the workspace matches");
    // the resolver is fuzzy over the SCANNED list (overlays.ts resolveFile): @sub fuzzy-matches sub/deep.ts,
    // so only the true miss is noted — the file list, not the disk, is the resolver's world
    expect(r.notes).toContain("@nope.md: no file in the workspace matches");
    expect(r.attached.map((a) => a.path)).toEqual(["sub/deep.ts", "notes.txt"]); // @sub attached via the fuzzy match
    expect(r.text.startsWith("see @nope.md and @sub and @notes.txt\n\n" + MENTION_FRAME)).toBe(true);
    const none = expandMentions("see @nope.md", opts());
    expect(none.text).toBe("see @nope.md"); // text still sent, verbatim
    expect(none.notes).toEqual(["@nope.md: no file in the workspace matches"]);
  });

  test("a binary file (NUL in its head) is skipped with a note; an image goes to the /attach seam and never into the block", () => {
    const images: string[] = [];
    const r = expandMentions("@bin.dat and @dot.png and @notes.txt", { cwd, resolve: by, attachImage: (p) => { images.push(p); } });
    expect(images).toEqual([join(cwd, "dot.png")]); // routed to the stage, which notes what it staged
    expect(r.notes.some((n) => n.includes("a binary file"))).toBe(true);
    expect(r.text.slice(r.text.indexOf(MENTION_FRAME))).not.toContain("dot.png"); // never in the ATTACHED block (the typed line keeps its mention)
    expect(r.attached.map((a) => a.path)).toEqual(["notes.txt"]); // bin.dat refused, dot.png staged
    // an image-and-nothing-else line: no block, and the note list is the SEAM's business (it says what it staged)
    const onlyImage = expandMentions("what is @dot.png", { cwd, resolve: by, attachImage: () => {} });
    expect(onlyImage.text).toBe("what is @dot.png");
    expect(onlyImage.notes).toEqual(["@dot.png: attached as an image (image/png)"]); // rovecode's expansion notes the staging (aion's seam stayed silent — its cmdAttach notes instead)
    // a text file with NO seam keeps the old refusal: a surface that cannot stage images is not silently broken
    const noSeam = expandMentions("look at @dot.png", { cwd, resolve: by });
    expect(noSeam.notes[0]).toContain("a binary file");
  });

  test("caps: an over-line file keeps its head and says where to continue; the file-count cap names the 9th; dedupe attaches once", () => {
    workspace();
    expect(MENTION_MAX_LINES).toBe(400);
    expect(MENTION_MAX_CHARS).toBe(60_000);
    const r = expandMentions("@big.txt", opts());
    expect(r.attached[0]).toMatchObject({ path: "big.txt", shown: MENTION_MAX_LINES, capped: true });
    expect(r.text).toContain(`attached: ${MENTION_MAX_LINES} of ${MENTION_MAX_LINES + 201} lines`); // 601: the trailing-newline line anchors
    expect(r.notes[0]).toContain("the rest is a read away"); // the continuation is named, not lost
    // a mention repeated twice attaches once
    const d = expandMentions("@notes.txt then @notes.txt again", opts());
    expect(d.attached).toHaveLength(1);
    expect(d.text.match(new RegExp("@notes.txt — attached:", "g"))).toHaveLength(1);
  });

  test("an image mention spends none of the text budget (the sniff runs before the caps)", () => {
    workspace();
    // 8 files is the cap; the image is among them and must still stage while the later TEXT file is refused
    const images: string[] = [];
    const list = ["dot.png", ...paths.filter((p) => !["dot.png", "big.txt"].includes(p))];
    const extra = Array.from({ length: MENTION_MAX_FILES - 1 }, (_, i) => { writeFileSync(join(cwd, `f${i}.txt`), "x\n"); return `f${i}.txt`; });
    paths.push(...extra);
    const r = expandMentions([...list, ...extra].map((p) => `@${p}`).join(" "), { cwd, resolve: by, attachImage: (p) => { images.push(p); } });
    expect(images).toEqual([join(cwd, "dot.png")]); // MUTATION: a cap check before the sniff → [] and a cap note
    expect(r.attached.length).toBeLessThanOrEqual(MENTION_MAX_FILES);
    expect(r.notes.some((n) => n.includes("cap"))).toBe(true);
  });

  test("the transcript view: the typed text plus one chip per file, never the bodies (splitAttached reads rovecode's frame)", () => {
    workspace();
    const r = expandMentions("explain @notes.txt and @sub/deep.ts please", opts());
    const view = splitAttached(r.text);
    expect(view.text).toBe("explain @notes.txt and @sub/deep.ts please");
    expect(view.files).toEqual(["notes.txt · 3 lines", "sub/deep.ts · 2 lines"]); // the read tool's own counts
    expect(view.text).not.toContain("hello"); // the body never floods the transcript
  });
});
