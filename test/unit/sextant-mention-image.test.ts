/** port #54, the sextant half: an `@image` mention in the COCKPIT's submit path stages onto the same store
 *  stage /attach writes — the seam `expandMentions` already had (attachImage), wired through KeyCtx.local
 *  so the renderer owns the store access. Pins: a text mention still expands as before; an image mention
 *  stages (the prompt's chip mirror follows at the next tick, sextant-renderer's staged sync), the note
 *  says "attached as an image", the message spends no text budget; a surface with NO attach attached
 *  (headless dumps, old callers) keeps the old "a binary file" refusal instead of failing silently. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/sextant/local-commands.ts";
import { makeState, spyCtx, type } from "../helpers/sextant-fixtures-keys.ts";
import { setFiles } from "../../src/sextant/model.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
let dirs: string[] = [];
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "rovecode-mention-dispatch-")); dirs.push(d); return d; };

test("an @image mention on the sextant submit path stages onto the store stage (the /attach seam) — the message sends without a block and the note says image", () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "shot.png"), PNG);
  const s = makeState({ cwd, theme: "night" });
  s.theme = "night";
  setFiles(s, ["shot.png", "notes.md"], new Map());
  const spy = spyCtx();
  const staged: string[] = [];
  spy.ctx.local.attachImage = (abs) => { staged.push(abs); }; // the renderer's stand-in: the real one stages (sextant-attach.ts)

  dispatch(s, "look at @shot.png and @notes.md", spy.ctx);
  expect(staged).toEqual([join(cwd, "shot.png")]); // the image went to the seam, not into the message
  expect(spy.submits).toHaveLength(1);
  expect(spy.submits[0]).toContain("look at @shot.png"); // the typed text is untouched — no budget spent
  expect(spy.submits[0]).not.toContain("shot.png\n"); // no image body in the block (it is a staged part)
  expect(spy.submits[0]).toContain("notes.md"); // the TEXT mention still expanded beside it
  expect(spy.toasts.some((t) => t.includes("attached as an image"))).toBe(true);
});

test("a surface whose attach carries no attachImage keeps the old refusal — not silently broken, the note names the binary", () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "shot.png"), PNG);
  const s = makeState({ cwd, theme: "night" });
  s.theme = "night";
  setFiles(s, ["shot.png"], new Map());
  const spy = spyCtx();
  // the pre-#54 surface: its renderer built  before the effect existed. dispatch passes whatever
  // is there through; undefined at the expansion seam is what keeps the old refusal.
  spy.ctx.local.attachImage = undefined as unknown as (abs: string) => void;

  dispatch(s, "look at @shot.png", spy.ctx);
  expect(spy.submits).toHaveLength(1);
  expect(spy.submits[0]).toBe("look at @shot.png"); // nothing attached
  expect(spy.toasts.some((t) => t.includes("a binary file"))).toBe(true);
});

test("types are untouched by the mention machinery: the typed line still reaches history and the input clears", () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "a.md"), "hello\n");
  const s = makeState({ cwd, theme: "night" });
  s.theme = "night";
  setFiles(s, ["a.md"], new Map());
  const spy = spyCtx();
  spy.ctx.local.attachImage = () => {};
  type(s, spy, "see @a.md");
  // Enter handled in the keys test file; here dispatch is the seam — history is submitLine's business
  dispatch(s, "see @a.md", spy.ctx);
  expect(spy.submits[0]).toContain("[@a.md — attached: 2 lines]"); // hello + the trailing-newline line, exactly as  counts
});

// sweep the scratch dirs (this file registers its own cleanup; scratchDirs() is bound per file)
test("cleanup", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
