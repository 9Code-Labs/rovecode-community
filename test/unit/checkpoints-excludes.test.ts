/** Shadow-git checkpoints exclude media, archives and binaries (coding/checkpoints.ts EXCLUDES): a snapshot
 *  is for restoring what the agent changed, and hashing a workspace's tracked videos on every session's
 *  first write cost 26–35 s and 232 MB in this repo (2026-09-06). Text of any size is still snapshotted, and
 *  an excluded file survives a files restore untouched (it is ignored, not deleted). */

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "../../src/coding/checkpoints.ts";

test("media (incl. raster images), archives, binaries and logs are never snapshotted; source, docs, SVG and large text are", async () => {
  const w = mkdtempSync(join(tmpdir(), "rovecode-cp-excl-"));
  mkdirSync(join(w, "site", "media"), { recursive: true });
  writeFileSync(join(w, "site", "media", "clip.mp4"), Buffer.alloc(64 * 1024, 7));
  writeFileSync(join(w, "site", "media", "track.mp3"), Buffer.alloc(1024, 1));
  writeFileSync(join(w, "site", "media", "logo.png"), Buffer.alloc(1024, 2)); // raster: out
  writeFileSync(join(w, "site", "media", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>\n"); // text: in
  writeFileSync(join(w, "bundle.zip"), Buffer.alloc(1024, 3));
  writeFileSync(join(w, "tool.exe"), Buffer.alloc(1024, 4));
  writeFileSync(join(w, "addon.node"), Buffer.alloc(1024, 5));
  writeFileSync(join(w, "debug.log"), "noise\n");
  writeFileSync(join(w, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(w, "README.md"), "# readme\n");
  writeFileSync(join(w, "big.json"), JSON.stringify({ rows: Array.from({ length: 20_000 }, (_, i) => ({ i, s: "x".repeat(20) })) })); // ~1 MB of text: still in

  const cp = await Checkpoints.init({ workspace: w, sessionId: "s1" });
  const c1 = await cp.snapshot("write");
  const tracked = execFileSync("git", ["--git-dir", cp.gitDir, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  expect(tracked).toContain("a.ts");
  expect(tracked).toContain("README.md");
  expect(tracked).toContain("big.json");
  expect(tracked).toContain("site/media/logo.svg");
  for (const gone of ["site/media/clip.mp4", "site/media/track.mp3", "site/media/logo.png", "bundle.zip", "tool.exe", "addon.node", "debug.log"]) expect(tracked).not.toContain(gone);

  // an excluded file is outside the checkpoint's world: a files restore neither reverts nor deletes it
  writeFileSync(join(w, "site", "media", "clip.mp4"), Buffer.alloc(8, 9));
  writeFileSync(join(w, "a.ts"), "export const a = 2;\n");
  const r = await cp.restore(c1.hash, "files");
  expect(r.ok).toBe(true);
  expect(readFileSync(join(w, "a.ts"), "utf8")).toBe("export const a = 1;\n");   // restored
  expect(readFileSync(join(w, "site", "media", "clip.mp4")).length).toBe(8);     // untouched
  expect(existsSync(join(w, "tool.exe"))).toBe(true);
  rmSync(w, { recursive: true, force: true });
}, 30_000);
