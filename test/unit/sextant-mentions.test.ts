/** `@file` mentions do something now (src/sextant/mentions.ts). Pinned: a mention resolves against the workspace
 *  list and its read block — hashline `path#TAG` + `N#hash|text`, exactly what the `read` tool returns — rides
 *  along with the submitted message; a directory, a binary, an unmatched name, an oversize file and a path
 *  outside the workspace are NAMED and left out; the per-file line cap, the per-message file cap and the
 *  character budget each say so in the message and in a toast; the transcript shows the typed text plus one
 *  chip per file, never the bodies; slash and shell lines are untouched. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTag, lineHash, readTool } from "../../src/coding/hashline.ts";
import { expandMentions, mentionsIn, MENTION_FRAME, MENTION_HEAD, MENTION_MAX_CHARS, MENTION_MAX_FILES, MENTION_MAX_LINES, splitAttached } from "../../src/sextant/mentions.ts";
import { userRow } from "../../src/sextant/sextant-bridge.ts";
import { resolveFile } from "../../src/sextant/overlays.ts";

/** the sextant's resolver: exact, unique basename, then fuzzy — over a workspace list */
const by = (paths: readonly string[]) => (m: string): string | null => resolveFile(m, paths);
import { makeState, spyCtx, key, press, type } from "../helpers/sextant-fixtures-keys.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** a small workspace on disk: two source files, a big one, a binary, a directory */
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-mentions-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "src", "core"), { recursive: true });
  writeFileSync(join(cwd, "src", "core", "session.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(cwd, "src", "core", "loop.ts"), "loop\n");
  writeFileSync(join(cwd, "README.md"), "# hi\n");
  writeFileSync(join(cwd, "src", "big.ts"), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41]));
  const paths = ["README.md", "src/core/session.ts", "src/core/loop.ts", "src/big.ts", "src/blob.bin"];
  return { cwd, paths };
}

describe("expandMentions", () => {
  test("a resolved mention is appended as the read tool would return it — same header, same hashes, same footer", async () => {
    const w = workspace();
    const r = expandMentions("look at @session.ts please", { cwd: w.cwd, resolve: by(w.paths) });
    expect(r.notes).toEqual([]);
    // 3 lines, not 2: readAnchored counts the empty line a trailing newline yields, and so does the read tool —
    // the attachment matches the tool, quirk included, so the model's line numbers agree with its next read
    expect(r.attached).toEqual([{ path: "src/core/session.ts", shown: 3, total: 3, capped: false }]);
    const abs = join(w.cwd, "src", "core", "session.ts");
    const viaTool = await readTool.execute({ path: abs }, { sessionId: "t", cwd: w.cwd, signal: new AbortController().signal, permissions: { effect: "allow" } });
    expect(viaTool.ok).toBe(true);
    // the typed text first, the frame, then the head line and the read block byte for byte
    expect(r.text).toBe(`look at @session.ts please\n\n${MENTION_FRAME}\n\n[@src/core/session.ts — attached: 3 lines]\n${viaTool.output}`);
    expect(r.text).toContain(`${abs}#${fileTag("export const a = 1;\nexport const b = 2;\n")}`);
    expect(r.text).toContain(`1#${lineHash("export const a = 1;")}|export const a = 1;`);
    expect(r.text).toContain("(showing lines 1-3 of 3)");
  });

  test("no mention → the text is returned as is; a mention nothing matches is a note and nothing is attached", () => {
    const w = workspace();
    expect(expandMentions("plain text", { cwd: w.cwd, resolve: by(w.paths) })).toEqual({ text: "plain text", attached: [], notes: [] });
    const r = expandMentions("see @nothing-like-this", { cwd: w.cwd, resolve: () => null });
    expect(r.text).toBe("see @nothing-like-this");
    expect(r.attached).toEqual([]);
    expect(r.notes).toEqual(["@nothing-like-this: no file in the workspace matches"]);
  });

  test("a directory, a binary, an oversize file and a path outside the workspace are named and left out", () => {
    const w = workspace();
    const paths = [...w.paths, "src/core", "../outside.ts"];
    const stat = (abs: string) => (abs.endsWith("big.ts") ? { isFile: () => true, size: 3 * 1024 * 1024 } : { isFile: () => !abs.endsWith("core"), size: 10 });
    const r = expandMentions("@src/core @src/blob.bin @src/big.ts @../outside.ts @README.md", { cwd: w.cwd, resolve: by(paths), stat });
    expect(r.attached.map((a) => a.path)).toEqual(["README.md"]);
    expect(r.notes).toEqual([
      "@src/core: a directory — name a file in it",
      "@src/blob.bin: a binary file — not attached",
      "@src/big.ts: 3.0 MB is too large to attach — ask me to read a window of it",
      "@../outside.ts: outside the workspace — not attached",
    ]);
    expect(r.text).not.toContain("blob.bin —");
    expect(r.text).toContain("[@README.md — attached: 2 lines]");
  });

  test("the line cap: the first 400 lines, the head and footer name the offset that continues, and a toast says so", () => {
    const w = workspace();
    const r = expandMentions("@src/big.ts", { cwd: w.cwd, resolve: by(w.paths) });
    expect(r.attached).toEqual([{ path: "src/big.ts", shown: MENTION_MAX_LINES, total: 1001, capped: true }]);
    expect(r.text).toContain(`[@src/big.ts — attached: ${MENTION_MAX_LINES} of 1001 lines, capped: read it with offset ${MENTION_MAX_LINES + 1} for the rest]`);
    expect(r.text).toContain(`(showing lines 1-${MENTION_MAX_LINES} of 1001)`);
    expect(r.text).not.toContain(`|line ${MENTION_MAX_LINES + 1}\n`);
    expect(r.notes).toEqual([`@src/big.ts: 1001 lines — attached the first ${MENTION_MAX_LINES}; the rest is a read away`]);
  });

  test("the file cap and the character budget: the ninth file is named and left out; a message cannot carry more than ~60k characters of files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rovecode-mentions-")); dirs.push(cwd);
    const paths: string[] = [];
    for (let i = 0; i < MENTION_MAX_FILES + 1; i++) { writeFileSync(join(cwd, `f${i}.txt`), `file ${i}\n`); paths.push(`f${i}.txt`); }
    const many = expandMentions(paths.map((p) => `@${p}`).join(" "), { cwd, resolve: by(paths) });
    expect(many.attached).toHaveLength(MENTION_MAX_FILES);
    expect(many.notes).toEqual([`@f${MENTION_MAX_FILES}.txt: not attached — ${MENTION_MAX_FILES} files per message is the cap; ask me to read it`]);
    // 300 lines of 300 chars each = 90k > the budget: fewer lines land, the head says capped, the total stays under the budget
    writeFileSync(join(cwd, "wide.txt"), Array.from({ length: 300 }, () => "x".repeat(300)).join("\n") + "\n");
    const wide = expandMentions("@wide.txt @f0.txt", { cwd, resolve: by([...paths, "wide.txt"]) });
    expect(wide.attached[0]!.capped).toBe(true);
    expect(wide.attached[0]!.shown).toBeLessThan(300);
    expect(wide.text.length - "@wide.txt @f0.txt".length).toBeLessThan(MENTION_MAX_CHARS + 2_000);
    // what is left of the budget after that is under MENTION_MIN_BLOCK: the second file is named, not squeezed to a fragment
    expect(wide.attached.map((a) => a.path)).toEqual(["wide.txt"]);
    expect(wide.notes.some((n) => n.startsWith("@f0.txt: not attached — this message already carries"))).toBe(true);
  });

  test("the same file mentioned twice is attached once", () => {
    const w = workspace();
    const r = expandMentions("@README.md and again @README.md", { cwd: w.cwd, resolve: by(w.paths) });
    expect(r.attached).toHaveLength(1);
    expect((r.text.match(/\[@README\.md — attached/g) ?? []).length).toBe(1);
  });
});

describe("the transcript's view", () => {
  test("splitAttached / userRow: the typed text and one chip per file, the bodies gone; image chips still work beside them", () => {
    const w = workspace();
    const r = expandMentions("explain @session.ts and @src/big.ts", { cwd: w.cwd, resolve: by(w.paths) });
    expect(splitAttached(r.text)).toEqual({ text: "explain @session.ts and @src/big.ts", files: ["src/core/session.ts · 3 lines", `src/big.ts · ${MENTION_MAX_LINES}/1001 lines, capped`] });
    expect(MENTION_HEAD.test("[@src/core/session.ts — attached: 3 lines]")).toBe(true);
    const row = userRow(`${r.text}\n[image: shot.png]`, 5);
    expect(row).toEqual({ kind: "user", text: "explain @session.ts and @src/big.ts", at: 5, images: ["shot.png"], files: ["src/core/session.ts · 3 lines", `src/big.ts · ${MENTION_MAX_LINES}/1001 lines, capped`] });
    expect(userRow("no attachments here", 1)).toEqual({ kind: "user", text: "no attachments here", at: 1 });
    expect(splitAttached("a line that merely says " + MENTION_FRAME.slice(0, 10))).toEqual({ text: "a line that merely says (files att", files: [] });
  });
});

describe("through the keys: Enter on a line with @file", () => {
  test("the submitted text carries the read block; the caps toast; a slash line and a !shell line are untouched", () => {
    const w = workspace();
    const s = makeState({ cwd: w.cwd, files: { ...makeState().files, paths: [...w.paths] } });
    const spy = spyCtx();
    // a space after the mention closes the picker row (Enter on a mention row inserts, it does not submit)
    type(s, spy, "fix the bug in @src/core/loop.ts ");
    press(s, spy, key("enter"));
    expect(spy.submits).toHaveLength(1);
    const sent = spy.submits[0]!;
    expect(sent.startsWith(`fix the bug in @src/core/loop.ts\n\n${MENTION_FRAME}\n\n[@src/core/loop.ts — attached: 2 lines]\n`)).toBe(true);
    expect(sent).toContain(`1#${lineHash("loop")}|loop`);
    expect(spy.toasts).toEqual([]);
    // a capped file toasts once; the unmatched one toasts once; the message still goes
    type(s, spy, "compare @src/big.ts with @zzz-nothing ");
    press(s, spy, key("enter"));
    expect(spy.submits).toHaveLength(2);
    expect(spy.toasts).toEqual([
      `@src/big.ts: 1001 lines — attached the first ${MENTION_MAX_LINES}; the rest is a read away`,
      "@zzz-nothing: no file in the workspace matches",
    ]);
    // not free text: nothing is expanded (an unknown slash command and a shell line reach onSubmit as typed)
    type(s, spy, "/zzz @README.md "); press(s, spy, key("enter"));
    type(s, spy, "!cat @README.md "); press(s, spy, key("enter"));
    expect(spy.submits.slice(2)).toEqual(["/zzz @README.md", "!cat @README.md"]);
  });
});

// ── 2026-09-07: three widenings, because the promise was narrower than the words ──

describe("where a mention may point", () => {
  test("`~/x` and an ABSOLUTE path are the person naming a file outright: attached wherever they point, with no workspace list involved", () => {
    const dir = mkdtempSync(join(tmpdir(), "rovecode-mention-abs-")); dirs.push(dir);
    const outside = join(dir, "notes.md");
    writeFileSync(outside, "one\ntwo\n");
    // the resolver knows nothing — an absolute mention must not need it (MUTATION: route absolutes through resolve → null → "no file matches")
    const r = expandMentions(`look at @${outside}`, { cwd: process.cwd(), resolve: () => null, mentions: [outside] });
    expect(r.attached.length).toBe(1);
    expect(r.text).toContain(MENTION_FRAME);
    expect(r.notes).toEqual([]);
    // `~` resolves against the home dir; a missing one is a note, not a throw
    const home = expandMentions("see @~/definitely-not-here-9f2c.md", { cwd: process.cwd(), resolve: () => null, mentions: ["~/definitely-not-here-9f2c.md"] });
    expect(home.attached).toEqual([]);
    expect(home.notes[0]).toContain("cannot be read");
  });

  test("the token class carries the tilde, the colon and the backslash, so a home-relative and a Windows absolute mention tokenize at all — that was the reason the feature could not work", () => {
    expect(mentionsIn("see @~/notes.md please")).toEqual(["~/notes.md"]);
    expect(mentionsIn("see @C:\\Users\\me\\notes.md")).toEqual(["C:\\Users\\me\\notes.md"]);
    expect(mentionsIn("mail me@example.com")).toEqual([]);           // still not a mention: no whitespace before the @
    expect(mentionsIn("@src/a.ts and @b.ts")).toEqual(["src/a.ts", "b.ts"]);
  });

  test("a RELATIVE mention that resolves nowhere under cwd is tried against the --add-dir roots, in order, and the note names the root", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rovecode-mention-cwd-")); dirs.push(cwd);
    const root = mkdtempSync(join(tmpdir(), "rovecode-mention-root-")); dirs.push(root);
    writeFileSync(join(root, "shared.md"), "from the added root\n");
    const none = expandMentions("see @shared.md", { cwd, resolve: () => null, mentions: ["shared.md"] });
    expect(none.attached).toEqual([]);                                // without the roots: unchanged behaviour
    expect(none.notes[0]).toContain("no file in the workspace matches");
    const withRoot = expandMentions("see @shared.md", { cwd, resolve: () => null, mentions: ["shared.md"], roots: [root] });
    expect(withRoot.attached.length).toBe(1);                         // MUTATION: drop the roots loop → a file in an added root cannot be mentioned at all
    expect(withRoot.text).toContain("from the added root");
    // a root is still a boundary: `..` out of it resolves nowhere
    expect(expandMentions("see @../escape.md", { cwd, resolve: () => null, mentions: ["../escape.md"], roots: [root] }).attached).toEqual([]);
  });

  test("an IMAGE mention takes the /attach seam instead of being refused as binary, and spends none of the text budget", () => {
    const cwd = mkdtempSync(join(tmpdir(), "rovecode-mention-img-")); dirs.push(cwd);
    const png = join(cwd, "shot.png");
    writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
    const staged: string[] = [];
    const r = expandMentions("look at @shot.png", { cwd, resolve: (m) => m, mentions: ["shot.png"], attachImage: (p) => { staged.push(p); } });
    expect(staged.length).toBe(1);                                    // MUTATION: no image branch → "a binary file — not attached"
    expect(r.attached).toEqual([]);                                   // it is an image part, not a text block
    expect(r.text).toBe("look at @shot.png");                         // the message is untouched — no budget spent
    expect(r.notes[0]).toContain("attached as an image (image/png)");
    // without the seam the old refusal stands, so a surface that cannot stage images is not silently broken
    const noSeam = expandMentions("look at @shot.png", { cwd, resolve: (m) => m, mentions: ["shot.png"] });
    expect(noSeam.notes[0]).toContain("a binary file");
  });
});
